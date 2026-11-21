// Read-only texts for VS Code's diff editor (`vscode.diff` needs two URIs): a project checkpoint's copy of a file
// against the file now (src/core/checkpoints, Platform.openDiff). Kept in memory while VS Code runs (the newest 50).
import * as vscode from 'vscode';

const SCHEME = 'antigem-diff';
const KEEP = 50;

export function diffDocs(context: vscode.ExtensionContext) {
  const texts = new Map<string, string>();
  let n = 0;
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: (uri) => texts.get(uri.path) ?? '' }));
  // the file name stays last in the path: the editor picks its language from it
  const put = (side: string, name: string, text: string) => {
    const p = `/${++n}/${side}/${name}`;
    texts.set(p, text);
    while (texts.size > KEEP) texts.delete(texts.keys().next().value!);
    return vscode.Uri.from({ scheme: SCHEME, path: p });
  };
  return (title: string, left: { path?: string | null; text?: string | null }, right: { text: string; name: string }) => {
    const l = left.path ? vscode.Uri.file(left.path) : put('now', right.name, left.text ?? '');
    const r = put('checkpoint', right.name, right.text);
    void vscode.commands.executeCommand('vscode.diff', l, r, title, { preview: true });
  };
}
