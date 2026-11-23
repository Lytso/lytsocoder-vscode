// Port of the app's data/checkpoint/ProjectCheckpoints.kt: the bridge (bridge/pkg/checkpoint, /api/checkpoints/…) keeps a
// hidden copy of a project's files right before each chat message (any agent) and puts them back with a preview first.
// This is the extension's side: the settings, the call each agent makes before sending, and the lookups the chat uses
// to show "restore" on its messages. One shared instance (`checkpoints`), like the app's object.
import path from 'node:path';
import type { AgentKind, ChatMessage } from '../../../shared/model';
import type { BridgeManager } from '../bridge/BridgeManager';
import { absPath } from '../paths';
import { cleanTitle } from '../text';
import type { Logger } from '../types';

export const MODE_OFF = 'off';
export const MODE_SELECTED = 'selected';
export const MODE_ALL = 'all';

/** The bridge's checkpoint settings (CheckpointSettings). */
export interface CheckpointSettings {
  mode: string;
  retention_days: number;
  max_per_chat: number;
  max_project_mb: number;
  max_file_mb: number;
  /** project path → "on" | "off" (the answer to the ask-once question) */
  projects: Record<string, string>;
}

export interface CheckpointProjectState {
  path: string;
  exists: boolean;
  is_git: boolean;
  mode: string;
  decision: string;
  tracked: boolean;
  should_ask: boolean;
  reason?: string;
}

export interface CheckpointProjectInfo extends CheckpointProjectState {
  count: number;
  size_bytes: number;
  last_time?: number;
  has_data: boolean;
}

export interface CheckpointSummary {
  id: string;
  time: number;
  /** turn | pre-restore */
  kind: string;
  agent?: string;
  chat_id?: string;
  title?: string;
  mid_turn?: boolean;
  late?: boolean;
  took_ms?: number;
  restored_from?: string;
  repos?: number;
  skipped?: number;
}

export interface CheckpointFileChange {
  path: string;
  /** modified | deleted (made after the checkpoint) | recreated (deleted after it) */
  change: string;
  added: number;
  removed: number;
  binary?: boolean;
}

export interface CheckpointPreview {
  checkpoint: CheckpointSummary;
  files: CheckpointFileChange[] | null;
  modified: number;
  deleted: number;
  recreated: number;
  kept?: string[] | null;
  warnings: { kind: string; text: string }[] | null;
  later_chats: { agent?: string; chat_id?: string; title?: string; time: number; turns: number }[] | null;
  later_in_chat: number;
  /** restore only */
  errors?: string[] | null;
  undo_id?: string | null;
}

export interface CheckpointDeleteResult {
  deleted: number;
  size_before: number;
  size_after: number;
}

interface TurnResult {
  tracked: boolean;
  reason?: string;
  checkpoint?: CheckpointSummary;
  skipped?: string[];
}

export interface TurnInfo {
  agent: AgentKind;
  chatId: string;
  /** The chat's project (file:// link or path). */
  workspaceUri: string | null | undefined;
  /** The agent's id of the message (see checkpointKey). */
  key: string;
  /** The message as sent (hidden parts are collapsed for the title). */
  title: string;
  midTurn?: boolean;
}

/** How long a message waits for its checkpoint before going to the agent anyway (the copy is then marked late). */
const TURN_DEADLINE_MS = 10_000;
const SLOW_MS = 120_000;

/** What changed: `keys` = a message got (or lost) its checkpoint; `changes` = made, restored, deleted or settings. */
export type CheckpointChange = 'keys' | 'changes';

export class ProjectCheckpoints {
  private bridge: BridgeManager | null = null;
  private log: Logger = () => undefined;
  /** The bridge's checkpoint settings (null until read once). */
  settings: CheckpointSettings | null = null;
  private settingsFailedAt = 0;
  /** Checkpoints of messages, by the agent's id of the message. */
  readonly byKey = new Map<string, CheckpointSummary>();
  private listeners = new Set<(what: CheckpointChange) => void>();
  private warmed = new Set<string>();
  /** Per chat: frames waiting behind a checkpoint, so they still go out in the order they were sent. */
  private queues = new Map<string, Promise<void>>();

  /** The bridge to talk to (set once at activation; nothing is checkpointed before). */
  attach(bridge: BridgeManager, log: Logger) {
    this.bridge = bridge;
    this.log = log;
    void this.refreshSettings().catch(() => undefined);
  }

  onChange(cb: (what: CheckpointChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(what: CheckpointChange) {
    for (const l of this.listeners) l(what);
  }

  /** The folder of a chat's project ("file:///x" → "/x"), or null when it has none. */
  static pathOf(workspaceUri: string | null | undefined): string | null {
    const p = absPath(workspaceUri?.trim() || null);
    if (!p) return null;
    const root = path.parse(p).root;
    return p.length > root.length ? p.replace(/[\\/]+$/, '') : p;
  }

  // ------------------------------------------------------------------ http

  private async call(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, any>> {
    if (!this.bridge) throw new Error('The bridge is not ready yet');
    const clean = body && Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
    const res = await this.bridge.fetch(`/api/checkpoints/${route}`, {
      method,
      ...(clean ? { body: JSON.stringify(clean), headers: { 'content-type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) {
      if (res.status === 404) throw new Error('The bridge is too old for project checkpoints: restart it (Settings → Bridge & connection) or update the extension.');
      throw new Error(`HTTP ${res.status}`);
    }
    const obj = JSON.parse(text) as Record<string, any>;
    if (obj.success === false) throw new Error(String(obj.error || 'The bridge refused'));
    return obj;
  }

  private get = (route: string, timeoutMs?: number) => this.call('GET', route, undefined, timeoutMs);
  private post = (route: string, body: Record<string, unknown>, timeoutMs?: number) => this.call('POST', route, body, timeoutMs);

  // ------------------------------------------------------------------ settings & projects

  async refreshSettings(): Promise<CheckpointSettings> {
    try {
      const o = await this.get('settings');
      this.settings = normSettings(o.settings);
      this.settingsFailedAt = 0;
      return this.settings;
    } catch (e) {
      this.settingsFailedAt = Date.now();
      throw e;
    }
  }

  /**
   * The settings, read once (a failed read is not retried for a while, so sends never wait on a missing bridge; 10 s
   * here, not the app's minute: VS Code opens chats while the bridge is still starting).
   */
  async knownSettings(): Promise<CheckpointSettings | null> {
    if (this.settings) return this.settings;
    if (Date.now() - this.settingsFailedAt < 10_000) return null;
    return this.refreshSettings().catch(() => null);
  }

  /** Whether a message in this project may get a checkpoint (false: skip the call entirely). */
  mayCheckpoint(workspaceUri: string | null | undefined): boolean {
    return ProjectCheckpoints.pathOf(workspaceUri) != null && (this.settings?.mode ?? 'unknown') !== MODE_OFF;
  }

  async updateSettings(patch: { mode?: string; retention_days?: number; max_per_chat?: number; max_project_mb?: number; max_file_mb?: number }): Promise<CheckpointSettings> {
    const o = await this.post('settings', patch);
    this.settings = normSettings(o.settings);
    this.emit('changes');
    return this.settings;
  }

  async projectState(path: string): Promise<CheckpointProjectState> {
    const o = await this.get(`project?path=${encodeURIComponent(path)}`);
    return (o.project as CheckpointProjectState) ?? { path, exists: false, is_git: false, mode: MODE_OFF, decision: '', tracked: false, should_ask: false };
  }

  /** "on", "off", or "" (ask again). */
  async setDecision(path: string, decision: string): Promise<CheckpointProjectState> {
    const o = await this.post('project', { path, decision });
    this.emit('changes');
    await this.refreshSettings().catch(() => undefined);
    return o.project as CheckpointProjectState;
  }

  async projects(): Promise<CheckpointProjectInfo[]> {
    const o = await this.get('projects');
    if (o.settings) this.settings = normSettings(o.settings);
    return (o.projects as CheckpointProjectInfo[] | null) ?? [];
  }

  async history(path: string, limit = 0): Promise<CheckpointSummary[]> {
    const o = await this.get(`history?project=${encodeURIComponent(path)}&limit=${limit}`);
    return (o.checkpoints as CheckpointSummary[] | null) ?? [];
  }

  // ------------------------------------------------------------------ turns

  /**
   * Called by every agent right before a message goes out: the bridge copies the project when it is tracked (else
   * answers at once). Never throws and never blocks longer than the deadline; resolves to null when no checkpoint was
   * made. Returns null right away (no promise) when this message cannot get one, so the caller sends at once.
   */
  beforeTurn(t: TurnInfo): Promise<CheckpointSummary | null> | null {
    if (!this.bridge || !this.mayCheckpoint(t.workspaceUri)) return null;
    return this.turn(t);
  }

  private async turn(t: TurnInfo): Promise<CheckpointSummary | null> {
    const project = ProjectCheckpoints.pathOf(t.workspaceUri);
    if (!project) return null;
    const s = await this.knownSettings();
    if (!s || s.mode === MODE_OFF) return null;
    const started = Date.now();
    try {
      const title = cleanTitle(t.title).split('\n').find((l) => l.trim())?.trim() ?? '';
      const o = await this.post(
        'turn',
        { project, agent: t.agent.toLowerCase(), chat_id: t.chatId, key: t.key, title, mid_turn: t.midTurn === true, deadline_ms: TURN_DEADLINE_MS },
        TURN_DEADLINE_MS + 2_000,
      );
      const cp = (o.result as TurnResult | undefined)?.checkpoint;
      if (!cp) return null;
      if (t.key) this.byKey.set(t.key, cp);
      this.emit('keys');
      return cp;
    } catch (e) {
      this.log(`[checkpoints] checkpoint before the message failed after ${Date.now() - started} ms: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * beforeTurn without waiting for it: for a message sent while the agent is still working (its reply keeps streaming
   * meanwhile; such a checkpoint is marked mid-turn).
   */
  beforeTurnInBackground(t: TurnInfo) {
    void this.beforeTurn({ ...t, midTurn: true });
  }

  /** The agents' one call: mid-turn = in the background, else waits for the checkpoint (null at once when none). */
  beforeSend(t: TurnInfo): Promise<CheckpointSummary | null> | null {
    if (t.midTurn) {
      this.beforeTurnInBackground(t);
      return null;
    }
    return this.beforeTurn(t);
  }

  /**
   * Sends [send] once [pending] (a checkpoint) is done, after anything still waiting for this chat: frames keep their
   * order. Nothing waiting = sent right now.
   */
  sendInOrder(chatId: string, pending: Promise<unknown> | null, send: () => void) {
    const before = this.queues.get(chatId);
    if (!pending && !before) {
      send();
      return;
    }
    const next = (before ?? Promise.resolve())
      .then(() => pending)
      .catch(() => undefined)
      .then(send)
      .catch((e) => this.log(`[checkpoints] send: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        if (this.queues.get(chatId) === next) this.queues.delete(chatId);
      });
    this.queues.set(chatId, next);
  }

  /** Another id of the same message (Codex's turn id, known once the turn started). */
  async bind(workspaceUri: string | null | undefined, checkpoint: CheckpointSummary, key: string | null | undefined) {
    const project = ProjectCheckpoints.pathOf(workspaceUri);
    if (!project || !key) return;
    this.byKey.set(key, checkpoint);
    this.emit('keys');
    await this.post('bind', { project, id: checkpoint.id, key }).catch((e) => this.log(`[checkpoints] bind failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  /**
   * A chat opened in this project: the bridge makes the first (slow) copy of a tracked project in the background now,
   * so the first message does not wait for it. Once per project per run.
   */
  async warm(project: string) {
    const s = await this.knownSettings();
    if (!s || s.mode === MODE_OFF || this.warmed.has(project)) return;
    this.warmed.add(project);
    await this.projectState(project).catch(() => this.warmed.delete(project));
  }

  /** Loads the checkpoints of these message ids (a chat on screen). Returns whether any changed. */
  async lookup(project: string, keys: string[]): Promise<boolean> {
    const s = await this.knownSettings();
    if (!s || s.mode === MODE_OFF || !keys.length) return false;
    const o = await this.post('lookup', { project, keys });
    const found = (o.checkpoints as Record<string, CheckpointSummary> | null) ?? {};
    let changed = false;
    for (const k of keys) {
      const now = found[k];
      const had = this.byKey.get(k);
      if (now) {
        if (!had || had.id !== now.id) changed = true;
        this.byKey.set(k, now);
      } else if (had) {
        this.byKey.delete(k);
        changed = true;
      }
    }
    return changed;
  }

  // ------------------------------------------------------------------ restore

  async preview(project: string, id: string): Promise<CheckpointPreview> {
    const o = await this.post('preview', { project, id }, SLOW_MS);
    return o.preview as CheckpointPreview;
  }

  async restore(project: string, id: string): Promise<CheckpointPreview> {
    const o = await this.post('restore', { project, id }, SLOW_MS);
    this.emit('changes');
    return o.result as CheckpointPreview;
  }

  async diff(project: string, id: string, file: string): Promise<string> {
    const o = await this.post('diff', { project, id, path: file }, SLOW_MS);
    return String(o.diff ?? '');
  }

  async delete(project: string, req: { ids?: string[]; olderThanDays?: number; all?: boolean; forget?: boolean }): Promise<CheckpointDeleteResult> {
    const o = await this.post('delete', { project, ids: req.ids, older_than_days: req.olderThanDays, all: req.all === true, forget: req.forget === true }, SLOW_MS);
    const gone = new Set(req.ids ?? []);
    for (const [k, v] of [...this.byKey]) if (req.all || req.olderThanDays != null || gone.has(v.id)) this.byKey.delete(k);
    if (req.forget) await this.refreshSettings().catch(() => undefined);
    this.emit('keys');
    this.emit('changes');
    return (o.result as CheckpointDeleteResult) ?? { deleted: 0, size_before: 0, size_after: 0 };
  }
}

function normSettings(s: Partial<CheckpointSettings> | null | undefined): CheckpointSettings {
  return {
    mode: s?.mode || MODE_OFF,
    retention_days: s?.retention_days ?? 30,
    max_per_chat: s?.max_per_chat ?? 100,
    max_project_mb: s?.max_project_mb ?? 500,
    max_file_mb: s?.max_file_mb ?? 20,
    projects: s?.projects ?? {},
  };
}

/**
 * The id a project checkpoint of this user [message] was saved under (AgentChatBackend.checkpointKey and the agents'
 * overrides), or null when it has none: Claude `user_<uuid>` → the uuid; OpenCode the message id; Antigravity (its
 * client_msg tag) and Codex (turn id / client id) set `checkpointKey` in their transcripts.
 */
export function checkpointKey(agent: AgentKind, m: ChatMessage): string | null {
  if (m.role !== 'USER') return null;
  if (m.checkpointKey) return m.checkpointKey;
  if (agent === 'CLAUDE') return m.id.startsWith('user_') ? m.id.slice(5) : null;
  if (agent === 'OPENCODE') return m.id && !m.id.startsWith('local-') ? m.id : null;
  return null;
}

/** The shared instance every agent and the host use (the app's `object ProjectCheckpoints`). */
export const checkpoints = new ProjectCheckpoints();
