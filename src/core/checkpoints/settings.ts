// Settings → Project checkpoints (port of the app's ui/checkpoint/ProjectCheckpointsScreen.kt): off / chosen projects /
// all git projects, how long checkpoints are kept, and every project's checkpoints (space used, on / off, clean up,
// delete, forget) with a History page per project whose rows open the restore sheet. Host-owned pages 'checkpoints'
// and 'checkpoints.history:<path>' drawn by the view's settings UI.
import type { HostToView, SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import { baseName, tildePath } from '../paths';
import { type CheckpointProjectInfo, type CheckpointSettings, type CheckpointSummary, MODE_ALL, MODE_OFF, MODE_SELECTED, type ProjectCheckpoints } from './client';

export const PAGE = 'checkpoints';
const HISTORY = 'checkpoints.history:';

export const isCheckpointPage = (page: string) => page === PAGE || page.startsWith(`${PAGE}.`);

const MODE_BADGE: Record<string, string> = { [MODE_OFF]: 'Off', [MODE_SELECTED]: 'Chosen projects', [MODE_ALL]: 'All projects' };

const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', agy: 'Antigravity', codex: 'Codex', opencode: 'OpenCode' };
export const agentLabelOf = (a: string | null | undefined) => (a ? (AGENT_LABEL[a.toLowerCase()] ?? null) : null);

/** "just now", "5 min ago", "3 h ago", else the date (formatCheckpointTime). */
export function formatCheckpointTime(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 24 * 3_600_000) return `${Math.floor(d / 3_600_000)} h ago`;
  const t = new Date(ms);
  return `${t.toLocaleString('en-US', { month: 'short' })} ${t.getDate()}, ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

export function formatBytes(b: number): string {
  if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(1)} GB`;
  if (b >= 2 ** 20) return `${(b / 2 ** 20).toFixed(1)} MB`;
  if (b >= 2 ** 10) return `${Math.floor(b / 2 ** 10)} KB`;
  return `${b} B`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class CheckpointSettingsPages {
  constructor(
    private cp: ProjectCheckpoints,
    /** Re-sends the open pages (the root's row once the settings are read). */
    private refresh: () => void,
  ) {}

  /** The row on the settings root (SettingsDialog's PROJECT_CHECKPOINTS row: off / chosen projects / all projects). */
  rootItem(): SettingItem {
    const mode = this.cp.settings?.mode;
    // read once in the background: the root never waits on the bridge
    if (!this.cp.settings) void this.cp.knownSettings().then((s) => s && this.refresh());
    return {
      kind: 'page',
      id: PAGE,
      label: 'Project checkpoints',
      icon: 'history',
      description: 'Go back to before any chat message: files restored with a preview',
      badge: mode ? (MODE_BADGE[mode] ?? null) : null,
    };
  }

  async page(id: string): Promise<SettingsPage> {
    if (id.startsWith(HISTORY)) return this.historyPage(id.slice(HISTORY.length));
    // the project list comes with the settings
    const list = await this.cp.projects();
    const s = this.cp.settings ?? (await this.cp.refreshSettings());
    const mode = s.mode;
    const sections: SettingsSection[] = [
      {
        id: 'mode',
        title: 'Checkpoints',
        description:
          'Before every message you send (Claude Code, Codex, OpenCode or Antigravity), AntiGem saves a hidden copy of the project\'s files. ' +
          'Each message then gets a restore point: go back to before it, with a preview of every file that changes. Your own git history, ' +
          'branches, staging and stashes are never touched.',
        items: [
          {
            kind: 'select',
            id: 'checkpoints.mode',
            label: 'Save checkpoints',
            description: 'Checkpoints work in git projects only (a folder with git init done). Nested repositories inside a project are saved too.',
            value: mode,
            options: [
              { value: MODE_OFF, label: 'Off', description: 'No checkpoints are made (the default)' },
              { value: MODE_SELECTED, label: 'Projects I choose', description: 'A new chat in a project asks once whether to keep checkpoints for it' },
              { value: MODE_ALL, label: 'All git projects', description: 'Every git project gets checkpoints (turn single projects off below)' },
            ],
          },
        ],
      },
      this.keepSection(s),
      {
        id: 'projects',
        title: '',
        items: [
          {
            kind: 'list',
            id: 'checkpoints.projects',
            label: 'Projects',
            rows: list.map((p) => this.projectRow(p, mode)),
            emptyText:
              mode === MODE_OFF ? 'Turn checkpoints on above, then start a chat in a project.' : 'No project has checkpoints yet. They appear here after the first message in a project.',
          },
        ],
      },
      {
        id: 'notes',
        title: 'Good to know',
        items: [
          'Only files inside the project go back. Packages the agent installed, files outside the project, servers it started or things it sent are not undone.',
          'Files your .gitignore ignores (and node_modules, .gradle, caches) are not saved and never changed by a restore.',
          'A restore first saves the files as they are, so “Undo restore” always works.',
          'Going back in a chat (Edit) only changes the chat. Files go back only through a restore point (or the agent\'s own file restore when you tick it).',
          'The copies live with the bridge (~/.antigem_bridge/checkpoints), on the machine where the project is.',
        ].map((t, i) => ({ kind: 'info' as const, id: `checkpoints.note.${i}`, label: t, value: '' })),
      },
    ];
    return { id: PAGE, title: 'Project checkpoints', sections };
  }

  private keepSection(s: CheckpointSettings): SettingsSection {
    const sel = (id: string, label: string, value: number, options: [number, string][]): SettingItem => ({
      kind: 'select',
      id,
      label,
      value: String(value),
      options: options.map(([v, l]) => ({ value: String(v), label: l })),
    });
    return {
      id: 'keep',
      title: 'Keep',
      description:
        'Old checkpoints are removed automatically (the oldest first when a project uses too much space). Deleting old ones never breaks newer ones: each checkpoint is complete on its own.',
      items: [
        sel('checkpoints.retention_days', 'Delete checkpoints older than', s.retention_days, [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'Never']]),
        sel('checkpoints.max_per_chat', 'At most per chat', s.max_per_chat, [[50, '50'], [100, '100'], [200, '200'], [0, 'No limit']]),
        sel('checkpoints.max_project_mb', 'Space per project', s.max_project_mb, [[200, '200 MB'], [500, '500 MB'], [1024, '1 GB'], [2048, '2 GB'], [0, 'No limit']]),
        sel('checkpoints.max_file_mb', 'Skip files larger than', s.max_file_mb, [[5, '5 MB'], [20, '20 MB'], [50, '50 MB'], [100, '100 MB']]),
      ],
    };
  }

  /** ProjectCard: name, status, switch, space used; History / Clean old / Delete all. */
  private projectRow(p: CheckpointProjectInfo, mode: string): SettingListRow {
    const [status, tone]: [string, SettingListRow['statusTone']] = p.tracked
      ? ['Saving checkpoints', 'ok']
      : !p.exists
        ? ['Folder not found', 'error']
        : mode === MODE_OFF
          ? ['Checkpoints are off', 'muted']
          : !p.is_git
            ? ['Not a git repository', 'warn']
            : ['Off for this project', 'muted'];
    const on = mode === MODE_ALL ? p.decision !== 'off' : p.decision === 'on';
    const data = p.has_data ? `${plural(p.count, 'checkpoint')} · ${formatBytes(p.size_bytes)}${p.last_time ? ` · ${formatCheckpointTime(p.last_time)}` : ''}` : '';
    const gitHint = !p.is_git && p.exists && mode !== MODE_OFF ? 'Run git init in this folder to start checkpoints.' : '';
    const name = baseName(p.path) || p.path;
    const actions: NonNullable<SettingListRow['actions']> = [];
    if (p.has_data) {
      actions.push(
        { id: 'history', label: 'History' },
        {
          id: 'clean',
          label: 'Clean old',
          form: [
            {
              id: 'days',
              label: `Delete the checkpoints of ${name} older than:`,
              kind: 'select',
              value: '7',
              options: [
                { value: '1', label: '1 day' },
                { value: '3', label: '3 days' },
                { value: '7', label: '7 days' },
                { value: '30', label: '30 days' },
              ],
            },
          ],
        },
        {
          id: 'deleteAll',
          label: 'Delete all',
          danger: true,
          confirm:
            `Every checkpoint of ${name} is deleted (${formatBytes(p.size_bytes)} freed). The project's own files and git are not touched. ` +
            'New checkpoints start again with the next message when the project is still on.',
        },
      );
    }
    if (p.has_data || p.decision) {
      actions.push({
        id: 'forget',
        label: 'Forget this project',
        danger: true,
        confirm: `Every checkpoint of ${name} is deleted and your answer for it is forgotten: a new chat there asks again.`,
      });
    }
    return {
      id: p.path,
      title: name,
      subtitle: [tildePath(p.path), data, gitHint].filter(Boolean).join(' · '),
      status,
      statusTone: tone,
      toggle: mode !== MODE_OFF && p.exists ? on : null,
      actions,
    };
  }

  /** One project's checkpoints, newest first (CheckpointHistory): Restore opens the restore sheet (files only). */
  private async historyPage(project: string): Promise<SettingsPage> {
    const [items, list] = await Promise.all([this.cp.history(project), this.cp.projects().catch(() => [] as CheckpointProjectInfo[])]);
    const info = list.find((p) => p.path === project);
    const name = baseName(project) || project;
    return {
      id: `${HISTORY}${project}`,
      title: name,
      sections: [
        {
          id: 'actions',
          title: '',
          description: `${plural(items.length, 'checkpoint')}${info ? ` · ${formatBytes(info.size_bytes)}` : ''} · ${tildePath(project)}`,
          items: items.length
            ? [
                {
                  kind: 'button',
                  id: 'checkpoints.clean',
                  label: 'Clean old',
                  form: [
                    {
                      id: 'days',
                      label: `Delete the checkpoints of ${name} older than:`,
                      kind: 'select',
                      value: '7',
                      options: [
                        { value: '1', label: '1 day' },
                        { value: '3', label: '3 days' },
                        { value: '7', label: '7 days' },
                        { value: '30', label: '30 days' },
                      ],
                    },
                  ],
                },
                {
                  kind: 'button',
                  id: 'checkpoints.deleteAll',
                  label: 'Delete all',
                  style: 'danger',
                  confirm: `Every checkpoint of ${name} is deleted. The project's own files and git are not touched.`,
                },
              ]
            : [],
        },
        {
          id: 'list',
          title: '',
          items: [
            {
              kind: 'list',
              id: 'checkpoints.list',
              label: 'Checkpoints',
              description: 'Newest first. Restore shows what changes before anything is touched.',
              emptyText: 'No checkpoints left.',
              rows: items.map((c) => historyRow(c)),
            },
          ],
        },
      ],
    };
  }

  async change(page: string, id: string, value: unknown, rowId?: string): Promise<void> {
    if (id === 'checkpoints.mode') {
      await this.cp.updateSettings({ mode: String(value) });
      return;
    }
    if (id === 'checkpoints.projects' && rowId) {
      await this.cp.setDecision(rowId, value === true ? 'on' : 'off');
      return;
    }
    const keys = ['retention_days', 'max_per_chat', 'max_project_mb', 'max_file_mb'] as const;
    const key = keys.find((k) => id === `checkpoints.${k}`);
    if (key) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error('Not a number');
      await this.cp.updateSettings({ [key]: n });
      return;
    }
    void page;
  }

  /** Returns a toast text. `post` reaches the view that asked (opens a page or the restore sheet there). */
  async action(page: string, id: string, rowId: string | undefined, actionId: string | undefined, values: Record<string, string> | undefined, post: (m: HostToView) => void): Promise<string | void> {
    const history = page.startsWith(HISTORY) ? page.slice(HISTORY.length) : null;
    const project = history ?? rowId ?? '';
    const name = baseName(project) || project;
    const act = history ? id.replace(/^checkpoints\./, '') : actionId;
    if (id === 'checkpoints.list' && history && rowId && actionId === 'restore') {
      const cp = (await this.cp.history(history)).find((c) => c.id === rowId);
      if (!cp) throw new Error('This checkpoint is gone');
      post({ type: 'checkpointOpen', project: history, checkpoint: toCheckpointView(cp), deletable: true });
      return;
    }
    if (!project) return;
    switch (act) {
      case 'history': {
        const info = (await this.cp.projects()).find((p) => p.path === project);
        post({
          type: 'checkpointHistory',
          page: `${HISTORY}${project}`,
          title: name,
          subtitle: info ? `${plural(info.count, 'checkpoint')} · ${formatBytes(info.size_bytes)}` : null,
        });
        return;
      }
      case 'clean': {
        const days = Number(values?.days ?? 7) || 7;
        const r = await this.cp.delete(project, { olderThanDays: days });
        return `Deleted ${plural(r.deleted, 'checkpoint')} · ${formatBytes(Math.max(0, r.size_before - r.size_after))} freed`;
      }
      case 'deleteAll':
        await this.cp.delete(project, { all: true });
        return `All checkpoints of ${name} deleted`;
      case 'forget':
        await this.cp.delete(project, { all: true, forget: true });
        return `${name} forgotten`;
    }
  }
}

/** A history row (HistoryRow): the message, who sent it and when. */
function historyRow(c: CheckpointSummary): SettingListRow {
  const pre = c.kind === 'pre-restore';
  const flags = [
    formatCheckpointTime(c.time),
    c.mid_turn ? 'sent while working' : null,
    c.late ? 'late' : null,
    (c.repos ?? 1) > 1 ? `${c.repos} repos` : null,
  ].filter(Boolean);
  return {
    id: c.id,
    title: c.title?.trim() || (pre ? 'Before a restore' : 'Message'),
    status: pre ? 'undo point' : agentLabelOf(c.agent),
    statusTone: pre ? 'warn' : 'muted',
    subtitle: flags.join(' · '),
    actions: [{ id: 'restore', label: 'Restore' }],
  };
}

export function toCheckpointView(c: CheckpointSummary) {
  return { id: c.id, time: c.time, kind: c.kind, agent: c.agent ?? null, title: c.title ?? null, midTurn: c.mid_turn === true, late: c.late === true, repos: c.repos ?? 1 };
}
