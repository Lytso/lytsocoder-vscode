// The controls strip's popovers (ControlsStrip.tsx), made for a desktop like the model picker (ModelSheet.tsx): anchored
// to the chip, opening upward (the strip sits above the composer; downward when there is no room), in the picker's look
// (modelpicker.css .mp-pop / .mp-head / .mp-row / .mp-foot). Holds a select chip's options, the subagents list, or an
// info chip's details card (ChipDetailsView: context window, prompt cache, usage limits).
import { createMemo, createSignal, For, on, onCleanup, type ParentProps, Show, createEffect } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { AgentKind } from '@shared/model';
import type { ChipDetailsView, DetailTone } from '@shared/protocol';
import { Icon } from '../ui/primitives';
import { AgentMark } from './AgentStatus';
import { agentLabel } from '../util/format';
import '../styles/chippop.css';

type Pos = { left: number; top?: number; bottom?: number; width: number; maxHeight: number; up: boolean; originX: number };

/**
 * A popover anchored to `anchor`: above it, its left edge on the anchor's, inside the window. Escape or a click outside
 * closes it (a click on the anchor is left to the anchor: it toggles). While open, ↑ ↓ Enter go to `onKey` wherever the
 * focus is.
 */
export function ChipPopover(
  props: ParentProps<{
    anchor: HTMLElement | null | undefined;
    open: boolean;
    /** 'gone': the anchor left the page. */
    onClose: (how: 'escape' | 'outside' | 'gone') => void;
    width: number;
    label: string;
    accent?: string;
    onKey?: (e: KeyboardEvent) => void;
  }>,
) {
  const [pos, setPos] = createSignal<Pos | null>(null);
  let el: HTMLDivElement | undefined;

  const place = () => {
    const a = props.anchor;
    // the chip is gone (the strip changed): nothing to point at
    if (!a || !a.isConnected) return props.onClose('gone');
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(props.width, vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const above = r.top - 14;
    const below = vh - r.bottom - 14;
    const up = above >= 220 || above >= below;
    const originX = Math.max(12, Math.min(width - 12, r.left + r.width / 2 - left));
    setPos(
      up
        ? { left, bottom: vh - r.top + 6, width, maxHeight: Math.max(120, above), up, originX }
        : { left, top: r.bottom + 6, width, maxHeight: Math.max(120, below), up, originX },
    );
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return setPos(null);
        place();
        const outside = (e: PointerEvent) => {
          const t = e.target as Node;
          if (el?.contains(t) || props.anchor?.contains(t)) return;
          props.onClose('outside');
        };
        const keys = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            props.onClose('escape');
          } else if (props.onKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') && !e.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            props.onKey(e);
          }
        };
        // the strip scrolls sideways: follow the chip (not the popover's own list)
        const scrolled = (e: Event) => el?.contains(e.target as Node) || place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', scrolled, true);
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', keys, true);
        onCleanup(() => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', scrolled, true);
          document.removeEventListener('pointerdown', outside, true);
          document.removeEventListener('keydown', keys, true);
        });
      },
    ),
  );

  return (
    <Show when={props.open && pos()}>
      {(p) => (
        <Portal>
          <div
            ref={el}
            class="mp-pop cp-pop"
            classList={{ down: !p().up }}
            role="dialog"
            aria-label={props.label}
            // Solid sends events from a Portal on to its parent in the component tree (the strip, the chip)
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              left: `${p().left}px`,
              top: p().top != null ? `${p().top}px` : undefined,
              bottom: p().bottom != null ? `${p().bottom}px` : undefined,
              width: `${p().width}px`,
              'max-height': `${p().maxHeight}px`,
              'transform-origin': `${p().originX}px ${p().up ? 'bottom' : 'top'}`,
              '--accent': props.accent,
            }}
          >
            {props.children}
          </div>
        </Portal>
      )}
    </Show>
  );
}

/** The popover's header: agent mark, title, the agent's name (or a subtitle) under it, and what goes on the right. */
export function PopHead(props: ParentProps<{ agent: AgentKind; title: string; sub?: string | null }>) {
  return (
    <div class="mp-head cp-head">
      <AgentMark agent={props.agent} size={22} />
      <div class="cp-titles">
        <span class="mp-title cp-title">{props.title}</span>
        <span class="cp-sub">{props.sub || agentLabel(props.agent)}</span>
      </div>
      {props.children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ details card

export function toneColor(t: DetailTone | undefined, accent: string): string | undefined {
  switch (t) {
    case 'ok':
      return 'var(--success)';
    case 'warn':
      return 'var(--warning)';
    case 'error':
      return 'var(--danger)';
    case 'muted':
      return 'var(--on-surface-variant)';
    case 'accent':
      return accent;
    default:
      return undefined;
  }
}

// the stacked bar's colors when the agent sends none (the theme's, so light and dark both work)
const PALETTE = [
  'var(--claude)',
  'var(--agy)',
  'var(--success)',
  'var(--warning)',
  'var(--codex)',
  'var(--danger)',
  'var(--accent-teal)',
  'color-mix(in srgb, var(--on-surface) 45%, transparent)',
];

const pctText = (v: number, total: number) => {
  const p = total > 0 ? (v / total) * 100 : 0;
  return p > 0 && p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
};
const shortNum = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/**
 * An info chip's card: title + subtitle, the headline figure, the stacked bar with its legend (like Claude Code's own
 * context usage view), meters, label / value rows, a note and buttons. `details` null = still waiting for the agent.
 */
export function ChipDetailsCard(props: { details: ChipDetailsView | null; agent: AgentKind; title: string; accent: string; onAction: (id: string) => void }) {
  const d = () => props.details;
  const loading = () => !d() || !!d()!.loading;
  const hasBody = () => {
    const x = d();
    return !!x && !!(x.error || x.headline || x.breakdown?.parts.length || x.meters?.length || x.rows?.length);
  };
  return (
    <>
      <PopHead agent={props.agent} title={d()?.title || props.title} sub={d()?.subtitle}>
        <Show when={loading() && hasBody()}>
          <span class="cp-spin" title="Updating" />
        </Show>
      </PopHead>
      <div class="cd-body">
        <Show
          when={hasBody()}
          fallback={
            <div class="cd-wait">
              <span class="cp-spin" />
              <span>{loading() ? 'Reading…' : 'Nothing to show.'}</span>
            </div>
          }
        >
          <Show when={d()!.error}>
            <div class="cd-error">
              <Icon name="error_o" size={15} />
              <span>{d()!.error}</span>
            </div>
          </Show>
          <Show when={d()!.headline}>
            {(h) => (
              <div class="cd-headline">
                <span class="cd-value" style={{ color: toneColor(h().tone, props.accent) }}>
                  {h().value}
                </span>
                <Show when={h().caption}>
                  <span class="cd-caption">{h().caption}</span>
                </Show>
              </div>
            )}
          </Show>
          <Show when={d()!.breakdown?.parts.length}>
            <Breakdown b={d()!.breakdown!} />
          </Show>
          <Show when={d()!.meters?.length}>
            <div class="cd-meters">
              <For each={d()!.meters}>
                {(m) => {
                  const used = () => Math.max(0, Math.min(1, m.used));
                  const fill = () => toneColor(m.tone, props.accent) ?? (used() >= 0.9 ? 'var(--danger)' : used() >= 0.75 ? 'var(--warning)' : props.accent);
                  return (
                    <div class="cd-meter">
                      <span class="cd-meter-label">{m.label}</span>
                      <span class="cd-meter-text" style={{ color: toneColor(m.tone, props.accent) }}>
                        {m.text || `${Math.round(used() * 100)}%`}
                      </span>
                      <span class="cd-meter-bar">
                        <span style={{ width: `${used() * 100}%`, background: fill() }} />
                      </span>
                      <Show when={m.detail}>
                        <span class="cd-meter-detail">{m.detail}</span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={d()!.rows?.length}>
            <div class="cd-rows">
              <For each={d()!.rows}>
                {(r) => (
                  <>
                    <span class="cd-row-label">{r.label}</span>
                    <span class="cd-row-value" style={{ color: toneColor(r.tone, props.accent) }}>
                      {r.value}
                    </span>
                  </>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={d()?.note || d()?.actions?.length}>
        <div class="mp-foot cp-foot">
          <Show when={d()!.note}>
            <span class="cp-note">{d()!.note}</span>
          </Show>
          <Show when={d()!.actions?.length}>
            <span class="cd-actions">
              <For each={d()!.actions}>
                {(a) => (
                  <button class="cd-action" classList={{ primary: !!a.primary }} onClick={() => props.onAction(a.id)}>
                    {a.label}
                  </button>
                )}
              </For>
            </span>
          </Show>
        </div>
      </Show>
    </>
  );
}

/** One stacked bar (a part's share of `total`; `free` parts and what is left show the empty track) and its legend. */
function Breakdown(props: { b: NonNullable<ChipDetailsView['breakdown']> }) {
  const parts = createMemo(() => {
    let n = 0;
    const list = props.b.parts.map((p) => ({ ...p, value: Math.max(0, p.value), color: p.free ? null : p.color || PALETTE[n++ % PALETTE.length] }));
    const total = Math.max(props.b.total, list.reduce((s, p) => s + p.value, 0));
    return { list, total };
  });
  return (
    <div class="cd-breakdown">
      <div class="cd-stack" role="img" aria-label={parts().list.map((p) => `${p.label} ${p.text || shortNum(p.value)}`).join(', ')}>
        <For each={parts().list}>
          {(p) => (
            <Show when={p.value > 0}>
              <span
                style={{ width: `${(p.value / Math.max(1, parts().total)) * 100}%`, background: p.color ?? 'transparent' }}
                title={`${p.label}: ${p.text || shortNum(p.value)}`}
              />
            </Show>
          )}
        </For>
      </div>
      <div class="cd-legend">
        <For each={parts().list}>
          {(p) => (
            <div class="cd-leg">
              <span class="cd-swatch" classList={{ free: !!p.free }} style={{ background: p.color ?? undefined }} />
              <span class="cd-leg-label">{p.label}</span>
              <span class="cd-leg-val">{p.text || shortNum(p.value)}</span>
              <span class="cd-leg-pct">{pctText(p.value, parts().total)}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
