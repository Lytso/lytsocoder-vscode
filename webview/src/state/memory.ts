// Agent memory in the view (src/core/memory on the host): the memory chips ask the host what became of their block
// (memoryRequest → memoryResult) and ask again whenever memories changed (memoryChanged). Also the app's
// MemoryBlocks helpers: read a block the way the bridge does, and a reply without its blocks (Copy).
import { createRoot, createSignal } from 'solid-js';
import type { MemoryAppliedView } from '@shared/protocol';
import { host } from '../host';

export const MEMORY_LANG = 'antigem-memory';

const [changes, setChanges] = createRoot(() => createSignal(0));
/** Bumps when memories changed (a reply saved one, an Undo, the settings) or memory was switched on / off. */
export const memoryChanges = changes;

export interface MemoryAnswer {
  applied: MemoryAppliedView | null;
  /** Agent memory is on. */
  enabled: boolean;
  error: string | null;
}

const waiting = new Map<string, (a: MemoryAnswer) => void>();
let seq = 0;

host.onMessage((m) => {
  if (m.type === 'memoryChanged') setChanges((n) => n + 1);
  else if (m.type === 'memoryResult') {
    const cb = waiting.get(m.reqId);
    waiting.delete(m.reqId);
    cb?.({ applied: m.applied, enabled: m.enabled, error: m.error ?? null });
  }
});

/** What became of the block [body] (`applied`), or undo what it did (`undo`). Null when the host did not answer. */
export function memoryRequest(op: 'applied' | 'undo', body: string): Promise<MemoryAnswer | null> {
  const reqId = `mem-${Date.now().toString(36)}-${++seq}`;
  return new Promise((resolve) => {
    waiting.set(reqId, resolve);
    host.send({ type: 'memoryRequest', reqId, op, body });
    setTimeout(() => {
      if (waiting.delete(reqId)) resolve(null);
    }, 20_000);
  });
}

const BLOCK = new RegExp('^[ \\t]*```' + MEMORY_LANG + '[^\\n]*\\n[\\s\\S]*?^[ \\t]*```[ \\t]*$\\n?', 'gm');

/** A reply without its memory blocks (what "Copy" puts on the clipboard). */
export function stripMemoryBlocks(text: string): string {
  return text.includes(MEMORY_LANG) ? text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n') : text;
}

export interface MemoryBlockInfo {
  file: string;
  description: string;
  delete: boolean;
  /** always | passive | '' (not given) */
  mode: string;
  /** global | project | '' (not given) */
  scope: string;
  /** The memory's text (after "---"). */
  text: string;
}

const KNOWN_KEYS = new Set(['file', 'name', 'mode', 'scope', 'description', 'delete']);

/** What the block asks for, read the way the bridge reads it ("key: value" lines, then "---", then the text). */
export function parseMemoryBlock(body: string): MemoryBlockInfo {
  const info: MemoryBlockInfo = { file: '', description: '', delete: false, mode: '', scope: '', text: '' };
  const lines = body.replace(/\r/g, '').trim().split('\n');
  let textFrom = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') {
      textFrom = i + 1;
      break;
    }
    if (!line) continue;
    const c = line.indexOf(':');
    const k = c >= 0 ? line.slice(0, c).trim().toLowerCase() : '';
    if (!KNOWN_KEYS.has(k)) {
      textFrom = i;
      break;
    }
    const v = line.slice(c + 1).trim();
    const lv = v.toLowerCase();
    if (k === 'file' || k === 'name') info.file = v;
    else if (k === 'description') info.description = v;
    else if (k === 'delete') info.delete = lv === 'true' || lv === 'yes';
    else if (k === 'mode')
      info.mode = ['always', 'pinned', 'default', 'always-on'].includes(lv) ? 'always' : ['passive', 'on-demand', 'on demand', 'relevant'].includes(lv) ? 'passive' : '';
    else if (k === 'scope')
      info.scope = ['global', 'all', 'all projects', 'user', 'everywhere'].includes(lv)
        ? 'global'
        : ['project', 'this project', 'local'].includes(lv)
          ? 'project'
          : '';
  }
  info.file = info.file.replace(/\.md$/, '');
  if (textFrom < lines.length) info.text = lines.slice(textFrom).join('\n').trim();
  return info;
}
