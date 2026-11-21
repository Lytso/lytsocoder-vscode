// Settings → STEM & diagrams (port of data/render/RenderBundle.kt): one zip from AntiGem's GitHub release, pinned by
// size and SHA-256 (anything else is refused), unpacked into ~/.antigem/render/<tag> and served to the chat's STEM blocks
// by the local preview server (src/core/preview/server.ts). Which parts render (all off until switched on; bundle parts
// only once it is downloaded), what agents are told in the first message, and the compiled TikZ pictures.
// Not ported: the app's offline Mermaid (the extension bundles Mermaid itself, see webview/src/components/Mermaid.tsx).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { version as MERMAID_VERSION } from 'mermaid/package.json';
import type { HostToView, RenderStateView, ViewToHost } from '../../../shared/protocol';
import type { PreviewServer } from '../preview/server';
import type { KeyValueStore, Logger } from '../types';
import { downloadFile, extractZip } from '../archive';
import { GUIDE_TEMPLATE } from './guide';
import { prepareTikz, stemKindOf, stemPage, tikzCompilePage, tikzSvgPage, type PageOptions } from './pages';

// ------------------------------------------------------------------ the pinned bundle

export const BUNDLE_TAG = 'render-v1';
const ZIP_NAME = 'antigem-render-bundle-v1.zip';
export const BUNDLE_URL = `https://github.com/Santoshkurmi/antigem/releases/download/${BUNDLE_TAG}/${ZIP_NAME}`;
/** SHA-256 of ZIP_NAME as built by the app's scripts/render_bundle/build_render_bundle.sh: anything else is refused. */
const BUNDLE_SHA256 = 'c5e97bbeba24d2970c8c4a7ad502ac8c4292b9ef3db5eac64287913ce954f34a';
/** Its size in bytes (progress when the server sends no length, and shown before downloading). */
export const BUNDLE_SIZE = 9_736_582;
/** What the TikZ bundle adds to TikZJax's own packages. */
const TIKZ_EXTRAS = 'circuitikz 1.0, pgfplots 1.18.1, chemfig 1.4, tikz-cd 1.0, amsmath, amssymb';

/**
 * RenderComponent: the parts of chat rendering that can be turned on: chemistry `\ce{}` (KaTeX's mhchem, always
 * available) and the blocks that need the bundle. [version] is exactly what the bundle carries (told to the model).
 */
export interface RenderComponent {
  id: 'chem' | 'smiles' | 'functionplot' | 'jsxgraph' | 'matter' | 'tikz';
  title: string;
  summary: string;
  library: string;
  version: string;
  fromBundle: boolean;
}

export const COMPONENTS: RenderComponent[] = [
  { id: 'chem', title: 'Chemical equations', summary: '\\ce{…} reactions and formulas inside $…$, drawn by KaTeX', library: 'mhchem syntax', version: 'built in', fromBundle: false },
  { id: 'smiles', title: 'Molecule structures', summary: '```smiles blocks: 2D structures from SMILES strings', library: 'SmilesDrawer', version: '2.4.1', fromBundle: true },
  { id: 'functionplot', title: 'Function plots', summary: '```functionplot blocks: graphs, derivatives, tangents, areas', library: 'function-plot', version: '1.26.0', fromBundle: true },
  { id: 'jsxgraph', title: 'Interactive geometry', summary: '```jsxgraph blocks: draggable geometry, loci, graphs', library: 'JSXGraph', version: '1.14.3', fromBundle: true },
  { id: 'matter', title: 'Physics simulations', summary: '```matter blocks: 2D rigid-body simulations you can drag', library: 'Matter.js', version: '0.20.0', fromBundle: true },
  {
    id: 'tikz',
    title: 'TikZ, circuits & figures',
    summary: '```tikz blocks: TikZ, circuitikz, pgfplots, chemfig, tikz-cd (TeX, compiled once and cached)',
    library: 'TikZJax',
    version: '1.0.0-beta24',
    fromBundle: true,
  },
];

export type RenderStatus =
  | { kind: 'idle' }
  | { kind: 'downloading'; done: number; total: number }
  | { kind: 'extracting' }
  | { kind: 'failed'; message: string };

/** The view messages this module answers (host.ts hands them over). */
export type RenderViewMsg = Extract<ViewToHost, { type: 'requestRender' | 'stemPage' | 'stemSvg' }>;

const MAX_SVG = 4 * 1024 * 1024;

export class RenderBundle {
  /** ~/.antigem/render: the bundle (one folder per tag) and cache/tikz. */
  readonly root: string;
  status: RenderStatus = { kind: 'idle' };
  private installedNow = false;
  /** Versions from the installed bundle's manifest.json (the same as COMPONENTS for render-v1). */
  private versions: Record<string, string> = {};
  private abort: AbortController | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private store: KeyValueStore,
    private log: Logger,
    private preview: () => PreviewServer | null,
    root = path.join(os.homedir(), '.antigem', 'render'),
  ) {
    this.root = root;
    this.refresh();
  }

  /** The state changed (install progress, a switch): settings pages and chats follow. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------ paths

  /** Where the current bundle is unpacked. */
  bundleDir(): string {
    return path.join(this.root, BUNDLE_TAG);
  }

  /** Compiled TikZ pictures (SVG), kept across bundle updates until cleared. */
  tikzCacheDir(): string {
    return path.join(this.root, 'cache', 'tikz');
  }

  /** The full syntax guide agents can read (written when the bundle is installed). */
  guideFile(): string {
    return path.join(this.bundleDir(), 'GUIDE.md');
  }

  // ------------------------------------------------------------------ state

  /** Reads what is on disk again (the folder may have been removed by hand) and rewrites the guide. */
  refresh() {
    const was = this.installedNow;
    this.installedNow = fs.existsSync(path.join(this.bundleDir(), '.complete'));
    this.versions = {};
    if (this.installedNow) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.bundleDir(), 'manifest.json'), 'utf8')) as { components?: Record<string, { version?: string }> };
        for (const [id, c] of Object.entries(m.components ?? {})) if (typeof c?.version === 'string') this.versions[id] = c.version;
      } catch {
        /* the constants then */
      }
      try {
        this.writeGuide();
      } catch (e) {
        this.log(`[render] guide: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (was !== this.installedNow) this.changed();
  }

  installed(): boolean {
    return this.installedNow;
  }

  /** The components switched on (whether or not the bundle is there). */
  enabled(): string[] {
    return this.store.get<string[]>('render.enabled') ?? [];
  }

  /** What renders right now: switched on, and installed when it needs the bundle. */
  active(): RenderComponent[] {
    const on = this.enabled();
    return COMPONENTS.filter((c) => on.includes(c.id) && (!c.fromBundle || this.installedNow));
  }

  isActive(id: string): boolean {
    return this.active().some((c) => c.id === id);
  }

  /** The exact version of a component (the bundle's manifest when installed). */
  version(c: RenderComponent): string {
    return c.fromBundle ? (this.versions[c.id] ?? c.version) : c.version;
  }

  setEnabled(id: string, on: boolean) {
    const c = COMPONENTS.find((x) => x.id === id);
    if (!c) return;
    if (on && c.fromBundle && !this.installedNow) throw new Error('Download the bundle first');
    const list = this.enabled().filter((x) => x !== id);
    this.store.set('render.enabled', on ? [...list, id] : list);
    this.changed();
  }

  /** Tell agents (not Jarvis) in the first message which of these blocks this chat renders. */
  tellAgents(): boolean {
    return this.store.get<boolean>('render.tellAgents') !== false;
  }

  setTellAgents(on: boolean) {
    this.store.set('render.tellAgents', on);
    this.changed();
  }

  /** What chats render (sent to every view). */
  view(): RenderStateView {
    return { installed: this.installedNow, active: this.active().map((c) => c.id) };
  }

  cacheBytes(): number {
    const walk = (dir: string): number => {
      let n = 0;
      let list: fs.Dirent[];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const e of list) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) n += walk(p);
        else if (e.isFile()) n += fs.statSync(p).size;
      }
      return n;
    };
    return walk(path.join(this.root, 'cache'));
  }

  clearCache() {
    fs.rmSync(path.join(this.root, 'cache'), { recursive: true, force: true });
    this.changed();
  }

  // ------------------------------------------------------------------ install / remove

  private setStatus(s: RenderStatus) {
    this.status = s;
    this.changed();
  }

  busy(): boolean {
    return this.abort != null;
  }

  /** Downloads and unpacks the bundle in the background (the settings page shows the progress). */
  download() {
    if (this.abort) return;
    const ac = new AbortController();
    this.abort = ac;
    void this.install(ac).finally(() => {
      if (this.abort === ac) this.abort = null;
      this.changed();
    });
  }

  cancel() {
    this.abort?.abort(new Error('cancelled'));
    this.abort = null;
    this.setStatus({ kind: 'idle' });
  }

  /** Removes the bundle and the compiled TikZ pictures (RenderBundle.remove: everything under the root). */
  remove() {
    if (this.abort) this.cancel();
    this.installedNow = false;
    this.versions = {};
    for (const name of fs.existsSync(this.root) ? fs.readdirSync(this.root) : []) fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
    this.changed();
  }

  private async install(ac: AbortController) {
    const part = path.join(this.root, `${ZIP_NAME}.part`);
    const staging = path.join(this.root, `${BUNDLE_TAG}.tmp`);
    try {
      fs.mkdirSync(this.root, { recursive: true });
      this.setStatus({ kind: 'downloading', done: 0, total: BUNDLE_SIZE });
      let shown = 0;
      let shownAt = 0;
      const got = await downloadFile(BUNDLE_URL, part, {
        signal: ac.signal,
        onProgress: (done, total) => {
          // more than the pinned size: not the bundle (stop instead of filling the disk)
          if (done > BUNDLE_SIZE) ac.abort(new Error("The downloaded file isn't the expected bundle (checksum mismatch). Try again later."));
          if (done - shown > 128 * 1024 && Date.now() - shownAt > 200) {
            shown = done;
            shownAt = Date.now();
            this.setStatus({ kind: 'downloading', done, total: total > 0 ? total : BUNDLE_SIZE });
          }
        },
      });
      if (got.size !== BUNDLE_SIZE || got.sha256.toLowerCase() !== BUNDLE_SHA256) {
        throw new Error("The downloaded file isn't the expected bundle (checksum mismatch). Try again later.");
      }
      this.setStatus({ kind: 'extracting' });
      await new Promise((r) => setImmediate(r));
      fs.rmSync(staging, { recursive: true, force: true });
      extractZip(part, staging);
      if (!fs.existsSync(path.join(staging, 'manifest.json'))) throw new Error('The bundle has no manifest.json');
      const target = this.bundleDir();
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      // older bundles (other tags) go; the TikZ cache stays
      for (const name of fs.readdirSync(this.root)) {
        const p = path.join(this.root, name);
        if (name !== BUNDLE_TAG && name !== 'cache' && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      }
      fs.writeFileSync(path.join(target, '.complete'), BUNDLE_TAG);
      this.refresh();
      this.log(`[render] ${BUNDLE_TAG} installed in ${target}`);
      this.setStatus({ kind: 'idle' });
    } catch (e) {
      const reason = ac.signal.reason;
      if (ac.signal.aborted && reason instanceof Error && reason.message === 'cancelled') return; // cancel() set idle
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[render] install failed: ${message}`);
      this.setStatus({ kind: 'failed', message });
    } finally {
      fs.rmSync(part, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ the guide and what agents are told

  /** The guide's text (the settings page shows it before the bundle is installed too). */
  guideText(): string {
    return GUIDE_TEMPLATE.replace(/\{\{BUNDLE_DIR\}\}/g, this.bundleDir()).replace(/\{\{MERMAID_VERSION\}\}/g, MERMAID_VERSION);
  }

  /** Written next to the bundle, where agents can read it. */
  private writeGuide() {
    const f = this.guideFile();
    if (!fs.existsSync(path.dirname(f))) return;
    const text = this.guideText();
    let old: string | null = null;
    try {
      old = fs.readFileSync(f, 'utf8');
    } catch {
      old = null;
    }
    if (old !== text) fs.writeFileSync(f, text);
  }

  /**
   * The first-message section for normal chats (not Jarvis): the blocks this chat renders, with exact versions, and
   * where the full guide is. Null when there is nothing to tell. (Agents run on this PC: they can always read it.)
   */
  promptSection(): string | null {
    if (!this.tellAgents()) return null;
    const active = this.active();
    // nothing switched on: nothing to tell (every part starts off)
    if (!active.length) return null;
    const on = (id: RenderComponent['id']) => active.find((c) => c.id === id);
    const v = (id: RenderComponent['id']) => this.version(COMPONENTS.find((c) => c.id === id)!);
    const lines: string[] = [];
    if (on('chem'))
      lines.push(
        '- Chemistry: `\\ce{...}` (mhchem syntax) inside `$...$` or `$$...$$`, e.g. `$\\ce{N2 + 3H2 <=>[Fe][450 °C] 2NH3}$`, `$\\ce{SO4^2-}$`, `$\\ce{CuSO4*5H2O}$`; units: `\\pu{25 kJ/mol}`',
      );
    if (on('smiles')) lines.push(`- \`\`\`smiles: one molecule per line: a SMILES string, then an optional caption (SmilesDrawer ${v('smiles')})`);
    if (on('functionplot'))
      lines.push(`- \`\`\`functionplot: function-plot ${v('functionplot')} options as JSON without \`target\`, e.g. \`{"data":[{"fn":"x^3-3x"},{"fn":"3x^2-3","color":"red"}]}\``);
    if (on('jsxgraph'))
      lines.push(
        `- \`\`\`jsxgraph: JavaScript for JSXGraph ${v('jsxgraph')}; \`board\` is ready (boundingbox [-6,6,6,-6], axes) unless you call \`JXG.JSXGraph.initBoard('box', {...})\` yourself; first line \`// height: 300\` sets the height`,
      );
    if (on('matter'))
      lines.push(
        `- \`\`\`matter: JavaScript for Matter.js ${v('matter')}; \`Matter\`, \`engine\`, \`world\`, \`render\`, \`runner\`, \`width\`, \`height\` are ready and it starts itself (don't call Render.run / Runner.run); mouse dragging works`,
      );
    if (on('tikz'))
      lines.push(
        `- \`\`\`tikz: a \`tikzpicture\` / \`circuitikz\` picture, compiled by TeX (TikZJax ${v('tikz')}); \`\\usepackage\` / \`\\usetikzlibrary\` lines allowed; packages: ${TIKZ_EXTRAS}`,
      );
    // Mermaid always renders (bundled with the extension)
    lines.push(`- \`\`\`mermaid: Mermaid ${MERMAID_VERSION} (offline)`);
    let out = `## Extra blocks this chat renders (AntiGem ${BUNDLE_TAG})\n` + lines.join('\n');
    if (this.installedNow && fs.existsSync(this.guideFile())) out += `\nFull syntax, examples and limits: ${this.guideFile()} (read it before writing a block you are unsure of).`;
    return out;
  }

  // ------------------------------------------------------------------ the chat's STEM blocks

  /** The view's STEM messages: what renders, a block's page, a TikZ picture TeX compiled. */
  handle(msg: RenderViewMsg, post: (m: HostToView) => void) {
    if (msg.type === 'requestRender') {
      // another VS Code window may have downloaded or removed the bundle
      this.refresh();
      post({ type: 'renderState', state: this.view() });
      return;
    }
    let url: string | null = null;
    let tikz: 'svg' | 'compile' | null = null;
    let error: string | null = null;
    try {
      const srv = this.preview();
      if (!srv) throw new Error('Previews are not available here');
      const kind = stemKindOf(msg.kind);
      if (!kind || !this.isActive(kind)) throw new Error('Switched off in Settings → STEM & diagrams');
      const o: PageOptions = { base: srv.folder(this.bundleDir()), dark: msg.dark, fg: msg.fg ?? null, fullscreen: msg.type === 'stemPage' && msg.full === true };
      if (kind !== 'tikz') {
        url = srv.html(stemPage(kind, msg.code, o, BUNDLE_TAG));
      } else {
        const p = prepareTikz(msg.code, BUNDLE_TAG);
        const file = path.join(this.tikzCacheDir(), `${p.key}.svg`);
        if (msg.type === 'stemSvg') {
          if (!msg.svg.trimStart().startsWith('<svg') || msg.svg.length > MAX_SVG) throw new Error('Not a picture');
          fs.mkdirSync(this.tikzCacheDir(), { recursive: true });
          fs.writeFileSync(file, msg.svg);
        }
        let svg: string | null = null;
        try {
          svg = fs.readFileSync(file, 'utf8');
        } catch {
          svg = null;
        }
        if (svg != null) {
          url = srv.html(tikzSvgPage(svg, o));
          tikz = 'svg';
        } else {
          url = srv.html(tikzCompilePage(p, o));
          tikz = 'compile';
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    post({ type: 'stemPage', reqId: msg.reqId, url, tikz, error });
  }
}
