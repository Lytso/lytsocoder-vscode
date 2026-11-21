// The agents' controls strips above the input (ui/claude/ClaudeChatControls.kt ClaudeControlsStrip,
// ui/codex/CodexChatUi.kt CodexControlsStrip, ui/opencode/OpenCodeChatUi.kt OpenCodeControlsStrip): a scrolling row
// of ControlChips (ClaudeUiKit.kt). The host sends the chips (ChatPatch.controls); 'select' opens its options in a
// popover above the chip (ClaudePickerSheet + PickerOption, made for a desktop like the model picker), 'toggle' flips
// on / off, 'info' opens the agent's details card (cache timer, context window, plan usage) or the agent toasts.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { Conversation } from '@shared/model';
import type { ChipDetailsView, ControlChipView } from '@shared/protocol';
import { chipDetails, openLinkedConversation, setControl, setFocusTick, state } from '../state/store';
import { agentAccent, relativeTime } from '../util/format';
import { Icon, type IconName } from '../ui/primitives';
import { hasIcon } from '../ui/iconData';
import { ChipDetailsCard, ChipPopover, PopHead } from './ChipPopover';

const MUTED = 'color-mix(in srgb, var(--on-surface) 75%, transparent)';

// Claude Code's permission modes in the app's own colors and icons (permissionModeColor / permissionModeIcon)
const MODE_COLORS: Record<string, string> = {
  plan: 'var(--accent-teal)',
  acceptEdits: 'var(--success)',
  auto: 'var(--accent-alt)',
  bypassPermissions: 'var(--danger)',
  dontAsk: 'var(--warning)',
};
const MODE_ICONS: Record<string, IconName> = {
  default: 'pan_tool',
  plan: 'map',
  acceptEdits: 'edit_note',
  auto: 'auto_mode',
  bypassPermissions: 'warning_amber',
  dontAsk: 'do_not_disturb_on',
};
const isModeChip = (c: ControlChipView) => state.chat.agent === 'CLAUDE' && /mode|permission|approval/i.test(c.id) && (c.options ?? []).some((o) => o.value in MODE_ICONS && o.value !== 'default');

// icon hints from the host → the bundled Material icons
const ICONS: Record<string, IconName> = {
  bolt: 'bolt',
  psychology: 'psychology',
  shield: 'shield',
  speed: 'speed',
  timer: 'timer',
  lightbulb: 'lightbulb_o',
  thinking: 'lightbulb_o',
  data_usage: 'data_usage',
  context: 'data_usage',
  auto_mode: 'auto_mode',
  map: 'map',
  plan: 'map',
  edit_note: 'edit_note',
  pan_tool: 'pan_tool',
  verified_user: 'verified_user',
  warning: 'warning_amber',
  warning_amber: 'warning_amber',
  play_arrow: 'play_arrow',
  build: 'build_o',
  smart_toy: 'smart_toy',
  tune: 'tune',
  schedule: 'schedule',
};
const iconOf = (hint: string | null | undefined): IconName | null =>
  !hint ? null : (ICONS[hint] ?? (hasIcon(hint) ? hint : null));

function toneColor(c: ControlChipView): string {
  if (isModeChip(c) && MODE_COLORS[c.value]) return MODE_COLORS[c.value];
  switch (c.tone) {
    case 'accent':
      return agentAccent(state.chat.agent);
    case 'success':
      return 'var(--success)';
    case 'warn':
      return 'var(--warning)';
    case 'danger':
      return 'var(--danger)';
    case 'muted':
      return 'color-mix(in srgb, var(--on-surface) 58%, transparent)';
    default:
      return MUTED;
  }
}

/** "permissionMode" / "effort" / "codex.reasoning" → "Permission mode" / "Effort" / "Reasoning" (the sheet title). */
function titleOf(c: ControlChipView): string {
  if (c.title?.trim()) return c.title.trim();
  if (c.label.includes(' · ')) return c.label.split(' · ')[0];
  if (c.label.includes(': ')) return c.label.split(': ')[0];
  const words = c.id
    .substring(c.id.lastIndexOf('.') + 1)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const focusComposer = () => setFocusTick((n) => n + 1);

/**
 * A popover closed by a click outside: the composer gets the focus back when the click left it nowhere (not when it
 * went to a field, or selected text in the chat).
 */
function refocusAfterClick() {
  const up = () => {
    document.removeEventListener('pointerup', up, true);
    setTimeout(() => {
      const a = document.activeElement;
      if ((!a || a === document.body) && (window.getSelection()?.isCollapsed ?? true)) focusComposer();
    }, 0);
  };
  document.addEventListener('pointerup', up, true);
}

/** Every subagent of the chat on screen, nested ones included (newest first). */
function chatSubagents(): Conversation[] {
  const root = state.chat.conversationId;
  if (!root) return [];
  const byParent = new Map<string, Conversation[]>();
  for (const c of state.conversations) {
    const p = c.parentConversationId;
    if (p && p !== c.id) byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  const out: Conversation[] = [];
  const seen = new Set<string>([root]);
  const walk = (id: string) => {
    for (const c of byParent.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  walk(root);
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The chat's subagents as the side bar shows them: each under the chat or subagent that started it (newest first at
 * every level), with its depth.
 */
function subagentTree(agents: Conversation[]): { conv: Conversation; depth: number; children: number }[] {
  const ids = new Set(agents.map((a) => a.id));
  const byParent = new Map<string | null, Conversation[]>();
  for (const a of agents) {
    const p = a.parentConversationId && ids.has(a.parentConversationId) ? a.parentConversationId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), a]);
  }
  const out: { conv: Conversation; depth: number; children: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of [...(byParent.get(parent) ?? [])].sort((a, b) => b.createdAt - a.createdAt)) {
      out.push({ conv: c, depth, children: byParent.get(c.id)?.length ?? 0 });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * ClaudeChatControls.SubagentsChip: "2 agents" with a green dot while some of this chat's subagents work, "0 agents"
 * with a white dot when none does. A click shows them as a tree (like the side bar) in a popover above the chip; picking
 * one opens its chat (Back returns here). ↑ ↓ move, Enter opens, Esc closes.
 */
function SubagentsChip(props: { agents: Conversation[] }) {
  const [open, setOpen] = createSignal(false);
  const [cursor, setCursor] = createSignal(0);
  let btn: HTMLButtonElement | undefined;
  const rowEls: HTMLElement[] = [];
  const running = () => props.agents.filter((a) => a.isRunning).length;
  const tree = createMemo(() => subagentTree(props.agents));
  const name = (a: Conversation) => a.subagentRole?.trim() || a.title || 'Subagent';
  const go = (i: number) => {
    const row = tree()[i];
    if (!row) return;
    setOpen(false);
    openLinkedConversation(row.conv.id);
  };
  const move = (d: number) => {
    const n = tree().length;
    if (!n) return;
    const i = (cursor() + d + n) % n;
    setCursor(i);
    rowEls[i]?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <>
      <button
        ref={btn}
        class="control-chip sub-chip"
        classList={{ live: running() > 0, open: open() }}
        title={`Subagents of this chat: ${running()} of ${props.agents.length} running`}
        onClick={() => {
          if (open()) {
            setOpen(false);
            focusComposer();
          } else {
            setCursor(0);
            setOpen(true);
          }
        }}
      >
        <span class="sub-chip-dot" />
        <span>{running() === 1 ? '1 agent' : `${running()} agents`}</span>
      </button>
      <ChipPopover
        anchor={btn}
        open={open()}
        width={360}
        label="Subagents"
        accent={agentAccent(state.chat.agent)}
        onClose={(how) => {
          setOpen(false);
          if (how === 'escape') focusComposer();
          else if (how === 'outside') refocusAfterClick();
        }}
        onKey={(e) => (e.key === 'Enter' ? go(cursor()) : move(e.key === 'ArrowDown' ? 1 : -1))}
      >
        <PopHead agent={state.chat.agent} title="Subagents" sub={props.agents.length === 1 ? '1 in this chat' : `${props.agents.length} in this chat`}>
          <span class="sub-menu-state" classList={{ live: running() > 0 }}>
            <Show when={running() > 0} fallback={<>All done</>}>
              <span class="sub-menu-state-dot" />
              {running()} running
            </Show>
          </span>
        </PopHead>
        <div class="mp-list cp-list" role="listbox">
          <For each={tree()}>
            {(row, i) => (
              <button
                ref={(el) => (rowEls[i()] = el)}
                class="sub-tree-row"
                classList={{ live: row.conv.isRunning, nested: row.depth > 0, cursor: cursor() === i() }}
                style={{ 'padding-left': `${8 + row.depth * 18}px` }}
                role="option"
                title={row.conv.subagentTypeName ? `${name(row.conv)} · ${row.conv.subagentTypeName}` : name(row.conv)}
                onPointerMove={() => cursor() !== i() && setCursor(i())}
                onClick={() => go(i())}
              >
                {/* the tree's guide lines: one per level above this row */}
                <For each={Array.from({ length: row.depth }, (_, i) => i)}>
                  {(i) => <span class="sub-tree-guide" style={{ left: `${20 + i * 18}px` }} />}
                </For>
                <span class="sub-tree-icon">
                  <Icon name={row.depth > 0 ? 'call_split' : 'smart_toy'} size={15} />
                  <Show when={row.conv.isRunning}>
                    <span class="sub-tree-live" />
                  </Show>
                </span>
                <span class="sub-tree-text">
                  <span class="sub-tree-name">{name(row.conv)}</span>
                  <span class="sub-tree-meta">
                    <Show when={row.conv.subagentTypeName?.trim()}>
                      <span class="sub-tree-type">{row.conv.subagentTypeName}</span>
                    </Show>
                    <span class="sub-tree-status">{row.conv.isRunning ? 'running' : 'done'}</span>
                    <Show when={row.children}>
                      <span class="sub-tree-kids">
                        <Icon name="call_split" size={11} />
                        {row.children}
                      </span>
                    </Show>
                  </span>
                </span>
                <span class="sub-tree-time">{relativeTime(row.conv.updatedAt)}</span>
                <Icon name="chevron_right" size={16} class="sub-tree-go" />
              </button>
            )}
          </For>
        </div>
        <div class="mp-foot">
          <span class="mp-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>⏎</kbd> open
          </span>
        </div>
      </ChipPopover>
    </>
  );
}

/** The chip the subagents chip follows (the app puts it next to thinking). */
const isThinkingChip = (c: ControlChipView) => /think/i.test(c.id) || /^(no )?thinking\b/i.test(c.label);

/** The open popover: a select chip's options, or an info chip's details card (asked for in `conversationId`). */
type OpenChip = { id: string; kind: 'select' | 'info'; conversationId: string | null };

export function ControlsStrip() {
  const subagents = createMemo(chatSubagents);
  const hasThinkingChip = () => state.chat.controls.some(isThinkingChip);
  const chipEls = new Map<string, HTMLButtonElement>();
  const [open, setOpen] = createSignal<OpenChip | null>(null);
  const chip = () => {
    const o = open();
    return o ? (state.chat.controls.find((c) => c.id === o.id) ?? null) : null;
  };
  const anchor = () => (open() ? chipEls.get(open()!.id) : undefined);
  const accent = () => agentAccent(state.chat.agent);

  // ---- an info chip's card: asked for on click; the agent answers with chipDetails (or a toast: no card)
  const [details, setDetails] = createSignal<ChipDetailsView | null>(null);
  let wait: number | undefined;
  const close = (refocus = false) => {
    clearTimeout(wait);
    setOpen(null);
    setDetails(null);
    if (refocus) focusComposer();
  };
  const closeHow = (how: 'escape' | 'outside' | 'gone') => {
    close(how === 'escape');
    if (how === 'outside') refocusAfterClick();
  };
  const showDetails = (c: ControlChipView) => {
    clearTimeout(wait);
    setDetails(null);
    setOpen({ id: c.id, kind: 'info', conversationId: state.chat.conversationId });
    setControl(c.id, 'details', false);
    // no card in time (an agent without cards toasts instead): no spinner left hanging
    wait = window.setTimeout(() => !details() && close(), 2500);
  };
  createEffect(
    on(
      chipDetails,
      (d) => {
        const o = open();
        if (!d || o?.kind !== 'info' || d.chipId !== o.id || (d.conversationId ?? null) !== o.conversationId) return;
        // a card may come twice: first `loading`, then the full one
        clearTimeout(wait);
        setDetails(d);
      },
      { defer: true },
    ),
  );
  // the agent answered with a toast while the card was still awaited
  createEffect(
    on(
      () => state.toasts.length,
      (n, prev) => {
        if (open()?.kind === 'info' && !details() && prev != null && n > prev) close();
      },
      { defer: true },
    ),
  );
  // another chat, or the chip is gone
  createEffect(on(() => state.chat.conversationId, () => open() && close(), { defer: true }));
  createEffect(() => open() && !chip() && close());
  onCleanup(() => clearTimeout(wait));

  // ---- a select chip's options: ↑ ↓ move the cursor (hover too), Enter picks
  const [cursor, setCursor] = createSignal(0);
  const optEls: HTMLElement[] = [];
  const options = () => chip()?.options ?? [];
  const moveCursor = (d: number) => {
    const n = options().length;
    if (!n) return;
    const i = (cursor() + d + n) % n;
    setCursor(i);
    optEls[i]?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i: number) => {
    const c = chip();
    const o = options()[i];
    if (!c || !o) return;
    setControl(c.id, o.value);
    close(true);
  };

  const onChip = (c: ControlChipView) => {
    if (c.disabled) return;
    if (c.kind === 'toggle') return setControl(c.id, c.value === 'on' ? 'off' : 'on');
    // the host runs it
    if (c.kind === 'action') return setControl(c.id, 'run', false);
    if (c.kind !== 'select' && c.kind !== 'info') return;
    // a second click on the open chip closes it
    if (open()?.id === c.id) return close(true);
    if (c.kind === 'info') return showDetails(c);
    if (!c.options?.length) return;
    close();
    setCursor(Math.max(0, c.options.findIndex((o) => o.value === c.value)));
    setOpen({ id: c.id, kind: 'select', conversationId: state.chat.conversationId });
  };

  return (
    <>
    <Show when={state.chat.notice}>
      <div class="controls-notice">
        <span class="conn-spinner small" style={{ 'border-color': agentAccent(state.chat.agent), 'border-right-color': 'transparent' }} />
        <span>{state.chat.notice}</span>
      </div>
    </Show>
    <Show when={state.chat.controls.length > 0 || subagents().length > 0}>
      <div class="controls-strip">
        <For each={state.chat.controls}>
          {(c) => {
            const color = () => toneColor(c);
            // a setting that differs from its default shows tinted (an info chip only colors its text)
            // an action ("Implement plan") is a tinted button; an info chip only colors its text
            const highlighted = () => c.kind === 'action' || (c.kind !== 'info' && !!c.tone && c.tone !== 'muted');
            const icon = () => (isModeChip(c) ? MODE_ICONS[c.value] : null) ?? iconOf(c.icon);
            return (
              <>
              <button
                ref={(el) => chipEls.set(c.id, el)}
                class="control-chip"
                classList={{ hl: highlighted(), info: c.kind === 'info', open: open()?.id === c.id }}
                style={{ '--chip': color() }}
                disabled={c.disabled}
                title={c.kind === 'select' ? titleOf(c) : c.kind === 'info' ? (c.title?.trim() || 'Details') : undefined}
                aria-haspopup={c.kind === 'select' || c.kind === 'info' ? 'dialog' : undefined}
                aria-expanded={c.kind === 'select' || c.kind === 'info' ? open()?.id === c.id : undefined}
                onClick={() => onChip(c)}
              >
                <Show when={icon()}>
                  <Icon name={icon()!} size={13} />
                </Show>
                <span>{c.label}</span>
              </button>
              <Show when={isThinkingChip(c) && subagents().length}>
                <SubagentsChip agents={subagents()} />
              </Show>
              </>
            );
          }}
        </For>
        {/* no thinking chip (other agents): at the end */}
        <Show when={!hasThinkingChip() && subagents().length}>
          <SubagentsChip agents={subagents()} />
        </Show>
      </div>
      {/* a select chip's options (ClaudePickerSheet as a desktop popover) */}
      <ChipPopover
        anchor={anchor()}
        open={open()?.kind === 'select' && !!chip()}
        width={340}
        label={chip() ? titleOf(chip()!) : 'Options'}
        accent={accent()}
        onClose={closeHow}
        onKey={(e) => (e.key === 'Enter' ? pick(cursor()) : moveCursor(e.key === 'ArrowDown' ? 1 : -1))}
      >
        <Show when={chip()}>
          {(c) => (
            <>
              <PopHead agent={state.chat.agent} title={titleOf(c())} />
              <div class="mp-list cp-list" role="listbox" aria-label={titleOf(c())}>
                <For each={c().options ?? []}>
                  {(o, i) => {
                    const mode = () => isModeChip(c());
                    const color = () => (mode() ? (MODE_COLORS[o.value] ?? accent()) : accent());
                    const icon = () => (mode() ? MODE_ICONS[o.value] : null) ?? iconOf(c().icon) ?? 'tune';
                    const selected = () => o.value === c().value;
                    return (
                      <div
                        ref={(el) => (optEls[i()] = el)}
                        class="mp-row"
                        classList={{ active: selected(), cursor: cursor() === i() }}
                        style={{ '--row-accent': color() }}
                        role="option"
                        aria-selected={selected()}
                        onPointerMove={() => cursor() !== i() && setCursor(i())}
                        onClick={() => pick(i())}
                      >
                        <span class="mp-check">
                          <Show when={selected()}>
                            <Icon name="check" size={15} />
                          </Show>
                        </span>
                        <span class="cp-icon">
                          <Icon name={icon()} size={15} />
                        </span>
                        <div class="mp-row-text">
                          <div class="mp-name">{o.label}</div>
                          <Show when={o.description}>
                            <div class="mp-desc" title={o.description!}>
                              {o.description}
                            </div>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
              <Show when={c().note}>
                <div class="mp-foot cp-foot">
                  <Icon name="info_o" size={14} />
                  <span class="cp-note">{c().note}</span>
                </div>
              </Show>
            </>
          )}
        </Show>
      </ChipPopover>
      {/* an info chip's details card (context window, prompt cache, usage) */}
      <ChipPopover anchor={anchor()} open={open()?.kind === 'info' && !!chip()} width={340} label={chip() ? titleOf(chip()!) : 'Details'} accent={accent()} onClose={closeHow}>
        <ChipDetailsCard
          details={details()}
          agent={state.chat.agent}
          title={chip() ? titleOf(chip()!) : 'Details'}
          accent={accent()}
          onAction={(id) => {
            const o = open();
            if (o) setControl(o.id, `action:${id}`, false);
            close(true);
          }}
        />
      </ChipPopover>
    </Show>
    </>
  );
}
