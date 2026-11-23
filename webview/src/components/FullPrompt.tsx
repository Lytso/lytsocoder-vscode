// ui/components/FullPromptDialog.kt: a user message exactly as it went to the agent, nothing hidden. The app's hidden
// parts (global context, Agent memory, slash-command and plugin expansions, the attached-files list) show with their
// tags highlighted. For debugging.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ChatMessage } from '@shared/model';
import { copyText } from '../state/store';
import { Icon, IconButton, nextFrame } from '../ui/primitives';
import { alpha } from '../util/format';
import '../styles/memory.css';

/**
 * The prompt a user message actually sent: the text before the chat collapsed its hidden parts (`sentContent`; an
 * Antigravity chat keeps it as `rawContent`, also a voice request's full prompt), else the message as stored.
 */
export function fullPromptOf(m: ChatMessage): string {
  return m.sentContent || m.rawContent || m.content;
}

const HIDDEN_TAG = /<\/?(antigem-expansion|attached-files)\b[^>]*>/g;

export function FullPromptDialog(props: { open: boolean; msg: ChatMessage; onClose: () => void }) {
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(
      () => props.open,
      (o) => {
        clearTimeout(timer);
        if (o) {
          setMounted(true);
          nextFrame(() => setShown(true));
        } else {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 160);
        }
      },
    ),
  );
  const onKey = (e: KeyboardEvent) => {
    if (props.open && e.key === 'Escape') props.onClose();
  };
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    clearTimeout(timer);
  });

  const prompt = createMemo(() => (mounted() ? fullPromptOf(props.msg) : ''));
  // the text in pieces: the hidden parts' tags stand out
  const parts = createMemo(() => {
    const p = prompt();
    const out: { t: string; tag?: boolean }[] = [];
    let last = 0;
    for (const m of p.matchAll(HIDDEN_TAG)) {
      if (m.index! > last) out.push({ t: p.slice(last, m.index) });
      out.push({ t: m[0], tag: true });
      last = m.index! + m[0].length;
    }
    if (last < p.length) out.push({ t: p.slice(last) });
    return out;
  });
  const stats = () => {
    const p = prompt();
    const hidden = (p.match(/<antigem-expansion\b/g) ?? []).length;
    let s = `${p.length.toLocaleString()} characters · ~${Math.floor((p.length + 3) / 4).toLocaleString()} tokens`;
    if (hidden) s += ` · ${hidden} hidden block${hidden === 1 ? '' : 's'}`;
    if (p.includes('<attached-files>')) s += ' · file list';
    return s;
  };
  // images and files the message carried (the chat shows them as cards; images went alongside the text)
  const attachments = () => props.msg.attachments.filter((a) => a.isImage && !a.reference).length;

  return (
    <Show when={mounted()}>
      <Portal>
        <div class="dialog-scrim fp-scrim" classList={{ shown: shown() }} onClick={(e) => (e.stopPropagation(), props.onClose())}>
          <div class="fp-dialog dialog" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div class="fp-head">
              <div class="fp-titles">
                <div class="fp-title">Full prompt</div>
                <div class="fp-stats">{stats()}</div>
              </div>
              <IconButton icon="close_o" size={36} iconSize={20} color={alpha('var(--on-surface-variant)', 0.8)} title="Close" onClick={() => props.onClose()} />
            </div>
            <div class="fp-note">
              Exactly what was sent to the agent, including the parts the chat hides.
              {attachments() > 0 ? ` ${attachments()} attachment${attachments() === 1 ? ' was' : 's were'} sent alongside (not shown).` : ''}
            </div>
            <div class="fp-text">
              <For each={parts()}>{(p) => (p.tag ? <span class="fp-tag">{p.t}</span> : p.t)}</For>
            </div>
            <div class="fp-actions">
              <button class="text-btn" onClick={() => copyText(prompt(), 'Copied the full prompt')}>
                <Icon name="copy" size={16} />
                Copy all
              </button>
              <button class="text-btn" onClick={() => props.onClose()}>
                Close
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
