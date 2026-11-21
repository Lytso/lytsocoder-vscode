// Settings → Agents → Agent memory & history (port of the app's AgentMemoryScreen.kt and AgentHistoryScreen.kt):
// the switches, the memories the bridge keeps (search, add, edit, delete) and the saved chats (read, remove, remove
// all). Host-owned pages 'memory' and 'memory.history', drawn by the view's settings UI. A saved chat opens in an
// editor tab: VS Code reads a long chat better than a dialog can.
import type { AgentKind } from '../../../shared/model';
import type { SettingFormField, SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import { AGENT_NAMES } from '../notifications';
import { expandHome, uriToPath } from '../paths';
import type { HistoryChat, HistoryHit, Memory } from './client';
import type { AgentMemory } from './memory';
import { MAX_LIST_LIMIT, MEMORY_AGENTS } from './types';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nameOf = (m: Memory) => m.file.replace(/\.md$/, '');
/** The project's folder name ("" for a global memory). */
const projectName = (p: string, dir = '') => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir.replace(/-[^-]*$/, '');

/** "Claude Code" for "claude", "Antigravity" for "agy", …; the raw name for anything else. */
function agentLabel(agent: string): string {
  const k = MEMORY_AGENTS.find((a) => a.toLowerCase() === agent.toLowerCase());
  return k ? AGENT_NAMES[k] : agent;
}

function savedBy(agent: string): string | null {
  if (!agent.trim()) return null;
  return agent.toLowerCase() === 'user' ? 'Added by you' : `Saved by ${agentLabel(agent)}`;
}

/** "18 Nov 2026", or null when the bridge sent no time. */
function day(ms: number): string | null {
  return ms > 0 ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
}

/** "840 B", "12 KB", "1.4 MB"; null when the bridge sent no size. */
function size(bytes: number): string | null {
  if (bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export class MemorySettings {
  /** The memory page's search (empty = the list). */
  private query = '';

  constructor(private m: AgentMemory) {}

  /** The row on Settings → Agents. */
  rootItem(): SettingItem {
    return {
      kind: 'page',
      id: 'memory',
      label: 'Agent memory & history',
      icon: 'memory',
      description: 'Memories and past chats every agent can use',
      badge: this.m.enabled() ? 'On' : 'Off',
    };
  }

  async page(id: string): Promise<SettingsPage> {
    return id === 'memory.history' ? this.historyPage() : this.memoryPage();
  }

  // ------------------------------------------------------------------ Agent memory & history

  private async memoryPage(): Promise<SettingsPage> {
    const m = this.m;
    const on = m.enabled();
    const sections: SettingsSection[] = [
      {
        id: 'memory',
        title: '',
        items: [
          {
            kind: 'toggle',
            id: 'memory.enabled',
            label: 'Agent memory',
            description:
              'Shared by every agent. Agents save short memories in their replies; the chat shows a chip you can undo. A new chat is told the ' +
              'Always memories and the most relevant others, and the agents can look up past chats.',
            value: on,
          },
        ],
      },
    ];
    if (on) {
      sections.push({
        id: 'memory.use',
        title: 'Use with',
        description: 'A weak model may not follow the memory rules. Turn it off for that agent.',
        items: [{ kind: 'checklist', id: 'memory.agents', label: '', values: m.agents(), options: MEMORY_AGENTS.map((a) => ({ value: a, label: AGENT_NAMES[a] })) }],
      });
      sections.push({
        id: 'memory.options',
        title: '',
        items: [
          {
            kind: 'select',
            id: 'memory.listLimit',
            label: 'Memories listed per chat',
            description: 'Memories set to Always are always included in full and do not count.',
            value: String(m.listLimit()),
            options: Array.from({ length: MAX_LIST_LIMIT + 1 }, (_, i) => ({ value: String(i), label: String(i) })),
          },
          {
            kind: 'toggle',
            id: 'memory.saveHistory',
            label: 'Save chat history',
            description: 'A cleaned copy of every chat (your messages and the replies, no tool output) the agents can read when you refer to earlier work.',
            value: m.saveHistory(),
          },
          { kind: 'page', id: 'memory.history', label: 'Saved chats', icon: 'history', description: 'Read or remove the chat history the agents can look up' },
        ],
      });
    }

    const items: SettingItem[] = [
      { kind: 'button', id: 'memory.add', label: 'Add memory', style: 'primary', form: this.form(null) },
      {
        kind: 'button',
        id: 'memory.search',
        label: this.query ? `Search: “${this.query}”` : 'Search',
        description: 'Search memories and past chats',
        form: [{ id: 'q', label: 'Search memories and past chats', kind: 'text', value: this.query, required: true }],
      },
    ];
    const head: SettingsSection = {
      id: 'memory.list',
      title: 'Memories',
      description: on ? 'Edit or delete one from its menu' : 'Kept while memory is off; agents do not get them',
      items,
    };
    sections.push(head);

    if (this.query) {
      items.push({ kind: 'button', id: 'memory.clearSearch', label: 'Clear search' });
      try {
        const r = await m.client.search(this.query);
        // no memory, no history: past chats only show while memory is on
        const chats = on ? r.history : [];
        if (!r.memories.length && !chats.length) items.push({ kind: 'info', id: 'memory.none', label: 'Nothing found.', value: '', tone: 'muted' });
        if (r.memories.length) items.push({ kind: 'list', id: 'memory.found', label: 'Memories', rows: r.memories.map((x) => this.memoryRow(x)) });
        if (chats.length)
          items.push({ kind: 'list', id: 'memory.chats', label: 'Past chats', description: 'Open Saved chats to remove them', rows: chats.map((h) => this.hitRow(h)) });
      } catch (e) {
        items.push({ kind: 'info', id: 'memory.error', label: 'Search failed', value: errText(e), tone: 'error' });
      }
      return { id: 'memory', title: 'Agent memory & history', sections };
    }

    let root = '';
    let list: Memory[] = [];
    try {
      ({ root, memories: list } = await m.client.list());
    } catch (e) {
      items.push({ kind: 'info', id: 'memory.error', label: 'Could not reach the bridge', value: errText(e), tone: 'error' });
      items.push({ kind: 'button', id: 'memory.retry', label: 'Try again' });
      return { id: 'memory', title: 'Agent memory & history', sections };
    }
    if (!list.length) items.push({ kind: 'info', id: 'memory.none', label: 'No memories yet. Agents save them as you chat, or add one.', value: '', tone: 'muted' });

    const newest = (a: Memory, b: Memory) => b.updated - a.updated;
    const always = list.filter((x) => x.mode === 'always').sort(newest);
    const global = list.filter((x) => x.mode !== 'always' && x.scope !== 'project').sort(newest);
    const byProject = new Map<string, Memory[]>();
    for (const x of list.filter((y) => y.mode !== 'always' && y.scope === 'project')) {
      const k = x.project_dir || x.project;
      byProject.set(k, [...(byProject.get(k) ?? []), x]);
    }
    if (always.length) items.push({ kind: 'list', id: 'memory.list.always', label: 'Always', description: 'Every chat gets these in full', rows: always.map((x) => this.memoryRow(x)) });
    if (global.length) items.push({ kind: 'list', id: 'memory.list.global', label: 'Global', description: 'Listed in any project when relevant', rows: global.map((x) => this.memoryRow(x)) });
    [...byProject.values()]
      .map((g) => g.sort(newest))
      .sort((a, b) => projectName(a[0].project, a[0].project_dir).toLowerCase().localeCompare(projectName(b[0].project, b[0].project_dir).toLowerCase()))
      .forEach((g, i) =>
        items.push({
          kind: 'list',
          id: `memory.list.project.${i}`,
          label: `Project: ${projectName(g[0].project, g[0].project_dir) || 'unknown'}`,
          description: g[0].project || null,
          rows: g.map((x) => this.memoryRow(x)),
        }),
      );
    if (root) items.push({ kind: 'info', id: 'memory.root', label: 'Stored by the bridge in', value: root, tone: 'muted' });
    return { id: 'memory', title: 'Agent memory & history', sections };
  }

  private memoryRow(x: Memory): SettingListRow {
    const name = nameOf(x) || 'Untitled';
    const where = x.scope === 'project' ? projectName(x.project, x.project_dir) || 'One project' : 'All projects';
    return {
      id: x.id,
      title: name,
      subtitle: [x.description.trim(), where, day(x.updated), savedBy(x.agent)].filter(Boolean).join('  ·  '),
      status: x.mode === 'always' ? 'Always' : 'Passive',
      statusTone: x.mode === 'always' ? 'ok' : 'muted',
      actions: [
        { id: 'edit', label: 'Edit', form: this.form(x) },
        { id: 'delete', label: 'Delete', danger: true, confirm: `Delete “${name}”? Agents will no longer get it. Chats that already got it keep what they were told.` },
      ],
    };
  }

  private hitRow(h: HistoryHit): SettingListRow {
    return {
      id: h.chat_id,
      title: h.title || 'Untitled chat',
      subtitle: [agentLabel(h.agent), projectName(h.project), day(h.updated), h.snippet.trim()].filter(Boolean).join('  ·  '),
      actions: [{ id: 'open', label: 'Open' }],
    };
  }

  /** The add / edit form (MemoryEditor). */
  private form(x: Memory | null): SettingFormField[] {
    return [
      { id: 'name', label: 'Name', kind: 'text', value: x ? nameOf(x) : '', placeholder: 'short-name', required: true },
      { id: 'description', label: 'Description', kind: 'text', value: x?.description ?? '', placeholder: 'One line: what it is about' },
      { id: 'text', label: 'What the agents should remember', kind: 'multiline', value: x?.text ?? '', required: true },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'select',
        value: x?.mode === 'always' ? 'always' : 'passive',
        options: [
          { value: 'always', label: 'Always: every chat gets it in full' },
          { value: 'passive', label: 'Passive: listed when relevant' },
        ],
      },
      {
        id: 'scope',
        label: 'Scope',
        kind: 'select',
        value: x?.scope === 'project' ? 'project' : 'global',
        options: [
          { value: 'global', label: 'All projects' },
          { value: 'project', label: 'One project' },
        ],
      },
      {
        id: 'project',
        label: 'Project folder',
        kind: 'text',
        value: x ? x.project : (this.m.api?.workspaceFolder() ?? ''),
        placeholder: '/path/to/project',
        required: true,
        showWhen: { field: 'scope', values: ['project'] },
      },
    ];
  }

  private async saveMemory(id: string | null, v: Record<string, string>) {
    const name = (v.name ?? '').trim();
    const text = (v.text ?? '').trim();
    if (!name) throw new Error('Enter a name');
    if (!text) throw new Error('Enter what the agents should remember');
    const one = v.scope === 'project';
    const project = one ? expandHome(uriToPath((v.project ?? '').trim())) : null;
    if (one && !project) throw new Error('Enter the project folder');
    await this.m.client.save({
      id,
      file: name,
      scope: one ? 'project' : 'global',
      project,
      mode: v.mode === 'always' ? 'always' : 'passive',
      description: (v.description ?? '').trim(),
      text,
    });
    this.m.changed();
  }

  // ------------------------------------------------------------------ Saved chats

  private async historyPage(): Promise<SettingsPage> {
    const title = 'Saved chats';
    const intro: SettingItem[] = [];
    if (!this.m.saveHistory())
      intro.push({ kind: 'info', id: 'history.off', label: 'Chat history is off', value: 'New messages are not saved. Turn it on in Agent memory & history.', tone: 'warn' });
    const sections: SettingsSection[] = [
      {
        id: 'history.about',
        title: '',
        description:
          'Chats saved for the agents to look up: your messages and the replies, no tool output. Open one to read it, or remove it. ' +
          'A removed chat is not saved again (new chats are). The chats themselves stay.',
        items: intro,
      },
    ];
    let chats: HistoryChat[];
    try {
      chats = await this.m.client.historyList();
    } catch (e) {
      sections.push({
        id: 'history.error',
        title: '',
        items: [
          { kind: 'info', id: 'history.error', label: 'Could not reach the bridge', value: errText(e), tone: 'error' },
          { kind: 'button', id: 'history.retry', label: 'Try again' },
        ],
      });
      return { id: 'memory.history', title, sections };
    }
    const items: SettingItem[] = [];
    sections.push({ id: 'history.chats', title: chats.length ? plural(chats.length, 'saved chat') : '', items });
    if (!chats.length) {
      items.push({ kind: 'info', id: 'history.none', label: 'No saved chats yet.', value: '', tone: 'muted' });
      return { id: 'memory.history', title, sections };
    }
    const row = (c: HistoryChat, withProject = false): SettingListRow => ({
      id: c.chat_id,
      title: c.title || 'Untitled chat',
      subtitle: [agentLabel(c.agent), withProject ? projectName(c.project) || 'No project folder' : null, day(c.updated), size(c.size)].filter(Boolean).join('  ·  '),
      status: c.edited ? 'Edited' : null,
      statusTone: 'warn',
      actions: [
        { id: 'open', label: 'Open' },
        { id: 'remove', label: 'Remove', danger: true, confirm: 'Remove this saved chat? The agents can no longer look it up, and this chat is not saved again. The chat itself stays.' },
      ],
    });
    // find one by its title
    items.push({ kind: 'list', id: 'history.find', label: 'Find a saved chat', searchTitle: 'Saved chats', display: 'search', rows: chats.map((c) => row(c, true)) });
    // one group per project folder, the group with the newest chat first
    const groups = new Map<string, HistoryChat[]>();
    for (const c of chats) groups.set(c.project.trim(), [...(groups.get(c.project.trim()) ?? []), c]);
    [...groups.values()]
      .map((g) => g.sort((a, b) => b.updated - a.updated))
      .sort((a, b) => b[0].updated - a[0].updated)
      .forEach((g, i) => {
        const p = g[0].project.trim();
        items.push({ kind: 'list', id: `history.group.${i}`, label: p ? projectName(p) || p : 'No project folder', description: p || null, rows: g.map((c) => row(c)) });
      });
    items.push({
      kind: 'button',
      id: 'history.clear',
      label: 'Remove all saved chats',
      style: 'danger',
      confirm: `${chats.length === 1 ? 'Remove 1 saved chat?' : `Remove all ${chats.length} saved chats?`} They are not saved again; new chats are. The chats themselves stay.`,
    });
    return { id: 'memory.history', title, sections };
  }

  /** Opens a saved chat in an editor tab. */
  private async openChat(chatId: string) {
    const r = await this.m.client.historyGet(chatId);
    this.m.api?.openText(r.chat?.title || 'Saved chat', r.text, 'markdown');
  }

  // ------------------------------------------------------------------ edits

  async change(_page: string, id: string, value: unknown): Promise<void> {
    const m = this.m;
    if (id === 'memory.enabled') m.setEnabled(value === true);
    else if (id === 'memory.agents' && Array.isArray(value)) m.setAgents(value as AgentKind[]);
    else if (id === 'memory.listLimit') m.setListLimit(Number(value));
    else if (id === 'memory.saveHistory') m.setSaveHistory(value === true);
  }

  async action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    const m = this.m;
    if (id === 'memory.add' && values) return this.saveMemory(null, values);
    if (id === 'memory.search') {
      this.query = (values?.q ?? '').trim();
      return;
    }
    if (id === 'memory.clearSearch') {
      this.query = '';
      return;
    }
    if (id === 'memory.retry' || id === 'history.retry') return;
    if ((id === 'memory.found' || id.startsWith('memory.list.')) && rowId) {
      if (actionId === 'edit' && values) return this.saveMemory(rowId, values);
      if (actionId === 'delete') {
        await m.client.delete(rowId);
        m.changed();
      }
      return;
    }
    if (id === 'history.clear') {
      const n = await m.client.historyClear();
      m.changed();
      return n ? `Removed ${plural(n, 'saved chat')}` : undefined;
    }
    if ((id === 'memory.chats' || id === 'history.find' || id.startsWith('history.group.')) && rowId) {
      if (actionId === 'open') return this.openChat(rowId);
      if (actionId === 'remove') {
        await m.client.deleteHistory(rowId);
        m.changed();
      }
      return;
    }
    void page;
  }
}
