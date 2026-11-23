// StemBlockView / TikzBody / StemFullscreenDialog from ui/components/StemBlocks.kt: a ```smiles, ```functionplot,
// ```jsxgraph, ```matter or ```tikz block as a card like the Mermaid one: the block's label, Diagram / Code pills,
// restart (simulations), copy and expand. The diagram is a frame with the page the host builds (src/core/render/pages.ts)
// on the local preview server (the webview's CSP blocks scripts in frames it makes itself), as tall as its content.
// TikZ runs TeX once (one picture at a time) and the host caches the SVG. A part that is switched off in Settings →
// STEM & diagrams, or whose bundle is not downloaded, shows the block as code.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon, IconButton, nextFrame } from '../ui/primitives';
import { CodeBlock } from './CodeBlock';
import { copyText } from '../state/store';
import { renderActive, stemPageUrl, stemSvgUrl } from '../state/render';
import { themeMode } from '../theme';
import '../styles/mermaid.css';
import '../styles/stem.css';

export type StemKind = 'smiles' | 'functionplot' | 'jsxgraph' | 'matter' | 'tikz';

const KINDS: Record<StemKind, { label: string; title: string; lang: string }> = {
  smiles: { label: 'MOLECULE', title: 'Molecule structures', lang: 'smiles' },
  functionplot: { label: 'FUNCTION PLOT', title: 'Function plots', lang: 'functionplot' },
  jsxgraph: { label: 'GEOMETRY', title: 'Interactive geometry', lang: 'jsxgraph' },
  matter: { label: 'SIMULATION', title: 'Physics simulations', lang: 'matter' },
  tikz: { label: 'TIKZ', title: 'TikZ, circuits & figures', lang: 'tikz' },
};

/** StemKind.fromLang: the STEM block a fenced code block's language names, or null. */
export function stemKindOf(lang: string): StemKind | null {
  const l = lang.trim().toLowerCase();
  if (l === 'smiles') return 'smiles';
  if (l === 'functionplot' || l === 'function-plot' || l === 'function_plot') return 'functionplot';
  if (l === 'jsxgraph') return 'jsxgraph';
  if (l === 'matter' || l === 'matterjs' || l === 'matter-js' || l === 'matter.js') return 'matter';
  if (l === 'tikz' || l === 'circuitikz' || l === 'tikzpicture') return 'tikz';
  return null;
}

const DIM = 'color-mix(in srgb, var(--on-surface) 60%, transparent)';
const DIM70 = 'color-mix(in srgb, var(--on-surface) 70%, transparent)';

/** The chat's text color, for the page (captions, axes). */
const ink = () => getComputedStyle(document.body).getPropertyValue('--on-surface').trim() || null;

/** A STEM block: the card when its part renders here, else ordinary code. */
export function StemBlock(props: { kind: StemKind; code: string }) {
  return (
    <Show when={renderActive(props.kind)} fallback={<CodeBlock code={props.code} lang={KINDS[props.kind].lang} complete />}>
      <StemCard kind={props.kind} code={props.code} />
    </Show>
  );
}

function Pills(props: { tab: number; onTab: (t: number) => void }) {
  return (
    <div class="mmd-tabs" role="tablist">
      <button class="mmd-tab" classList={{ on: props.tab === 0 }} role="tab" aria-selected={props.tab === 0} onClick={() => props.onTab(0)}>
        Diagram
      </button>
      <button class="mmd-tab" classList={{ on: props.tab === 1 }} role="tab" aria-selected={props.tab === 1} onClick={() => props.onTab(1)}>
        Code
      </button>
    </div>
  );
}

function StemCard(props: { kind: StemKind; code: string }) {
  const [tab, setTab] = createSignal(0); // 0 = Diagram, 1 = Code
  const [copied, setCopied] = createSignal(false);
  const [full, setFull] = createSignal(false);
  const [restart, setRestart] = createSignal(0);
  // TikZ: the compiled picture's page once known (fullscreen shows it without compiling again)
  const [svgUrl, setSvgUrl] = createSignal<string | null>(null);
  let copyTimer: number | undefined;
  onCleanup(() => clearTimeout(copyTimer));
  const copy = () => {
    copyText(props.code, 'Code copied');
    setCopied(true);
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => setCopied(false), 2500);
  };
  return (
    <div class="mmd-card stem-card">
      <div class="mmd-head">
        <Icon name="science" size={15} color="var(--primary)" />
        <span class="mmd-title">{KINDS[props.kind].label}</span>
        <span class="mmd-spacer" />
        <Pills tab={tab()} onTab={setTab} />
        <Show when={props.kind === 'matter' && tab() === 0}>
          <IconButton icon="restart" size={28} iconSize={15} color={DIM} title="Restart" onClick={() => setRestart((n) => n + 1)} />
        </Show>
        <IconButton icon={copied() ? 'check' : 'copy'} size={28} iconSize={15} color={copied() ? 'var(--success)' : DIM} title={copied() ? 'Copied' : 'Copy'} onClick={copy} />
        <IconButton class="mmd-expand" icon="open_in_full" size={28} iconSize={15} color={DIM} title="Expand" onClick={() => setFull(true)} />
      </div>
      <div class="mmd-divider" />
      <Show when={tab() === 0} fallback={<CodeBlock code={props.code} lang={KINDS[props.kind].lang} complete />}>
        <Show when={props.kind === 'tikz'} fallback={<StemFrame kind={props.kind} code={props.code} reload={restart()} />}>
          <TikzBody code={props.code} onSvg={setSvgUrl} />
        </Show>
      </Show>
      <StemFullscreen open={full()} kind={props.kind} code={props.code} svgUrl={svgUrl()} onCopy={copy} onClose={() => setFull(false)} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ frame

/**
 * StemWebView: a block's page in a frame. Its height follows the page (48–1200 px) unless [fill]. The page reports its
 * height, a compiled TikZ picture or a TeX log with postMessage({agStem: 1, …}); only this frame's messages count.
 * [url]: a page the caller already has (a TikZ run or picture); else the block's page is asked for.
 */
function StemFrame(props: {
  kind: StemKind;
  code: string;
  url?: string | null;
  reload?: number;
  full?: boolean;
  fill?: boolean;
  onSvg?: (svg: string) => void;
  onError?: (log: string) => void;
}) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [height, setHeight] = createSignal(200);
  let frame: HTMLIFrameElement | undefined;

  createEffect(
    on([() => props.url, () => props.code, () => themeMode(), () => props.reload ?? 0], ([given, code, mode, reload]) => {
      let alive = true;
      onCleanup(() => (alive = false));
      const withReload = (u: string) => u + (reload ? `${u.includes('?') ? '&' : '?'}r=${reload}` : '');
      setError(null);
      if (given) {
        setUrl(withReload(given));
        return;
      }
      stemPageUrl(props.kind, code, mode === 'dark', ink(), !!props.full).then(
        (r) => alive && setUrl(withReload(r.url)),
        (e) => alive && (setUrl(null), setError(e instanceof Error ? e.message : String(e))),
      );
    }),
  );

  const onMessage = (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data as { agStem?: number; h?: unknown; svg?: unknown; error?: unknown } | null;
    if (!d || d.agStem !== 1) return;
    if (typeof d.h === 'number' && d.h > 0) setHeight(Math.min(1200, Math.max(48, Math.ceil(d.h))));
    if (typeof d.svg === 'string') props.onSvg?.(d.svg);
    if (typeof d.error === 'string') props.onError?.(d.error);
  };
  onMount(() => window.addEventListener('message', onMessage));
  onCleanup(() => window.removeEventListener('message', onMessage));

  return (
    <Show
      when={url()}
      keyed
      fallback={
        <Show when={error()} fallback={<div class="stem-wait" />}>
          <div class="mmd-error" title={error()!}>
            <Icon name="error_o" size={14} />
            <span class="mmd-error-text">{error()}</span>
          </div>
          <CodeBlock code={props.code} lang={KINDS[props.kind].lang} complete />
        </Show>
      }
    >
      {(u) => (
        <iframe
          ref={frame}
          class="stem-frame"
          classList={{ fill: !!props.fill }}
          style={props.fill ? undefined : { height: `${height()}px` }}
          src={u}
          sandbox="allow-scripts allow-same-origin"
          title={KINDS[props.kind].title}
        />
      )}
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ TikZ

/** One TeX run at a time (TikzQueue): each one loads the whole TeX engine into memory. */
let tikzTail: Promise<void> = Promise.resolve();
function tikzTurn(): { ready: Promise<void>; release: () => void } {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const ready = tikzTail;
  tikzTail = tikzTail.then(() => done);
  return { ready, release };
}

/** TikzBody: the cached picture when there is one, else a TeX run (queued) whose picture the host then caches. */
function TikzBody(props: { code: string; onSvg: (url: string | null) => void }) {
  const [phase, setPhase] = createSignal<'loading' | 'queued' | 'compiling' | 'done' | 'error'>('loading');
  const [url, setUrl] = createSignal<string | null>(null);
  const [log, setLog] = createSignal('');
  const [retry, setRetry] = createSignal(0);
  let finish: ((r: { svg?: string; error?: string }) => void) | null = null;

  createEffect(
    on([() => props.code, () => themeMode(), retry], ([code, mode]) => {
      let alive = true;
      let release = () => {};
      let timer: number | undefined;
      onCleanup(() => {
        alive = false;
        clearTimeout(timer);
        release();
      });
      const dark = mode === 'dark';
      const fg = ink();
      setPhase('loading');
      props.onSvg(null);
      const fail = (m: string) => {
        if (!alive) return;
        setLog(m);
        setPhase('error');
      };
      stemPageUrl('tikz', code, dark, fg).then(async (first) => {
        if (!alive) return;
        if (first.tikz === 'svg') {
          setUrl(first.url);
          props.onSvg(first.url);
          setPhase('done');
          return;
        }
        setPhase('queued');
        const turn = tikzTurn();
        release = turn.release;
        await turn.ready;
        if (!alive) return turn.release();
        setUrl(first.url);
        setPhase('compiling');
        const result = await new Promise<{ svg?: string; error?: string }>((resolve) => {
          finish = resolve;
          timer = window.setTimeout(() => resolve({ error: 'TeX took longer than 3 minutes. Simplify the picture (fewer samples / loops) and retry.' }), 180_000);
        });
        clearTimeout(timer);
        finish = null;
        turn.release();
        if (!alive) return;
        if (result.svg == null) return fail(result.error?.trim() || 'TeX failed without a log.');
        const saved = await stemSvgUrl(code, result.svg, dark, fg);
        if (!alive) return;
        setUrl(saved.url);
        props.onSvg(saved.url);
        setPhase('done');
      }).catch((e) => {
        release();
        fail(e instanceof Error ? e.message : String(e));
      });
    }),
  );

  return (
    <Show when={phase() !== 'loading'} fallback={<div class="stem-wait" />}>
      <Show when={phase() === 'done' && url()}>
        <StemFrame kind="tikz" code={props.code} url={url()} />
      </Show>
      <Show when={phase() === 'compiling' && url()}>
        <div class="stem-compiling">
          <StemFrame kind="tikz" code={props.code} url={url()} onSvg={(svg) => finish?.({ svg })} onError={(error) => finish?.({ error })} />
          <StemStatus text="Compiling with TeX… (first time takes a few seconds)" />
        </div>
      </Show>
      <Show when={phase() === 'queued'}>
        <StemStatus text="Waiting for another TikZ picture to finish…" />
      </Show>
      <Show when={phase() === 'error'}>
        <div class="stem-error">
          <div class="stem-error-title">Couldn't compile this TikZ picture</div>
          <pre class="stem-log">{log().split('\n').slice(-25).join('\n')}</pre>
          <button class="text-btn" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      </Show>
    </Show>
  );
}

function StemStatus(props: { text: string }) {
  return (
    <div class="stem-status">
      <span class="mini-spinner" />
      <span>{props.text}</span>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ fullscreen

/** StemFullscreenDialog: mounted while open (and while it fades out). */
function StemFullscreen(props: { open: boolean; kind: StemKind; code: string; svgUrl: string | null; onCopy: () => void; onClose: () => void }) {
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
          nextFrame(() => props.open && setShown(true));
        } else {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 160);
        }
      },
      { defer: true },
    ),
  );
  // Escape closes this view only (a fullscreen CodeBlock opened from the Code tab sits above it and closes first)
  const onKey = (e: KeyboardEvent) => {
    if (!props.open || e.key !== 'Escape' || document.querySelector('.code-full')) return;
    e.stopPropagation();
    props.onClose();
  };
  onMount(() => document.addEventListener('keydown', onKey, true));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
  });
  return (
    <Show when={mounted()}>
      <Portal>
        <FullView {...props} shown={shown()} />
      </Portal>
    </Show>
  );
}

function FullView(props: { shown: boolean; kind: StemKind; code: string; svgUrl: string | null; onCopy: () => void; onClose: () => void }) {
  const [tab, setTab] = createSignal(0);
  const [reload, setReload] = createSignal(0);
  return (
    <div
      class="mmd-full"
      classList={{ shown: props.shown }}
      role="dialog"
      aria-modal="true"
      aria-label={KINDS[props.kind].title}
      // Solid sends events from a Portal on to its parent in the component tree (the card, the message): stop here
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div class="mmd-full-bar">
        <IconButton icon="close" size={36} iconSize={24} color="var(--on-surface)" title="Close" onClick={props.onClose} />
        <span class="mmd-full-title">{KINDS[props.kind].title}</span>
        <span class="mmd-spacer" />
        <Pills tab={tab()} onTab={setTab} />
        <Show when={tab() === 0}>
          <IconButton icon="restart" size={32} iconSize={18} color={DIM70} title="Reload" onClick={() => setReload((n) => n + 1)} />
        </Show>
        <IconButton icon="copy" size={36} iconSize={18} color={DIM70} title="Copy" onClick={props.onCopy} />
      </div>
      <div class="mmd-full-divider" />
      <Show
        when={tab() === 0}
        fallback={
          <div class="mmd-full-code">
            <CodeBlock code={props.code} lang={KINDS[props.kind].lang} complete />
          </div>
        }
      >
        <div class="stem-full-body">
          <Show
            when={props.kind !== 'tikz'}
            fallback={
              <Show when={props.svgUrl} fallback={<div class="stem-full-msg">The picture is still compiling.</div>}>
                <StemFrame kind="tikz" code={props.code} url={props.svgUrl} reload={reload()} fill />
              </Show>
            }
          >
            <StemFrame kind={props.kind} code={props.code} reload={reload()} full fill />
          </Show>
        </div>
      </Show>
    </div>
  );
}
