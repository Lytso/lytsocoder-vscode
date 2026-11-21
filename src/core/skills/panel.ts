// Port of ui/settings/AgentSkillsPanel.kt: the skills of one agent's own skills folder, the same page for every
// agent (only the folder differs; the bridge knows it). Add skills from a GitHub repository (find → pick → add,
// replacing skills of the same name), update the ones that came from GitHub, remove any. A repository it can't take
// offers "Set up with AI" (setupWithAi.ts). Each agent's settings provider owns one panel and routes its page to it.
import type { AgentKind } from '../../../shared/model';
import type { SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import { Cached, errText } from '../agy/settingsKit';
import { AgentSkillsClient, type AgentSkill, type RepoInspect } from './client';
import { setupWithAiItem } from './setupWithAi';

export interface SkillsPanelHooks {
  /** Show the settings pages again (state changed). */
  changed(): void;
  /** The agent's skills changed here: its "/" menu reads them again (the app's AgentSkillsClient.changes). */
  skillsChanged(): void;
}

/** What the plugin formats a repository holds mean for `agent`, when it has no skills to add. */
export function pluginHint(agent: AgentKind, kinds: string[]): string | null {
  if (!kinds.length) return null;
  switch (agent) {
    case 'CLAUDE':
      return kinds.includes('claude-marketplace') ? 'This repository is a Claude Code plugin marketplace: add it in Plugins → Marketplaces.' : null;
    case 'CODEX':
      return kinds.includes('codex-plugin') || kinds.includes('claude-marketplace') ? 'This repository is a plugin marketplace: add it in Plugins → Marketplaces.' : null;
    case 'AGY':
      return kinds.includes('agy-plugin') || kinds.includes('claude-plugin') || kinds.includes('claude-marketplace')
        ? 'This repository is a plugin: install it from Skills & Plugins (Install a plugin from GitHub).'
        : null;
    default:
      return null;
  }
}

/** A typo in the link is fixed by hand; anything else (private repository, GitHub limits…) an agent may manage. */
const fixableByHand = (why: string) => why.startsWith('Use owner/repo') || why.startsWith('Invalid');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Item ids of the panel (prefixed: the agent's own pages use plain ids). */
const ID = {
  find: 'skills.find',
  pick: 'skills.pick',
  install: 'skills.install',
  selectAll: 'skills.selectAll',
  cancel: 'skills.cancel',
  list: 'skills.list',
  refresh: 'skills.refresh',
} as const;

export class AgentSkillsPanel {
  private list: Cached<{ dir: string; skills: AgentSkill[] }>;
  /** skill id → 'update' | 'remove' while it runs */
  private busy = new Map<string, 'update' | 'remove'>();
  private source = '';
  private inspecting = false;
  private found: RepoInspect | null = null;
  private findError: string | null = null;
  private picked = new Set<string>();
  /** Adding the picked skills failed: the "Set up with AI" button for that repository. */
  private aiSetup: { source: string; why: string | null } | null = null;

  constructor(
    readonly agent: AgentKind,
    /** The page this panel is drawn on ('claude.skills'…). */
    readonly pageId: string,
    private client: AgentSkillsClient,
    private hooks: SkillsPanelHooks,
  ) {
    this.list = new Cached(
      () => this.client.list(this.agent),
      () => this.hooks.changed(),
      3_000,
    );
  }

  /** The page (waits a little for the folder's list; a slow read shows what it has and updates later). */
  async page(title = 'Skills'): Promise<SettingsPage> {
    const done = await this.list.ensure(6_000);
    return { id: this.pageId, title, sections: [this.addSection(), this.listSection(!done)], loading: !done || this.inspecting || undefined };
  }

  // ------------------------------------------------------------------ page

  private addSection(): SettingsSection {
    const items: SettingItem[] = [
      {
        kind: 'button',
        id: ID.find,
        label: 'Find skills',
        style: this.found ? 'default' : 'primary',
        disabled: this.inspecting,
        form: [{ id: 'source', label: 'GitHub repository', kind: 'text', value: this.source, placeholder: 'owner/repo or github.com link', required: true }],
      },
    ];
    if (this.inspecting) items.push({ kind: 'info', id: 'skills.inspecting', label: 'Looking for skills in the repository…', value: '', tone: 'muted' });
    if (this.findError) items.push({ kind: 'info', id: 'skills.findError', label: 'Could not read the repository', value: '', description: this.findError, tone: 'error' });
    const res = this.found;
    if (res && !res.skills.length) {
      items.push({
        kind: 'info',
        id: 'skills.none',
        label: `No skills found in ${res.repo}${res.subpath ? `/${res.subpath}` : ''} (no folder with a SKILL.md).`,
        value: '',
        description: pluginHint(this.agent, res.plugin_kinds),
      });
    } else if (res) {
      const count = res.skills.filter((s) => this.picked.has(s.path)).length;
      items.push({
        kind: 'checklist',
        id: ID.pick,
        label: `${plural(res.skills.length, 'skill')} in ${res.repo}`,
        values: res.skills.filter((s) => this.picked.has(s.path)).map((s) => s.path),
        options: res.skills.map((s) => {
          const where = (s.path || '(the whole repository)') + (s.id !== s.path.split('/').pop() ? `  →  ${s.id}` : '');
          const note = s.same_source
            ? 'Already added: adding it again updates it'
            : s.exists
              ? `A different skill named ${s.id} is installed and will be replaced`
              : null;
          const desc = s.description.trim();
          return { value: s.path, label: s.name, description: [desc.length > 220 ? `${desc.slice(0, 220)}…` : desc, where, note].filter(Boolean).join(' · ') };
        }),
      });
      items.push({ kind: 'button', id: ID.install, label: count === 1 ? 'Add 1 skill' : `Add ${count} skills`, style: 'primary', disabled: count === 0 });
      if (res.skills.length > 1) items.push({ kind: 'button', id: ID.selectAll, label: count < res.skills.length ? 'Select all' : 'Select none' });
    }
    if (res || this.findError) items.push({ kind: 'button', id: ID.cancel, label: 'Cancel' });
    // "Set up with AI" under a read error and a repository without skills (stressed where the app opens it by itself:
    // not a typo in the link, no plugin this agent's Plugins page can take), and after a failed add
    const noSkills = 'it has no skills (no folder with a SKILL.md)';
    if (this.findError) items.push(setupWithAiItem(this.agent, this.source, this.findError, !fixableByHand(this.findError)));
    else if (res && !res.skills.length) items.push(setupWithAiItem(this.agent, this.source, noSkills, !pluginHint(this.agent, res.plugin_kinds)));
    else if (this.aiSetup) items.push(setupWithAiItem(this.agent, this.aiSetup.source, this.aiSetup.why, true));
    return {
      id: 'skills-add',
      title: 'Add skills from GitHub',
      agent: this.agent,
      description: 'A GitHub repository (owner/repo), or a link to a folder in one. Every folder with a SKILL.md in it is a skill; you pick which ones to add.',
      items,
    };
  }

  private row(s: AgentSkill): SettingListRow {
    const op = this.busy.get(s.id);
    const src = s.source;
    const from = src ? `github.com/${src.repo}${src.path ? ` · ${src.path}` : ''}${src.ref ? ` @${src.ref}` : ''}` : 'Added by hand';
    // the app shows two lines of it
    const full = s.description.trim().split('\n').filter(Boolean).slice(0, 2).join(' ');
    const desc = full.length > 160 ? `${full.slice(0, 160).trimEnd()}…` : full;
    return {
      id: s.id,
      title: s.name || s.id,
      subtitle: [desc || null, from].filter(Boolean).join('\n'),
      status: op ? (op === 'update' ? 'Updating…' : 'Removing…') : s.kind === 'plugin' ? 'Plugin' : null,
      statusTone: op ? 'warn' : 'muted',
      actions: op
        ? []
        : [
            ...(src ? [{ id: 'update', label: 'Update from GitHub' }] : []),
            {
              id: 'remove',
              label: 'Remove',
              danger: true,
              confirm: `Remove ${s.name || s.id}? This deletes the folder ${s.path}${src ? '.' : ". It was not added from GitHub, so it can't be downloaded again."}`,
            },
          ],
    };
  }

  private listSection(loading: boolean): SettingsSection {
    const v = this.list.value;
    const items: SettingItem[] = [];
    if (this.list.error) items.push({ kind: 'info', id: 'skills.loadError', label: 'Could not list the skills', value: '', description: this.list.error, tone: 'error' });
    items.push(
      {
        kind: 'list',
        id: ID.list,
        label: 'Your skills',
        description: v?.dir || null,
        rows: (v?.skills ?? []).map((s) => this.row(s)),
        emptyText: !v && (loading || this.list.loading) ? 'Loading…' : 'No skills here yet. Add some from GitHub above.',
      },
      { kind: 'button', id: ID.refresh, label: 'Refresh' },
    );
    return {
      id: 'skills-list',
      title: '',
      agent: this.agent,
      description: 'The agent reads its skills when a chat starts: start a new chat after adding, updating or removing one.',
      items,
    };
  }

  // ------------------------------------------------------------------ edits

  /** The picked skills (checklist). True when it was this panel's. */
  change(id: string, value: unknown): boolean {
    if (id !== ID.pick) return false;
    this.picked = new Set(Array.isArray(value) ? value.map(String) : []);
    return true;
  }

  async action(id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    switch (id) {
      case ID.find:
        return this.find((values?.source ?? '').trim());
      case ID.cancel:
        this.found = null;
        this.findError = null;
        this.aiSetup = null;
        this.hooks.changed();
        return;
      case ID.selectAll: {
        const all = this.found?.skills ?? [];
        const every = all.every((s) => this.picked.has(s.path));
        this.picked = every ? new Set() : new Set(all.map((s) => s.path));
        this.hooks.changed();
        return;
      }
      case ID.install:
        return this.install();
      case ID.refresh:
        await this.list.reload();
        this.hooks.changed();
        if (this.list.error) throw new Error(this.list.error);
        return;
      case ID.list:
        if (rowId && actionId === 'update') return this.rowOp(rowId, 'update');
        if (rowId && actionId === 'remove') return this.rowOp(rowId, 'remove');
        return;
    }
  }

  private async find(source: string): Promise<string | void> {
    if (!source || this.inspecting) return;
    this.source = source;
    this.inspecting = true;
    this.found = null;
    this.findError = null;
    this.aiSetup = null;
    this.hooks.changed();
    try {
      const res = await this.client.inspect(this.agent, source);
      this.found = res;
      this.picked = new Set(res.skills.map((s) => s.path));
    } catch (e) {
      this.findError = errText(e) || 'Could not read the repository';
    } finally {
      this.inspecting = false;
      this.hooks.changed();
    }
  }

  private async install(): Promise<string> {
    const res = this.found;
    if (!res) throw new Error('Find the skills first');
    const paths = res.skills.filter((s) => this.picked.has(s.path)).map((s) => s.path);
    if (!paths.length) throw new Error('Pick the skills to add');
    try {
      const r = await this.client.install(this.agent, this.source, paths, true);
      this.found = null;
      this.aiSetup = null;
      this.source = '';
      await this.list.reload();
      this.hooks.skillsChanged();
      this.hooks.changed();
      return `Added ${plural(r.installed.length, 'skill')}${r.replaced.length ? ` (${r.replaced.length} replaced)` : ''}. Start a new chat to use them.`;
    } catch (e) {
      this.aiSetup = { source: this.source, why: errText(e) || 'adding the skills failed' };
      this.hooks.changed();
      throw e;
    }
  }

  private async rowOp(id: string, op: 'update' | 'remove'): Promise<string> {
    const s = this.list.value?.skills.find((x) => x.id === id);
    const name = s?.name || id;
    if (this.busy.has(id)) throw new Error(`${name} is busy`);
    this.busy.set(id, op);
    this.hooks.changed();
    try {
      if (op === 'update') await this.client.update(this.agent, id);
      else await this.client.remove(this.agent, id);
      this.hooks.skillsChanged();
      return op === 'update' ? `${name} updated. Start a new chat to use it.` : `${name} removed`;
    } catch (e) {
      throw new Error(errText(e) || `Could not ${op} ${name}`);
    } finally {
      this.busy.delete(id);
      await this.list.reload();
      this.hooks.changed();
    }
  }
}
