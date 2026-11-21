// Settings → STEM & diagrams in the view (src/core/render on the host): which parts render now, the pages of STEM
// blocks (the host builds them and serves them from the local preview server), and KaTeX's mhchem for \ce{…} / \pu{…}
// (loaded the first time chemistry is switched on: the app's ChemNotation, done by the reference mhchem instead).
import { createRoot, createSignal } from 'solid-js';
import type { HostToView, RenderStateView } from '@shared/protocol';
import { host } from '../host';

const [state, setState] = createRoot(() => createSignal<RenderStateView>({ installed: false, active: [] }));

/** What chats render now (the host sends it on start and whenever it changes). */
export const renderState = state;

/** This part renders now (switched on, and downloaded when it needs the bundle). */
export const renderActive = (id: string) => state().active.includes(id);

// ------------------------------------------------------------------ chemistry (KaTeX mhchem)

const [chemLoaded, setChemLoaded] = createRoot(() => createSignal(false));
let chemLoading: Promise<void> | null = null;

function loadChem() {
  if (chemLoading) return;
  // mhchem registers \ce and \pu on the KaTeX the chat already uses
  chemLoading = import('katex')
    .then(() => import('katex/contrib/mhchem'))
    .then(() => {
      setChemLoaded(true);
    })
    .catch(() => {
      chemLoading = null;
    });
}

/** \ce / \pu render now: chemistry is switched on and mhchem is loaded (a reactive read). */
export function chemReady(): boolean {
  const on = renderActive('chem');
  if (on && !chemLoaded()) loadChem();
  return on && chemLoaded();
}

/** The formula uses chemistry notation. */
export const isChem = (tex: string) => /\\(?:ce|pu)\s*\{/.test(tex);

// ------------------------------------------------------------------ requests

const pages = new Map<string, (m: Extract<HostToView, { type: 'stemPage' }>) => void>();
const docs = new Map<string, Array<(md: string | null) => void>>();

host.onMessage((m) => {
  if (m.type === 'renderState') setState(m.state);
  else if (m.type === 'init') host.send({ type: 'requestRender' });
  else if (m.type === 'stemPage') {
    const cb = pages.get(m.reqId);
    pages.delete(m.reqId);
    cb?.(m);
  } else if (m.type === 'doc') {
    const cbs = docs.get(m.id) ?? [];
    docs.delete(m.id);
    for (const cb of cbs) cb(m.markdown);
  }
});
// the view was (re)loaded after the host's init (a hidden editor tab shown again): ask anyway
host.send({ type: 'requestRender' });

const reqId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export interface StemPageResult {
  url: string;
  /** TikZ: the compiled picture ('svg') or the TeX run ('compile'). */
  tikz: 'svg' | 'compile' | null;
}

function ask(msg: { kind: string; code: string; dark: boolean; fg: string | null; full?: boolean; svg?: string }): Promise<StemPageResult> {
  return new Promise((resolve, reject) => {
    const id = reqId();
    pages.set(id, (r) => (r.url ? resolve({ url: r.url, tikz: r.tikz ?? null }) : reject(new Error(r.error || 'Cannot show it here'))));
    if (msg.svg != null) host.send({ type: 'stemSvg', reqId: id, kind: msg.kind, code: msg.code, svg: msg.svg, dark: msg.dark, fg: msg.fg });
    else host.send({ type: 'stemPage', reqId: id, kind: msg.kind, code: msg.code, dark: msg.dark, fg: msg.fg, full: msg.full });
  });
}

/** The page of a STEM block (TikZ: its cached picture, or the TeX run). */
export const stemPageUrl = (kind: string, code: string, dark: boolean, fg: string | null, full = false) => ask({ kind, code, dark, fg, full });

/** A TikZ picture the TeX run made: the host caches it and answers with the picture's page. */
export const stemSvgUrl = (code: string, svg: string, dark: boolean, fg: string | null) => ask({ kind: 'tikz', code, svg, dark, fg });

/** A guide the settings show, as Markdown ('stem-guide', 'egm-guide'). */
export function requestDoc(id: string): Promise<string | null> {
  return new Promise((resolve) => {
    const list = docs.get(id) ?? [];
    list.push(resolve);
    docs.set(id, list);
    if (list.length === 1) host.send({ type: 'requestDoc', id });
  });
}
