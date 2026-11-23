// The pages of the STEM blocks (StemHtml + TikzSource from ui/components/StemBlocks.kt). Each block runs in its own frame
// served by the local preview server; `<base>` points at the bundle folder there, so the libraries load with the same
// relative paths as in the app. Instead of the app's `AG` JavaScript interface a page tells the chat its height, a
// compiled TikZ picture or a TeX log with parent.postMessage({agStem: 1, …}).
import { createHash } from 'node:crypto';

/** The STEM blocks a fenced code block can be (by its language): StemKind. */
export type StemKind = 'smiles' | 'functionplot' | 'jsxgraph' | 'matter' | 'tikz';

export function stemKindOf(lang: string): StemKind | null {
  switch (lang.trim().toLowerCase()) {
    case 'smiles':
      return 'smiles';
    case 'functionplot':
    case 'function-plot':
    case 'function_plot':
      return 'functionplot';
    case 'jsxgraph':
      return 'jsxgraph';
    case 'matter':
    case 'matterjs':
    case 'matter-js':
    case 'matter.js':
      return 'matter';
    case 'tikz':
    case 'circuitikz':
    case 'tikzpicture':
      return 'tikz';
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------------ TikZ source

/** A TikZ block made ready for TikZJax: preamble lines turned into its data attributes, used packages added. */
export interface TikzPrepared {
  body: string;
  packages: Record<string, string>;
  libraries: string[];
  preamble: string;
  /** Cache key of the compiled picture. */
  key: string;
}

// TikZJax loads tikz and xcolor (svgnames) itself: asking again (other options) would clash
const BUILT_IN = new Set(['tikz', 'xcolor', 'pgf']);
const USE_PACKAGE = /^\\usepackage\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/;
const USE_LIBRARY = /^\\usetikzlibrary\s*\{([^}]*)\}/;

/** TikzSource.prepare */
export function prepareTikz(code: string, bundleTag: string): TikzPrepared {
  const packages: Record<string, string> = {};
  const libraries = new Set<string>();
  let preamble = '';
  let body = '';
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim();
    const up = USE_PACKAGE.exec(line);
    const lib = USE_LIBRARY.exec(line);
    if (up) {
      for (const p of up[2].split(',').map((s) => s.trim())) if (p && !BUILT_IN.has(p)) packages[p] = (up[1] ?? '').trim();
    } else if (lib) {
      for (const l of lib[1].split(',').map((s) => s.trim())) if (l) libraries.add(l);
    } else if (line.startsWith('\\documentclass') || line === '\\begin{document}' || line === '\\end{document}') {
      // dropped
    } else if (/^\\(pgfplotsset|definecolor|newcommand|renewcommand|ctikzset)/.test(line)) {
      preamble += raw + '\n';
    } else {
      body += raw + '\n';
    }
  }
  const all = body + preamble;
  const need = (pkg: string, ...marks: string[]) => {
    if (!(pkg in packages) && marks.some((m) => all.includes(m))) packages[pkg] = '';
  };
  need('circuitikz', 'circuitikz', '\\ctikzset', 'to[R', 'to[C', 'to[L', 'to[battery', 'to[V', 'to[I');
  need('pgfplots', '\\begin{axis}', '\\addplot', '\\pgfplotsset', '\\begin{semilogxaxis}', '\\begin{loglogaxis}', '\\begin{polaraxis}');
  need('chemfig', '\\chemfig', '\\setchemfig', '\\schemestart');
  need('tikz-cd', '\\begin{tikzcd}');
  need('tikz-3dplot', '\\tdplot');
  need('amsmath', '\\text{', '\\dfrac', '\\tfrac', '\\boxed', '\\begin{align', '\\binom', '\\operatorname');
  need('amssymb', '\\mathbb', '\\therefore', '\\because', '\\checkmark');
  if ('pgfplots' in packages && !preamble.includes('compat=')) preamble = '\\pgfplotsset{compat=1.18}\n' + preamble;
  const p = { body: body.trim(), packages, libraries: [...libraries], preamble: preamble.trim() };
  const key = createHash('sha1')
    .update([p.body, JSON.stringify(p.packages), p.libraries.join(','), p.preamble, bundleTag].join('\0'))
    .digest('hex');
  return { ...p, key };
}

// ------------------------------------------------------------------------------------------------ pages

/** A JS string literal that is safe inside <script>. */
const js = (s: string) => JSON.stringify(s).replace(/<\//g, '<\\/').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface PageOptions {
  /** The bundle folder's address on the preview server (ends with /). */
  base: string;
  dark: boolean;
  /** Text color of the chat (a CSS color); the app's own when absent. */
  fg?: string | null;
  fullscreen?: boolean;
}

/** Only a plain color goes into the page's CSS. */
const safeColor = (c: string | null | undefined) =>
  c && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(c.trim()) ? c.trim() : null;

// Offline like the app's WebViews (RenderBundle.webViewClient(allowNetwork = false)): only the bundle (this server)
// loads; the block's code cannot call out. TeX runs as WebAssembly in a worker.
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:";

function shell(o: PageOptions, head: string, body: string, script: string, code: string): string {
  const fg = safeColor(o.fg) ?? (o.dark ? '#ECECF1' : '#1A1A1A');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<base href="${attr(o.base)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
/* the chat's color-scheme: a frame whose scheme differs from its <iframe>'s gets an opaque background */
html,body{margin:0;padding:0;background:transparent;color:${fg};font:14px system-ui,-apple-system,sans-serif;overflow-x:hidden}
html{color-scheme:${o.dark ? 'dark' : 'light'}}
#err{display:none;white-space:pre-wrap;color:#e5534b;font:12px/1.4 monospace;padding:8px 10px;margin:0}
.paper{background:#fff;border-radius:10px}
</style>
${head}
</head><body>
${body}
<pre id="err"></pre>
<script>
function __post(m){try{m.agStem=1;parent.postMessage(m,'*')}catch(e){}}
function __h(){__post({h:Math.ceil(document.body.getBoundingClientRect().height)})}
function __fail(m){var e=document.getElementById('err');e.style.display='block';e.textContent=String(m&&m.message?m.message:m);__h();}
window.addEventListener('error',function(ev){__fail(ev.message||'Script error')});
window.addEventListener('load',__h);
try{new ResizeObserver(__h).observe(document.body)}catch(e){}
var CODE=${code};var DARK=${o.dark};var FULL=${!!o.fullscreen};
function __height(def){var m=CODE.match(/^\\s*\\/\\/\\s*height\\s*[:=]\\s*(\\d+)/m);if(FULL)return Math.max(200,window.innerHeight-16);return m?Math.min(+m[1],900):def;}
</script>
${script}
</body></html>`;
}

/** StemHtml.page: the page of one block (TikZ: its TeX run). */
export function stemPage(kind: StemKind, code: string, o: PageOptions, bundleTag: string): string {
  switch (kind) {
    case 'smiles':
      return shell(
        o,
        `<script src="smiles/smiles-drawer.min.js"></script>
<style>#wrap{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:8px}figure{margin:0;text-align:center}figcaption{font-size:12.5px;opacity:.8;margin-top:2px}.bad{color:#e5534b;font:12px monospace;padding:6px}</style>`,
        `<div id="wrap"></div>`,
        `<script>
(function(){
 var lines=CODE.split('\\n').map(function(s){return s.trim()}).filter(function(s){return s&&s.indexOf('//')!==0});
 var W=Math.min(window.innerWidth-20,lines.length>1&&!FULL?260:420),H=Math.round(W*0.72);
 var drawer=new SmilesDrawer.SvgDrawer({width:W,height:H});
 var wrap=document.getElementById('wrap');
 lines.forEach(function(line){
  var sp=line.search(/\\s/),smi=sp<0?line:line.slice(0,sp),cap=sp<0?'':line.slice(sp).trim();
  var fig=document.createElement('figure');
  var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('width',W);svg.setAttribute('height',H);
  fig.appendChild(svg);
  if(cap){var c=document.createElement('figcaption');c.textContent=cap;fig.appendChild(c);}
  wrap.appendChild(fig);
  try{
   SmilesDrawer.parse(smi,function(tree){try{drawer.draw(tree,svg,DARK?'dark':'light');}catch(e){bad(e)}__h();},bad);
  }catch(e){bad(e)}
  function bad(err){svg.remove();var p=document.createElement('div');p.className='bad';p.textContent='Invalid SMILES "'+smi+'": '+(err&&err.message?err.message:err);fig.insertBefore(p,fig.firstChild);__h();}
 });
 __h();
})();
</script>`,
        js(code),
      );
    case 'functionplot': {
      const ink = o.dark ? '#c9c9d1' : '#333';
      const grid = o.dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)';
      return shell(
        o,
        `<script src="functionplot/function-plot.js"></script>
<style>#plot{padding:6px 4px}
.function-plot text{fill:${ink}!important}
.function-plot .domain,.function-plot .tick line{stroke:${ink}!important}
.function-plot .grid .tick line{stroke:${grid}!important}
.function-plot .title{fill:${ink}!important}</style>`,
        `<div id="plot"></div>`,
        `<script>
(function(){
 var o;
 try{o=JSON.parse(CODE)}catch(e){try{o=(new Function('return ('+CODE+')'))()}catch(e2){__fail('Not valid JSON: '+e.message);return;}}
 if(Array.isArray(o))o={data:o};
 if(!o.data&&(o.fn||o.fnType))o={data:[o]};
 var W=window.innerWidth-12;
 o.target='#plot';o.width=W;
 if(FULL)o.height=Math.max(220,window.innerHeight-24);else if(!o.height)o.height=Math.round(Math.min(W*0.75,360));
 if(o.grid===undefined)o.grid=true;
 try{functionPlot(o)}catch(e){__fail(e)}
 __h();
})();
</script>`,
        js(code),
      );
    }
    case 'jsxgraph':
      return shell(
        o,
        `<link rel="stylesheet" href="jsxgraph/jsxgraph.css"><script src="jsxgraph/jsxgraphcore.js"></script>
<style>#box{margin:6px auto;border:none}</style>`,
        `<div id="box" class="jxgbox paper"></div>`,
        `<script>
(function(){
 var W=window.innerWidth-12,H=__height(Math.min(W,380));
 var box=document.getElementById('box');box.style.width=W+'px';box.style.height=H+'px';
 var board=null;
 // in the chat the mouse wheel scrolls the chat: wheel zoom needs Shift there (not in fullscreen)
 if(!/initBoard\\s*\\(/.test(CODE)){
  board=JXG.JSXGraph.initBoard('box',{boundingbox:[-6,6,6,-6],axis:true,keepAspectRatio:true,showCopyright:false,showNavigation:true,
   pan:{enabled:true,needTwoFingers:true,needShift:false},zoom:{enabled:true,wheel:true,needShift:!FULL,pinch:true}});
 }
 // a block of its own: the code may declare its own \`board\`
 try{(new Function('JXG','board','{\\n'+CODE+'\\n}'))(JXG,board)}catch(e){__fail(e)}
 __h();
})();
</script>`,
        js(code),
      );
    case 'matter':
      return shell(
        o,
        `<script src="matter/matter.min.js"></script><style>#stage{display:flex;justify-content:center;padding:6px}canvas{border-radius:10px;touch-action:none}</style>`,
        `<div id="stage"></div>`,
        `<script>
(function(){
 var W=window.innerWidth-12,H=__height(Math.round(Math.min(W*0.8,360)));
 var stage=document.getElementById('stage');
 if(/Engine\\.create\\s*\\(/.test(CODE)){
  // the code sets up its own engine and renderer: give it the size and the element, and let it run itself
  try{(new Function('Matter','width','height','element','{\\n'+CODE+'\\n}'))(Matter,W,H,stage)}catch(e){__fail(e)}
  __h();return;
 }
 var engine=Matter.Engine.create(),world=engine.world;
 var render=Matter.Render.create({element:stage,engine:engine,
  options:{width:W,height:H,wireframes:false,background:DARK?'#16161a':'#fafafa',pixelRatio:window.devicePixelRatio||1}});
 var runner=Matter.Runner.create();
 var mouse=Matter.Mouse.create(render.canvas);
 Matter.Composite.add(world,Matter.MouseConstraint.create(engine,{mouse:mouse,constraint:{stiffness:0.2,render:{visible:false}}}));
 render.mouse=mouse;
 try{(new Function('Matter','engine','world','render','runner','width','height','{\\n'+CODE+'\\n}'))(Matter,engine,world,render,runner,W,H)}catch(e){__fail(e)}
 Matter.Render.run(render);Matter.Runner.run(runner,engine);
 __h();
})();
</script>`,
        js(code),
      );
    case 'tikz':
      return tikzCompilePage(prepareTikz(code, bundleTag), o);
  }
}

const tikzStyle = (dark: boolean) => `<link rel="stylesheet" href="tikzjax/fonts.css">
<style>#out{display:flex;justify-content:center;padding:10px;overflow-x:auto}#out svg{max-width:100%;height:auto}
${dark ? '#out svg{filter:invert(.88) hue-rotate(180deg)}' : ''}</style>`;

/** Runs TeX on the block (TikZJax) and reports the SVG, or the end of the TeX log when it fails. */
export function tikzCompilePage(p: TikzPrepared, o: PageOptions): string {
  const body = p.body.replace(/<\/script/gi, '<\\/script');
  const data =
    (Object.keys(p.packages).length ? ` data-tex-packages="${attr(JSON.stringify(p.packages))}"` : '') +
    (p.libraries.length ? ` data-tikz-libraries="${attr(p.libraries.join(','))}"` : '') +
    (p.preamble ? ` data-add-to-preamble="${attr(p.preamble)}"` : '');
  return shell(
    { ...o, fullscreen: false },
    tikzStyle(o.dark) +
      `
<script>var __log=[];console.log=function(){try{__log.push(Array.prototype.join.call(arguments,' '));if(__log.length>300)__log.shift();}catch(e){}};</script>
<script src="tikzjax/tikzjax.js"></script>`,
    `<div id="out"><script type="text/tikz" data-show-console="true" data-disable-cache="true"${data}>\n${body}\n</script></div>`,
    `<script>
document.addEventListener('tikzjax-load-finished',function(ev){var t=ev.target;if(t&&t.tagName&&t.tagName.toLowerCase()==='svg'){__post({svg:t.outerHTML})}__h();});
new MutationObserver(function(){if(document.querySelector('#out img')){__post({error:__log.slice(-60).join('\\n')})}}).observe(document.getElementById('out'),{childList:true,subtree:true});
</script>`,
    js(p.body),
  );
}

/** A compiled TikZ picture: only its SVG and the TeX fonts (no TeX engine). */
export function tikzSvgPage(svg: string, o: PageOptions): string {
  return shell({ ...o, fullscreen: false }, tikzStyle(o.dark), `<div id="out">${svg}</div>`, '', '""');
}
