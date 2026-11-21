// Settings → STEM & diagrams (port of ui/settings/StemRenderingScreen.kt) as a host page ('stem'): download the bundle
// (size shown first, then the progress), switch each kind of block on or off, tell agents about them, remove it, and
// the guide (a page the view draws with the chat's own renderer, so its examples render live).
import type { SettingItem, SettingsPage } from '../../../shared/protocol';
import { tildePath } from '../paths';
import { BUNDLE_SIZE, BUNDLE_TAG, COMPONENTS, type RenderBundle } from './bundle';

const mb = (bytes: number) => (bytes <= 0 ? '0 MB' : `${(bytes / 1_048_576).toFixed(1)} MB`);

/** The page the view draws itself for the guide (webview/src/components/DocPage.tsx). */
export const STEM_GUIDE_PAGE = 'local:doc:stem-guide';

export function stemSettingsPage(b: RenderBundle): SettingsPage {
  b.refresh();
  const installed = b.installed();
  const s = b.status;
  const bundleItems: SettingItem[] = [
    {
      kind: 'info',
      id: 'stem.bundle',
      label: `${BUNDLE_TAG} · ${mb(BUNDLE_SIZE)} download`,
      value: installed ? 'Installed' : 'Not installed',
      tone: installed ? 'ok' : 'muted',
      description:
        "SmilesDrawer, function-plot, JSXGraph, Matter.js and TikZJax (TeX with circuitikz, pgfplots, chemfig), at fixed versions, from AntiGem's GitHub release. " +
        `Checked against a fixed checksum, then kept in ${tildePath(b.root)}.`,
    },
    {
      kind: 'info',
      id: 'stem.heavy',
      label: 'Heavier chats',
      value: '',
      tone: 'warn',
      description:
        'Each diagram block runs in its own frame, and TikZ pictures run TeX in the chat (a few seconds and a lot of memory the first time, one at a time; ' +
        "after that they're saved). Chats with many diagrams can scroll less smoothly. Switch off what you don't use below.",
    },
  ];
  if (s.kind === 'downloading') {
    const pct = s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0;
    bundleItems.push(
      { kind: 'info', id: 'stem.progress', label: `Downloading ${mb(s.done)} of ${mb(s.total)}`, value: `${pct}%`, tone: 'muted' },
      { kind: 'button', id: 'stem.cancel', label: 'Cancel' },
    );
  } else if (s.kind === 'extracting') {
    bundleItems.push({ kind: 'info', id: 'stem.progress', label: 'Unpacking…', value: '', tone: 'muted' });
  } else {
    if (s.kind === 'failed') bundleItems.push({ kind: 'info', id: 'stem.error', label: s.message, value: '', tone: 'error' });
    if (installed) {
      const cache = b.cacheBytes();
      bundleItems.push(
        {
          kind: 'button',
          id: 'stem.remove',
          label: 'Remove',
          style: 'danger',
          confirm: 'Remove the bundle? Blocks that need it show as code until you download it again. Compiled TikZ pictures are removed too.',
        },
        { kind: 'button', id: 'stem.clearCache', label: `Clear TikZ cache (${mb(cache)})`, disabled: cache <= 0 },
      );
    } else {
      bundleItems.push({ kind: 'button', id: 'stem.download', label: s.kind === 'failed' ? 'Try again' : 'Download bundle', style: 'primary' });
    }
  }

  const active = new Set(b.active().map((c) => c.id));
  const promptText = !b.tellAgents() ? '(off: nothing is sent)' : (b.promptSection() ?? '(nothing switched on)');
  return {
    id: 'stem',
    title: 'STEM & diagrams',
    sections: [
      {
        id: 'stem.bundle',
        title: 'Offline bundle',
        description:
          'Extra blocks for study notes in chats: chemistry, molecules, graphs, geometry, physics simulations and TikZ figures (circuits, ' +
          'free-body diagrams, optics). Everything runs on this PC, offline.',
        items: bundleItems,
      },
      {
        id: 'stem.use',
        title: 'What to use',
        description:
          "All off at first. Switched off: the block shows as code, and agents aren't told about it." +
          (installed ? '' : ' Download the bundle to switch on the parts that need it.'),
        items: COMPONENTS.map((c) => {
          const note = !c.fromBundle ? `${c.library} · built in, no download` : !installed ? `${c.library} ${c.version} · needs the bundle` : `${c.library} ${b.version(c)}`;
          return {
            kind: 'toggle' as const,
            id: `stem.on.${c.id}`,
            label: c.title,
            description: `${c.summary} · ${note}`,
            value: active.has(c.id),
            // bundle parts can be switched on only once the bundle is downloaded
            disabled: c.fromBundle && !installed,
          };
        }),
      },
      {
        id: 'stem.agents',
        title: '',
        items: [
          {
            kind: 'toggle',
            id: 'stem.tell',
            label: 'Tell agents about these blocks',
            description:
              'Global context · first message of each chat. A short list of the blocks that work here, with their exact versions, so agents use them ' +
              "in their answers, and where the full guide is on this PC (they read it only when needed). Chats get it again when it changes. Jarvis doesn't get it.",
            value: b.tellAgents(),
          },
          { kind: 'text', id: 'stem.prompt', label: 'Exactly what is sent', value: promptText, multiline: true, rows: 8, disabled: true },
        ],
      },
      {
        id: 'stem.guide',
        title: '',
        items: [{ kind: 'page', id: STEM_GUIDE_PAGE, label: 'Guide: syntax and live examples', icon: 'description' }],
      },
    ],
  };
}

/** settingChange on the page; false when it is not one of its items. */
export function stemChange(b: RenderBundle, id: string, value: unknown): boolean {
  if (id === 'stem.tell') {
    b.setTellAgents(value === true);
    return true;
  }
  if (id.startsWith('stem.on.')) {
    b.setEnabled(id.slice('stem.on.'.length), value === true);
    return true;
  }
  return false;
}

/** settingAction on the page: a toast text, '' when handled silently, null when not its item. */
export function stemAction(b: RenderBundle, id: string): string | null {
  switch (id) {
    case 'stem.download':
      b.download();
      return '';
    case 'stem.cancel':
      b.cancel();
      return '';
    case 'stem.remove':
      b.remove();
      return 'Bundle removed';
    case 'stem.clearCache':
      b.clearCache();
      return 'TikZ cache cleared';
    default:
      return null;
  }
}
