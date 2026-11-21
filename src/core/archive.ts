// Downloads and ZIP extraction for what AntiGem installs by itself (Settings → STEM & diagrams' render bundle, Settings →
// Agents → EGM): a streamed download with progress and its SHA-256, and an unzip that refuses any entry that would land
// outside its folder (ports of the ZipInputStream loops in RenderBundle.kt / EgmManager.kt). No dependencies.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Sent to GitHub with every request (its API refuses requests without one). */
export const USER_AGENT = 'AntiGem-VSCode';

/** A GET with the User-Agent; 403 = GitHub's hourly limit (EgmManager.httpGet). */
export async function httpGet(url: string, accept?: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...(accept ? { Accept: accept } : {}) },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (res.status === 403) throw new Error('GitHub refused the request (HTTP 403, maybe its hourly limit). Try again later.');
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  return res.text();
}

/**
 * Streams [url] into [file]. [onProgress](done, total): total 0 = the server sent no length. Stops when [signal] aborts,
 * or when nothing arrives for a minute.
 */
export async function downloadFile(
  url: string,
  file: string,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ size: number; sha256: string }> {
  const ac = new AbortController();
  const stop = () => ac.abort(opts.signal?.reason);
  if (opts.signal?.aborted) stop();
  opts.signal?.addEventListener('abort', stop, { once: true });
  // connect 20 s, then at most a minute without data (OkHttp's timeouts in the app)
  let idle = setTimeout(() => ac.abort(new Error('The download stalled. Try again.')), 20_000);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(new Error('The download stalled. Try again.')), 60_000);
  };
  const out = fs.createWriteStream(file);
  let writeError: Error | null = null;
  out.on('error', (e) => (writeError = e));
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0) || 0;
    const hash = createHash('sha256');
    let done = 0;
    const reader = res.body.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      touch();
      hash.update(r.value);
      done += r.value.length;
      if (writeError) throw writeError;
      if (!out.write(r.value)) {
        await new Promise<void>((resolve) => {
          const go = () => {
            out.off('drain', go);
            out.off('error', go);
            resolve();
          };
          out.on('drain', go);
          out.on('error', go);
        });
      }
      opts.onProgress?.(done, total);
    }
    await new Promise<void>((resolve) => out.end(resolve));
    if (writeError) throw writeError;
    return { size: done, sha256: hash.digest('hex') };
  } catch (e) {
    out.destroy();
    // the abort's reason (cancel, stall) instead of a bare "This operation was aborted"
    if (ac.signal.aborted && ac.signal.reason instanceof Error) throw ac.signal.reason;
    throw e;
  } finally {
    clearTimeout(idle);
    opts.signal?.removeEventListener('abort', stop);
  }
}

/** SHA-256 of a file (hex). */
export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Nothing this unpacks is near this big: a larger total is refused (a ZIP bomb). */
const MAX_TOTAL = 1024 * 1024 * 1024;

/**
 * Unpacks [zipFile] into [target] (created). An entry that would land outside it stops everything; links are skipped;
 * every file is checked against its CRC. Returns the number of files written.
 */
export function extractZip(zipFile: string, target: string): number {
  const buf = fs.readFileSync(zipFile);
  // the end of central directory record: the last PK\5\6 in the final 64 KB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const base = path.resolve(target);
  fs.mkdirSync(base, { recursive: true });
  let written = 0;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged ZIP file');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;

    const out = path.resolve(base, name);
    if (name.includes('\0') || (out !== base && !out.startsWith(base + path.sep))) throw new Error(`Unsafe path in the download: ${name}`);
    if (name.endsWith('/') || name.endsWith('\\')) {
      fs.mkdirSync(out, { recursive: true });
      continue;
    }
    if ((mode & 0o170000) === 0o120000) continue; // a symbolic link
    if (flags & 0x1) throw new Error(`Encrypted entry in the download: ${name}`);
    total += size;
    if (total > MAX_TOTAL) throw new Error('The download unpacks to more than 1 GB');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Damaged ZIP file');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = size === 0 ? Buffer.alloc(0) : zlib.inflateRawSync(raw, { maxOutputLength: size });
    else throw new Error(`Unsupported compression in the download: ${name}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`Damaged file in the download: ${name}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    written++;
  }
  return written;
}
