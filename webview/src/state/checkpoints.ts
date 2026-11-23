// Project checkpoints in the view (the app's ChatViewModel.messageCheckpoints + ChatScreen's sheet state): the open
// chat's restore points as the host sends them, the requests of the restore sheet / ask dialog, and which sheet is open.
import { createSignal } from 'solid-js';
import type { ChatMessage } from '@shared/model';
import type { CheckpointPreviewView, CheckpointProjectView, CheckpointRequest, CheckpointView } from '@shared/protocol';
import { host } from '../host';
import { pushPage, settings } from './settings';
import { state } from './store';

const [restorePoints, setRestorePoints] = createSignal<{ conversationId: string; project: string | null; byMessage: Record<string, CheckpointView> } | null>(null);

/** The checkpoint saved right before this user message of the open chat, if any. */
export function checkpointOf(messageId: string): CheckpointView | null {
  const r = restorePoints();
  if (!r || r.conversationId !== state.chat.conversationId || !r.project) return null;
  return r.byMessage[messageId] ?? null;
}

/** The open chat's project folder as the host knows it (the restore sheet works on it). */
export function chatProject(): string | null {
  const r = restorePoints();
  return r && r.conversationId === state.chat.conversationId ? r.project : null;
}

/** What the restore sheet shows: a message's restore point (with the chat part), or a checkpoint from the settings. */
export interface SheetTarget {
  project: string;
  checkpoint: CheckpointView;
  /** From the chat: going back in the chat is offered too. */
  message?: ChatMessage | null;
  conversationId?: string | null;
  /** From Settings → History: the sheet has Delete. */
  deletable?: boolean;
}

export const [sheetTarget, setSheetTarget] = createSignal<SheetTarget | null>(null);

/** Opens "Go back to before this message" for a user message of the open chat. */
export function openRestoreSheet(msg: ChatMessage) {
  const cp = checkpointOf(msg.id);
  const project = chatProject();
  if (!cp || !project) return;
  setSheetTarget({ project, checkpoint: cp, message: msg, conversationId: state.chat.conversationId });
}

interface Reply {
  error?: string | null;
  preview?: CheckpointPreviewView | null;
  project?: CheckpointProjectView | null;
}

const pending = new Map<string, (r: Reply) => void>();
let n = 0;

/** A request to the host (rejects with its error). */
export function checkpointRequest(request: CheckpointRequest): Promise<Reply> {
  const reqId = `cp_${Date.now()}_${++n}`;
  return new Promise((resolve, reject) => {
    pending.set(reqId, (r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
    host.send({ type: 'checkpoint', reqId, request });
  });
}

host.onMessage((m) => {
  if (m.type === 'checkpoints') setRestorePoints({ conversationId: m.conversationId, project: m.project, byMessage: m.byMessage });
  else if (m.type === 'checkpointReply') {
    const cb = pending.get(m.reqId);
    pending.delete(m.reqId);
    cb?.(m);
  } else if (m.type === 'checkpointOpen') setSheetTarget({ project: m.project, checkpoint: m.checkpoint, deletable: m.deletable === true });
  else if (m.type === 'checkpointHistory' && settings.open) pushPage({ id: m.page, title: m.title, subtitle: m.subtitle });
});
