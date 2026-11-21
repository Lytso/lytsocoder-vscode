// Project checkpoints in the chat: ui/checkpoint/CheckpointRestoreSheet.kt (what a restore changes, per-file diffs —
// opened in a VS Code diff tab here —, restore, undo), TrackProjectDialog from ProjectCheckpointsScreen.kt (asked once
// per project), and MessageBubble.kt's "Restore point" chip and action. Data: state/checkpoints.ts.
import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { AgentKind, ChatMessage } from '@shared/model';
import type { CheckpointPreviewView, CheckpointProjectView, CheckpointView } from '@shared/protocol';
import { BottomSheet, Dialog, Icon, IconButton, type IconName } from '../ui/primitives';
import { agentAccent, agentLabel, alpha } from '../util/format';
import { newChatProjectUri, send, showToast, state } from '../state/store';
import { checkpointOf, checkpointRequest, openRestoreSheet, setSheetTarget, sheetTarget, type SheetTarget } from '../state/checkpoints';
import '../styles/checkpoints.css';

const AGENTS: Record<string, AgentKind> = { claude: 'CLAUDE', agy: 'AGY', codex: 'CODEX', opencode: 'OPENCODE' };
const agentOf = (a: string | null | undefined): AgentKind | null => (a ? (AGENTS[a.toLowerCase()] ?? null) : null);

/** "just now", "5 min ago", "3 h ago", else the date (formatCheckpointTime). */
function formatCheckpointTime(ms: number): string {
  if (!ms || ms <= 0) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 24 * 3_600_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------------------------------------ in the bubble

/** A project checkpoint was saved right before this message: one tap to go back to it (MessageBubble.kt). */
export function RestorePointChip(props: { msg: ChatMessage }) {
  return (
    <Show when={checkpointOf(props.msg.id)}>
      <button class="cp-chip" title="Go back to before this message" onClick={() => openRestoreSheet(props.msg)}>
        <Icon name="history" size={12} />
        Restore point
      </button>
    </Show>
  );
}

/** The bubble's actions row: go back to the checkpoint saved before this message. */
export function RestorePointButton(props: { msg: ChatMessage; onClick?: () => void }) {
  return (
    <Show when={checkpointOf(props.msg.id)}>
      <IconButton
        icon="history"
        iconSize={16}
        color="var(--info)"
        title="Restore to before this message"
        onClick={() => {
          props.onClick?.();
          openRestoreSheet(props.msg);
        }}
      />
    </Show>
  );
}

/** "Edit Message?": files go back only through the message's restore point (ChatScreen.kt). */
export function EditRestoreLink(props: { msg: ChatMessage; onOpen: () => void }) {
  return (
    <Show when={checkpointOf(props.msg.id)}>
      <button
        class="cp-edit-link"
        onClick={() => {
          props.onOpen();
          openRestoreSheet(props.msg);
        }}
      >
        <Icon name="history" size={18} />
        Put files back too? Use this message's restore point
      </button>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ restore sheet

/** What a restore puts back (RestoreMode). */
interface RestoreMode {
  id: 'both' | 'files' | 'chat';
  title: string;
  description: string;
  icon: IconName;
  files: boolean;
  chat: boolean;
}
const MODES: RestoreMode[] = [
  { id: 'both', title: 'Chat and files', description: 'The chat goes back to before this message (its text returns to the input box) and the files go back too', icon: 'history', files: true, chat: true },
  { id: 'files', title: 'Files only', description: 'Only the project files go back; the chat stays as it is', icon: 'folder_o', files: true, chat: false },
  { id: 'chat', title: 'Chat only', description: 'Only the chat goes back (its text returns to the input box); files stay as they are now', icon: 'chat_bubble', files: false, chat: true },
];

type SheetState =
  | { k: 'loading' }
  | { k: 'failed'; message: string }
  | { k: 'ready'; preview: CheckpointPreviewView }
  | { k: 'working'; label: string }
  | { k: 'done'; result: CheckpointPreviewView; mode: RestoreMode }
  | { k: 'undone' };

/** The sheet and the ask-once dialog, mounted once (App.tsx). */
export function CheckpointsLayer() {
  return (
    <>
      <RestoreSheetHost />
      <TrackProjectAsk />
    </>
  );
}

function RestoreSheetHost() {
  // the target stays while the sheet slides away
  const [shown, setShown] = createSignal<SheetTarget | null>(null);
  const [busy, setBusy] = createSignal(false);
  createEffect(on(sheetTarget, (t) => t && setShown(t)));
  const close = () => {
    if (!busy()) setSheetTarget(null);
  };
  return (
    <BottomSheet open={!!sheetTarget()} onClose={close} class="cp-sheet">
      <Show when={shown()} keyed>
        {(t) => <RestoreSheet target={t} onClose={close} setBusy={setBusy} />}
      </Show>
    </BottomSheet>
  );
}

/**
 * "Go back to before this message": loads what would change (files and warnings), lets the user pick chat / files /
 * both, restores, and offers to undo the file part right after (CheckpointRestoreSheet).
 */
function RestoreSheet(props: { target: SheetTarget; onClose: () => void; setBusy: (b: boolean) => void }) {
  const t = props.target;
  const cp = t.checkpoint;
  const sameChat = () => !!t.message && t.conversationId != null && t.conversationId === state.chat.conversationId;
  // the chat part: a message of a chat that takes messages (not from the settings history)
  const chatPart = () => sameChat() && !state.chat.readOnly && !t.message!.id.startsWith('local-');
  const agentBusy = () => sameChat() && state.chat.isStreaming;
  const [st, setSt] = createSignal<SheetState>({ k: 'loading' });
  const [mode, setMode] = createSignal<RestoreMode>(chatPart() ? MODES[0] : MODES[1]);
  const [reload, setReload] = createSignal(0);
  createEffect(() => props.setBusy(st().k === 'working'));
  onCleanup(() => props.setBusy(false));
  createEffect(
    on(reload, () => {
      setSt({ k: 'loading' });
      checkpointRequest({ action: 'preview', project: t.project, id: cp.id, conversationId: t.conversationId ?? null }).then(
        (r) => setSt(r.preview ? { k: 'ready', preview: r.preview } : { k: 'failed', message: 'Could not compare the files' }),
        (e: Error) => setSt({ k: 'failed', message: e.message || 'Could not compare the files' }),
      );
    }),
  );
  const restoreChat = () => {
    if (t.message && t.conversationId) send({ type: 'rewind', conversationId: t.conversationId, messageId: t.message.id });
  };
  const restore = () => {
    const m = mode();
    if (!m.files) {
      restoreChat();
      props.onClose();
      return;
    }
    setSt({ k: 'working', label: 'Restoring…' });
    checkpointRequest({ action: 'restore', project: t.project, id: cp.id }).then(
      (r) => {
        if (m.chat) restoreChat();
        setSt({ k: 'done', result: r.preview!, mode: m });
      },
      (e: Error) => setSt({ k: 'failed', message: e.message || 'Restore failed: nothing was changed' }),
    );
  };
  const undo = (id: string) => {
    setSt({ k: 'working', label: 'Restoring…' });
    checkpointRequest({ action: 'restore', project: t.project, id }).then(
      () => setSt({ k: 'undone' }),
      (e: Error) => setSt({ k: 'failed', message: e.message || 'Could not undo' }),
    );
  };
  const del = () => {
    props.onClose();
    checkpointRequest({ action: 'delete', project: t.project, id: cp.id }).catch((e: Error) => showToast(e.message, 'error'));
  };

  return (
    <div class="cp-body">
      <SheetHeader cp={cp} fromChat={chatPart()} />
      <Show when={st().k === 'loading'}>
        <Busy text="Comparing the project with this checkpoint…" />
      </Show>
      <Show when={st().k === 'working'}>
        <Busy text={(st() as { label: string }).label} />
      </Show>
      <Show when={st().k === 'failed'}>
        <Notice icon="error_o" color="var(--danger)" text={(st() as { message: string }).message} />
        <div class="cp-actions">
          <span class="cp-spacer" />
          <button class="text-btn muted" onClick={props.onClose}>
            Close
          </button>
          <button class="filled-btn" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </div>
      </Show>
      <Show when={st().k === 'ready' ? (st() as { preview: CheckpointPreviewView }).preview : null}>
        {(pv) => (
          <>
            <PreviewBody target={t} preview={pv()} files={mode().files} />
            <Show
              when={agentBusy()}
              fallback={
                <Show when={(pv().otherRunning ?? 0) > 0}>
                  <Notice
                    icon="warning_amber"
                    color="var(--warning)"
                    text={`${pv().otherRunning} other chat${pv().otherRunning === 1 ? ' is' : 's are'} still running in this project and may change files again after the restore.`}
                  />
                </Show>
              }
            >
              <Notice icon="warning_amber" color="var(--danger)" text="The agent is still working in this chat. Stop it first, then restore." />
            </Show>
            <Show when={chatPart()}>
              <div class="cp-label">What goes back</div>
              <div class="picker-options cp-modes">
                <For each={MODES}>
                  {(m) => (
                    <button class="picker-option" classList={{ on: mode().id === m.id }} style={{ '--opt': 'var(--primary)' }} onClick={() => setMode(m)}>
                      <span class="picker-option-icon">
                        <Icon name={m.icon} size={19} />
                      </span>
                      <span class="picker-option-text">
                        <span class="picker-option-title">{m.title}</span>
                        <span class="picker-option-desc">{m.description}</span>
                      </span>
                      <Show when={mode().id === m.id}>
                        <span class="picker-option-check">
                          <Icon name="check" size={14} />
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="cp-actions">
              <Show when={t.deletable}>
                <button class="text-btn" style={{ color: 'var(--danger)' }} onClick={del}>
                  Delete
                </button>
              </Show>
              <span class="cp-spacer" />
              <button class="text-btn muted" onClick={props.onClose}>
                Cancel
              </button>
              <button class="filled-btn" disabled={agentBusy() || (!mode().chat && pv().files.length === 0)} onClick={restore}>
                {mode().id === 'both' ? 'Restore chat & files' : mode().id === 'files' ? 'Restore files' : 'Restore chat'}
              </button>
            </div>
          </>
        )}
      </Show>
      <Show when={st().k === 'done' ? (st() as Extract<SheetState, { k: 'done' }>) : null}>
        {(d) => <DoneBody done={d()} onClose={props.onClose} onUndo={undo} />}
      </Show>
      <Show when={st().k === 'undone'}>
        <Notice icon="check_circle" color="var(--success)" text="Restore undone: the files are as they were right before it." />
        <div class="cp-actions">
          <span class="cp-spacer" />
          <button class="filled-btn" onClick={props.onClose}>
            Done
          </button>
        </div>
      </Show>
    </div>
  );
}

function SheetHeader(props: { cp: CheckpointView; fromChat: boolean }) {
  const agent = () => agentOf(props.cp.agent);
  const color = () => (agent() ? agentAccent(agent()!) : 'var(--primary)');
  const pre = () => props.cp.kind === 'pre-restore';
  return (
    <>
      <div class="cp-head">
        <span class="cp-head-icon" style={{ color: color(), background: alpha(color(), 0.14) }}>
          <Icon name="history" size={22} />
        </span>
        <div class="cp-head-text">
          <div class="cp-title">{pre() ? 'Undo that restore' : props.fromChat ? 'Go back to before this message' : 'Restore this checkpoint'}</div>
          <div class="cp-sub">{[agent() ? agentLabel(agent()!) : null, formatCheckpointTime(props.cp.time)].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <Show when={props.cp.title?.trim()}>
        <div class="cp-quote">“{props.cp.title}”</div>
      </Show>
    </>
  );
}

function Busy(props: { text: string }) {
  return (
    <div class="cp-busy">
      <span class="mini-spinner" />
      {props.text}
    </div>
  );
}

function Notice(props: { icon: IconName; color: string; text: string }) {
  return (
    <div class="cp-notice" style={{ background: alpha(props.color, 0.1) }}>
      <Icon name={props.icon} size={17} color={props.color} />
      <span>{props.text}</span>
    </div>
  );
}

function CountChip(props: { icon: IconName; color: string; text: string }) {
  return (
    <span class="cp-count" style={{ color: props.color, background: alpha(props.color, 0.12) }}>
      <Icon name={props.icon} size={14} />
      {props.text}
    </span>
  );
}

function PreviewBody(props: { target: SheetTarget; preview: CheckpointPreviewView; files: boolean }) {
  const pv = () => props.preview;
  const shown = () => pv().warnings.filter((w) => w.kind !== 'outside');
  const outside = () => pv().warnings.find((w) => w.kind === 'outside');
  return (
    <>
      <Show
        when={props.files}
        fallback={
          <Notice
            icon="info_o"
            color="var(--info)"
            text={`Files stay as they are now${pv().files.length ? ` (${pv().files.length} would differ from this checkpoint).` : '.'}`}
          />
        }
      >
        <Show when={pv().files.length} fallback={<Notice icon="check_circle" color="var(--success)" text="No file changes: the project's files are already as they were at this point." />}>
          <div class="cp-counts">
            <Show when={pv().modified > 0}>
              <CountChip icon="edit_o" color="var(--warning)" text={`${pv().modified} changed`} />
            </Show>
            <Show when={pv().recreated > 0}>
              <CountChip icon="add_circle" color="var(--success)" text={`${pv().recreated} come back`} />
            </Show>
            <Show when={pv().deleted > 0}>
              <CountChip icon="do_not_disturb_on" color="var(--danger)" text={`${pv().deleted} removed`} />
            </Show>
          </div>
          <div class="cp-files">
            <For each={pv().files}>{(f) => <FileRow target={props.target} file={f} />}</For>
          </div>
          <div class="cp-hint">Click a file to see exactly what changes in it.</div>
        </Show>
      </Show>
      <Show when={shown().length}>
        <div class="cp-warnings">
          <For each={shown()}>
            {(w) => <Notice icon="warning_amber" color={w.kind === 'other_chats' || w.kind === 'mid_turn' || w.kind === 'late' ? 'var(--warning)' : 'var(--info)'} text={w.text} />}
          </For>
          <Show when={pv().laterChats.length}>
            <div class="cp-later">
              <For each={pv().laterChats.slice(0, 5)}>
                {(lc) => {
                  const a = agentOf(lc.agent);
                  return (
                    <div class="cp-later-row">
                      • {a ? agentLabel(a) : 'Chat'}: “{lc.title?.trim() || 'untitled'}” ({plural(lc.turns, 'message')}, {formatCheckpointTime(lc.time)})
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={outside()}>
        <div class="cp-outside">
          <Icon name="info_o" size={14} />
          <span>{outside()!.text}</span>
        </div>
      </Show>
    </>
  );
}

/** One file of the restore; a click opens its change in a diff editor tab (the app expands it in place). */
function FileRow(props: { target: SheetTarget; file: CheckpointPreviewView['files'][number] }) {
  const f = () => props.file;
  const [opening, setOpening] = createSignal(false);
  const kind = (): [IconName, string, string] =>
    f().change === 'deleted'
      ? ['do_not_disturb_on', 'var(--danger)', 'removed']
      : f().change === 'recreated'
        ? ['add_circle', 'var(--success)', 'comes back']
        : ['edit_o', 'var(--warning)', 'changed'];
  const name = () => f().path.split('/').pop() || f().path;
  const dir = () => (f().path.includes('/') ? f().path.slice(0, f().path.lastIndexOf('/')) : '');
  const open = () => {
    if (f().binary) {
      showToast('A binary file: it is put back as it was.');
      return;
    }
    if (opening()) return;
    setOpening(true);
    checkpointRequest({ action: 'diff', project: props.target.project, id: props.target.checkpoint.id, file: f().path, change: f().change })
      .catch((e: Error) => showToast(e.message, 'error'))
      .finally(() => setOpening(false));
  };
  return (
    <button class="cp-file" onClick={open} title={`${f().path} (${kind()[2]})`}>
      <Icon name={kind()[0]} size={17} color={kind()[1]} />
      <span class="cp-file-text">
        <span class="cp-file-name">{name()}</span>
        <Show when={dir()}>
          <span class="cp-file-dir">{dir()}</span>
        </Show>
      </span>
      <Show
        when={!f().binary}
        fallback={<span class="cp-file-dir">binary</span>}
      >
        <Show when={f().added > 0}>
          <span class="cp-plus">+{f().added}</span>
        </Show>
        <Show when={f().removed > 0}>
          <span class="cp-minus">−{f().removed}</span>
        </Show>
      </Show>
      <Show when={opening()} fallback={<Icon name="difference" size={16} class="cp-file-open" />}>
        <span class="mini-spinner" />
      </Show>
    </button>
  );
}

function DoneBody(props: { done: Extract<SheetState, { k: 'done' }>; onClose: () => void; onUndo: (id: string) => void }) {
  const r = () => props.done.result;
  const parts = () =>
    [r().modified > 0 ? `${r().modified} changed back` : null, r().recreated > 0 ? `${r().recreated} brought back` : null, r().deleted > 0 ? `${r().deleted} removed` : null].filter(Boolean);
  const errors = () => r().errors ?? [];
  return (
    <>
      <div class="cp-done">
        <span class="cp-done-icon">
          <Icon name="check_circle" size={32} />
        </span>
        <div class="cp-done-title">{errors().length ? 'Files restored, with problems' : 'Files restored'}</div>
        <div class="cp-sub">{parts().length ? parts().join(' · ') : 'Nothing had to change.'}</div>
        <Show when={props.done.mode.chat}>
          <div class="cp-sub">The chat went back too: the message is in the input box.</div>
        </Show>
      </div>
      <Show when={errors().length}>
        <Notice icon="error_o" color="var(--danger)" text={errors().slice(0, 8).join('\n') + (errors().length > 8 ? `\n… ${errors().length - 8} more` : '')} />
      </Show>
      <div class="cp-actions">
        <Show when={r().undoId}>
          <button class="outlined-btn cp-undo" onClick={() => props.onUndo(r().undoId!)}>
            <Icon name="history" size={17} />
            {props.done.mode.chat ? 'Undo files' : 'Undo restore'}
          </button>
        </Show>
        <span class="cp-spacer" />
        <button class="filled-btn" onClick={props.onClose}>
          Done
        </button>
      </div>
      <Show when={props.done.mode.chat && r().undoId}>
        <div class="cp-hint">Undo brings the files back; the chat part can't be undone.</div>
      </Show>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ ask once

/** Projects already asked about in this view (dismissing without an answer asks again next time). */
const asked = new Set<string>();

/**
 * Asked once per project when checkpoints are on for chosen projects: a new, empty chat in a project asks "Keep
 * checkpoints for …?" (ChatScreen's LaunchedEffect + TrackProjectDialog). A dialog over the chat, as in the app: the
 * question belongs to the chat about to start there, and the first message's checkpoint depends on the answer.
 */
function TrackProjectAsk() {
  const [ask, setAsk] = createSignal<CheckpointProjectView | null>(null);
  const empty = () => !state.chat.conversation && state.chat.order.length === 0 && state.chat.pending.length === 0;
  createEffect(
    on(
      () => [empty() ? newChatProjectUri() : null, state.initialized] as const,
      ([project, ready]) => {
        if (!project || !ready || asked.has(project)) return;
        // the project picker closes first
        const timer = setTimeout(() => {
          checkpointRequest({ action: 'project', project })
            .then((r) => {
              if (!r.project?.shouldAsk || asked.has(project) || !empty() || newChatProjectUri() !== project) return;
              asked.add(project);
              setAsk(r.project);
            })
            .catch(() => undefined);
        }, 400);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );
  const answer = (decision: 'on' | 'off' | null) => {
    const st = ask();
    setAsk(null);
    if (st && decision) checkpointRequest({ action: 'decide', project: st.path, decision }).catch((e: Error) => showToast(e.message, 'error'));
  };
  const name = () => {
    const p = ask()?.path ?? '';
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  };
  return (
    <Dialog
      open={!!ask()}
      onClose={() => answer(null)}
      radius={16}
      background="var(--surface)"
      icon={<Icon name="history" size={24} color="var(--primary)" />}
      title={`Keep checkpoints for ${name()}?`}
      actions={
        <>
          <button class="text-btn muted" onClick={() => answer('off')}>
            Not for this project
          </button>
          <button class="text-btn strong" onClick={() => answer('on')}>
            Keep checkpoints
          </button>
        </>
      }
    >
      <div class="cp-ask">
        <div>
          Before each message, AntiGem saves a hidden copy of this project's files. Every message then gets a restore point: go back to before it, with a
          preview of each file that changes. Your git history, branches and staging stay untouched.
        </div>
        <Show when={ask() && !ask()!.isGit}>
          <Notice icon="warning_amber" color="var(--warning)" text="This folder is not a git repository. Checkpoints only work in git projects: they start once you run git init here." />
        </Show>
        <div class="cp-hint">You can change this any time in Settings → Project checkpoints.</div>
      </div>
    </Dialog>
  );
}
