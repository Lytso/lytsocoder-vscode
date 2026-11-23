// The checkpoint's copy of a file, from the file now and the bridge's diff (now → checkpoint), so VS Code can show the
// two side by side. The app shows the diff lines in the restore sheet (CheckpointRestoreSheet.kt DiffBlock).

/**
 * Applies a unified diff whose old side is [now] and returns the new side, or null when the diff does not fit [now]
 * (the file changed since the preview, or the diff was cut).
 */
export function applyUnifiedDiff(now: string, diff: string): string | null {
  if (/\n… \(diff cut: too long\)\n?$/.test(diff)) return null;
  const old = now.split('\n');
  const oldEndsNl = now.endsWith('\n');
  if (oldEndsNl) old.pop();
  if (now === '') old.length = 0;
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [];
  let i = 0; // next line of `old` not copied yet
  let k = lines.findIndex((l) => l.startsWith('@@'));
  if (k < 0) return null;
  let newNoNl = false;
  let oldNoNl = false;
  while (k < lines.length) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[k]);
    if (!h) return null;
    const oldStart = Number(h[1]);
    const oldCount = h[2] == null ? 1 : Number(h[2]);
    // an empty old range names the line before it
    const at = oldCount === 0 ? oldStart : oldStart - 1;
    if (at < i || at > old.length) return null;
    while (i < at) out.push(old[i++]);
    k++;
    let last = '';
    for (; k < lines.length && !lines[k].startsWith('@@'); k++) {
      const l = lines[k];
      const t = l.slice(1);
      if (l.startsWith('\\')) {
        if (last === '+' || last === ' ') newNoNl = true;
        if (last === '-' || last === ' ') oldNoNl = true;
        continue;
      }
      if (l.startsWith('+')) out.push(t);
      else if (l.startsWith('-') || l.startsWith(' ') || l === '') {
        if (old[i] !== (l === '' ? '' : t)) return null;
        if (!l.startsWith('-')) out.push(old[i]);
        i++;
      } else return null;
      last = l === '' ? ' ' : l[0];
    }
  }
  while (i < old.length) out.push(old[i++]);
  if (!out.length) return '';
  const endsNl = newNoNl ? false : oldNoNl ? true : oldEndsNl || now === '';
  return out.join('\n') + (endsNl ? '\n' : '');
}

/** The lines a diff adds (a file that comes back whole). */
export function addedText(diff: string): string | null {
  const lines = diff.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  if (start < 0) return null;
  const out: string[] = [];
  let noNl = false;
  for (const l of lines.slice(start)) {
    if (l.startsWith('+')) out.push(l.slice(1));
    else if (l.startsWith('\\')) noNl = true;
  }
  return out.join('\n') + (out.length && !noNl ? '\n' : '');
}
