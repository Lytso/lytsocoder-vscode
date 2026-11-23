// Project checkpoints on the host (the app's ChatViewModel "PROJECT CHECKPOINTS" part + ChatScreen's sheet calls): the
// restore points of the chat each view shows (looked up by the agents' message ids), the restore sheet's requests
// (preview, restore, per-file diff in an editor tab, delete), the ask-once question, and the settings pages.
// The agents call `checkpoints.beforeSend` themselves right before a message goes out (see client.ts).
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, Conversation } from '../../../shared/model';
import type { CheckpointPreviewView, CheckpointRequest, CheckpointView, HostToView } from '../../../shared/protocol';
import { folderKey } from '../paths';
import type { ChatState, Logger } from '../types';
import { checkpointKey, type CheckpointPreview, MODE_OFF, MODE_SELECTED, ProjectCheckpoints } from './client';
import { addedText, applyUnifiedDiff } from './patch';
import { CheckpointSettingsPages, isCheckpointPage, toCheckpointView } from './settings';

export { checkpoints } from './client';
export { isCheckpointPage };

export interface CheckpointHostApi {
  /** Every chat of the enabled agents (other chats still running in a project are warned about). */
  conversations(): Conversation[];
  /** Two versions side by side in a diff editor (absent: the diff text is opened instead). */
  openDiff?(title: string, left: { path?: string | null; text?: string | null }, right: { text: string; name: string }): void;
  openText(title: string, content: string, language?: string | null): void;
  /** Re-sends the open settings pages that show checkpoints (and the root). */
  refreshPages(): void;
  log: Logger;
}

interface ViewTrack {
  post: (m: HostToView) => void;
  conversationId: string;
  agent: AgentKind;
  project: string | null;
  /** user message id → its checkpoint key */
  pairs: [string, string][];
  sig: string;
  lastJson: string;
  timer: NodeJS.Timeout | null;
}

const MAX_DIFF_FILE = 8 * 1024 * 1024;

export class CheckpointsHost {
  readonly settings: CheckpointSettingsPages;
  private views = new Map<string, ViewTrack>();
  private unsub: () => void;

  constructor(
    private cp: ProjectCheckpoints,
    private api: CheckpointHostApi,
  ) {
    this.settings = new CheckpointSettingsPages(cp, () => api.refreshPages());
    this.unsub = cp.onChange((what) => {
      if (what === 'keys') for (const t of this.views.values()) this.repost(t);
      else for (const t of this.views.values()) this.scheduleLookup(t, 50);
      api.refreshPages();
    });
  }

  /** A view's chat changed (host push): its user messages' restore points are looked up when they change. */
  onChat(viewId: string, post: (m: HostToView) => void, conversationId: string, state: ChatState) {
    const conv = state.conversation;
    // a cloud chat's files are not on the bridge's machine
    const project = conv && conv.cloudProjectId == null ? ProjectCheckpoints.pathOf(conv.workspaceUri) : null;
    const pairs: [string, string][] = [];
    for (const m of state.messages) {
      const k = checkpointKey(state.agent, m);
      if (k) pairs.push([m.id, k]);
    }
    const sig = `${project ?? ''}|${pairs.map((p) => `${p[0]}=${p[1]}`).join(',')}`;
    let t = this.views.get(viewId);
    if (!t || t.conversationId !== conversationId) {
      if (t?.timer) clearTimeout(t.timer);
      t = { post, conversationId, agent: state.agent, project, pairs, sig: '', lastJson: '', timer: null };
      this.views.set(viewId, t);
    }
    t.post = post;
    if (t.sig === sig) return;
    t.sig = sig;
    t.agent = state.agent;
    t.project = project;
    t.pairs = pairs;
    this.repost(t);
    this.scheduleLookup(t, 300);
  }

  forgetView(viewId: string) {
    const t = this.views.get(viewId);
    if (t?.timer) clearTimeout(t.timer);
    this.views.delete(viewId);
  }

  private scheduleLookup(t: ViewTrack, delay: number) {
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.lookup(t);
    }, delay);
  }

  private async lookup(t: ViewTrack) {
    const project = t.project;
    if (!project) return;
    try {
      await this.cp.warm(project);
      const keys = [...new Set(t.pairs.map((p) => p[1]))];
      if (keys.length) await this.cp.lookup(project, keys);
    } catch (e) {
      this.api.log(`[checkpoints] lookup: ${e instanceof Error ? e.message : String(e)}`);
    }
    // still the chat the view shows
    if ([...this.views.values()].includes(t)) this.repost(t);
  }

  /** Sends the view its chat's restore points when they changed. */
  private repost(t: ViewTrack) {
    const byMessage: Record<string, CheckpointView> = {};
    if (t.project && this.cp.settings?.mode !== MODE_OFF) {
      for (const [id, key] of t.pairs) {
        const s = this.cp.byKey.get(key);
        if (s) byMessage[id] = toCheckpointView(s);
      }
    }
    const json = JSON.stringify([t.conversationId, t.project, byMessage]);
    if (json === t.lastJson) return;
    t.lastJson = json;
    t.post({ type: 'checkpoints', conversationId: t.conversationId, project: t.project, byMessage });
  }

  /** A `checkpoint` request from a view's restore sheet / ask dialog; [reply] answers it. */
  async request(reqId: string, req: CheckpointRequest, post: (m: HostToView) => void) {
    const reply = (fields: Omit<Extract<HostToView, { type: 'checkpointReply' }>, 'type' | 'reqId'>) => post({ type: 'checkpointReply', reqId, ...fields });
    try {
      const project = ProjectCheckpoints.pathOf(req.project);
      if (!project) throw new Error('This chat has no project folder');
      switch (req.action) {
        case 'project': {
          // asked only when checkpoints are on for chosen projects and this one was never answered
          const s = await this.cp.knownSettings();
          if (!s || s.mode !== MODE_SELECTED) return reply({ project: { path: project, isGit: false, shouldAsk: false } });
          const st = await this.cp.projectState(project);
          return reply({ project: { path: st.path || project, isGit: st.is_git, shouldAsk: st.should_ask } });
        }
        case 'decide': {
          const st = await this.cp.setDecision(project, req.decision);
          return reply({ project: { path: st?.path || project, isGit: !!st?.is_git, shouldAsk: false } });
        }
        case 'preview':
          return reply({ preview: { ...toPreviewView(await this.cp.preview(project, req.id)), otherRunning: this.runningIn(project, req.conversationId) } });
        case 'restore':
          return reply({ preview: toPreviewView(await this.cp.restore(project, req.id)) });
        case 'diff':
          await this.openDiff(project, req.id, req.file, req.change);
          return reply({});
        case 'delete':
          await this.cp.delete(project, { ids: [req.id] });
          return reply({});
      }
    } catch (e) {
      reply({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Other chats (any agent) still running in the project (ChatViewModel.runningChatsInProject). */
  private runningIn(project: string, open?: string | null): number {
    const key = folderKey(project);
    return this.api.conversations().filter((c) => c.id !== open && (c.isRunning || c.notFullyIdle) && c.workspaceUri && folderKey(c.workspaceUri) === key).length;
  }

  /**
   * One file of the restore: the file now (left) against the checkpoint's copy (right) in a diff editor. The bridge
   * gives the diff (now → checkpoint); the checkpoint's copy is the file now with that diff applied. When it does not
   * fit (the file changed since the preview) the diff itself opens.
   */
  private async openDiff(project: string, id: string, file: string, change: string) {
    const diff = await this.cp.diff(project, id, file);
    const name = path.basename(file);
    const title = `${name}: now ↔ checkpoint`;
    const abs = path.join(project, file);
    const openRaw = () => this.api.openText(title, diff || 'No difference.', 'diff');
    if (!this.api.openDiff || !diff.trim()) return openRaw();
    let now: string | null = null;
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= MAX_DIFF_FILE) now = fs.readFileSync(abs, 'utf8');
    } catch {
      now = null;
    }
    if (change === 'recreated') {
      // deleted after the checkpoint: the restore brings it back
      const text = addedText(diff);
      if (text == null) return openRaw();
      return this.api.openDiff(title, { text: '' }, { text, name });
    }
    if (now == null) return openRaw();
    // made after the checkpoint: the restore removes it
    if (change === 'deleted') return this.api.openDiff(title, { path: abs }, { text: '', name });
    const then = applyUnifiedDiff(now, diff);
    if (then == null) return openRaw();
    this.api.openDiff(title, { path: abs }, { text: then, name });
  }

  dispose() {
    this.unsub();
    for (const t of this.views.values()) if (t.timer) clearTimeout(t.timer);
    this.views.clear();
  }
}

function toPreviewView(p: CheckpointPreview): CheckpointPreviewView {
  return {
    checkpoint: toCheckpointView(p.checkpoint),
    files: p.files ?? [],
    modified: p.modified ?? 0,
    deleted: p.deleted ?? 0,
    recreated: p.recreated ?? 0,
    warnings: p.warnings ?? [],
    laterChats: (p.later_chats ?? []).map((c) => ({ agent: c.agent ?? null, title: c.title ?? null, time: c.time, turns: c.turns })),
    errors: p.errors ?? [],
    undoId: p.undo_id ?? null,
  };
}
