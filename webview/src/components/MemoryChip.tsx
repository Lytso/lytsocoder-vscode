// ui/components/MemoryChip.kt: an ```antigem-memory block in a reply is a full-width chip instead of the raw block,
// telling what the bridge did with it (the host sends the chat to the bridge a moment after the turn). Tap to see what
// the agent wrote; Undo asks first (it cannot be redone).
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { MemoryAppliedView } from '@shared/protocol';
import { memoryChanges, memoryRequest, parseMemoryBlock } from '../state/memory';
import { Collapse, Dialog, Icon } from '../ui/primitives';
import '../styles/memory.css';

/** [complete]: the block's closing fence arrived. */
export function MemoryChip(props: { body: string; complete: boolean }) {
  const info = createMemo(() => parseMemoryBlock(props.body));
  const [status, setStatus] = createSignal<MemoryAppliedView | null>(null);
  // null = not known yet (the host tells with its first answer)
  const [enabled, setEnabled] = createSignal<boolean | null>(null);
  const [asked, setAsked] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal(false);
  const [confirmUndo, setConfirmUndo] = createSignal(false);

  createEffect(
    on([() => props.body, () => props.complete, memoryChanges], () => {
      if (!props.complete) return;
      let cancelled = false;
      onCleanup(() => (cancelled = true));
      void (async () => {
        // the host sends the chat to the bridge shortly after the turn: ask a few times until it has it
        for (let attempt = 0; attempt < 5; attempt++) {
          const r = await memoryRequest('applied', props.body);
          if (cancelled) return;
          if (r) {
            setEnabled(r.enabled);
            if (!r.enabled) break;
            if (r.applied) setStatus(r.applied);
            if (r.applied?.found) break;
          }
          await new Promise((res) => setTimeout(res, 2_000 + attempt * 1_000));
          if (cancelled) return;
        }
        setAsked(true);
      })();
    }),
  );

  const title = () => {
    const s = status();
    if (!props.complete) return 'Saving to memory…';
    if (enabled() === false) return 'Agent memory is off: not saved';
    if (error()) return error()!;
    if (s?.found && s.undone) return 'Undone';
    if (s?.found && s.action === 'error') return `Not saved: ${s.error ?? ''}`;
    if (s?.found && s.action === 'deleted') return 'Deleted from memory';
    if (s?.found && s.action === 'updated') return 'Memory updated';
    if (s?.found) return 'Saved to memory';
    if (asked()) return 'Not saved yet';
    return info().delete ? 'Deleting from memory…' : 'Saving to memory…';
  };
  const summary = () => [info().file, status()?.description || info().description].filter((x) => x && x.trim()).join(' — ');
  const canUndo = () => {
    const s = status();
    return props.complete && enabled() !== false && !!s?.found && !s.undone && s.action !== 'error';
  };
  const savedScope = () => {
    const id = status()?.id ?? '';
    if (id.startsWith('projects/')) return 'project';
    if (id.startsWith('global/')) return 'global';
    return info().scope;
  };
  const fields = createMemo(() => {
    const i = info();
    const s = status();
    const rows: [string, string][] = i.delete
      ? [['Asked to delete', i.file || '(no name)']]
      : [
          ['Name', i.file],
          ['Mode', i.mode === 'always' ? 'Always: every chat gets it in full' : i.mode === 'passive' ? 'Passive: listed when relevant' : ''],
          ['Scope', savedScope() === 'project' ? 'This project' : savedScope() === 'global' ? 'All projects' : ''],
          ['Description', i.description],
        ];
    if (s?.found && s.id) rows.push(['File', s.id]);
    return rows.filter(([, v]) => v.trim());
  });

  const undo = async () => {
    setConfirmUndo(false);
    setBusy(true);
    const r = await memoryRequest('undo', props.body);
    if (r && !r.error) {
      if (r.applied) setStatus(r.applied);
      setError(null);
    } else setError(r?.error || 'Undo failed');
    setBusy(false);
  };
  const undoText = () => {
    const name = info().file || 'this memory';
    const what =
      status()?.action === 'deleted'
        ? `The memory “${name}” comes back as it was.`
        : status()?.action === 'updated'
          ? `The memory “${name}” goes back to its earlier text.`
          : `The memory “${name}” is removed.`;
    return `${what} This cannot be undone: to save it again, ask the agent or add it in Settings → Agents → Agent memory & history.`;
  };

  return (
    <div class="mem-chip">
      <div class="mem-chip-head" role="button" onClick={() => setExpanded(!expanded())}>
        <Icon name="psychology" size={18} color="var(--primary)" />
        <div class="mem-chip-titles">
          <div class="mem-chip-title">{title()}</div>
          <Show when={summary()}>
            <div class="mem-chip-sub" classList={{ open: expanded() }}>
              {summary()}
            </div>
          </Show>
        </div>
        <Show when={busy()}>
          <span class="mini-spinner" />
        </Show>
        <Show when={!busy() && canUndo()}>
          <button
            class="text-btn mem-chip-undo"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmUndo(true);
            }}
          >
            Undo
          </button>
        </Show>
        <Icon name={expanded() ? 'chevron_up' : 'chevron_down'} size={20} color="var(--on-surface-variant)" title={expanded() ? 'Hide what was written' : 'Show what was written'} />
      </div>
      <Collapse when={expanded()}>
        <div class="mem-chip-body">
          <For each={fields()}>
            {([label, value]) => (
              <div class="mem-chip-field">
                <span class="mem-chip-label">{label}</span>
                <span>{value}</span>
              </div>
            )}
          </For>
          <Show when={info().text}>
            <div class="mem-chip-text">{info().text}</div>
          </Show>
        </div>
      </Collapse>
      <Dialog
        open={confirmUndo()}
        onClose={() => setConfirmUndo(false)}
        title="Undo this memory change?"
        actions={
          <>
            <button class="text-btn" onClick={() => setConfirmUndo(false)}>
              Cancel
            </button>
            <button class="text-btn strong" style={{ color: 'var(--error)' }} onClick={() => void undo()}>
              Undo
            </button>
          </>
        }
      >
        {undoText()}
      </Dialog>
    </div>
  );
}
