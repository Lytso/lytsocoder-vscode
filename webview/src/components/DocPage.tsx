// A settings page that shows a guide the host writes in Markdown ('local:doc:<id>'), drawn by the chat's own renderer:
// the STEM & diagrams guide (its examples render live, as StemRenderingScreen's StemGuideDialog does) and EGM's "How to
// use EGM" (EgmGuideCard).
import { createResource, Show } from 'solid-js';
import { requestDoc } from '../state/render';
import { MarkdownContent } from './Markdown';

export const DOC_PAGE_PREFIX = 'local:doc:';

export function DocPage(props: { id: string }) {
  const [doc] = createResource(() => props.id, (id) => requestDoc(id));
  return (
    <div class="settings-content doc-page">
      <Show when={!doc.loading} fallback={<div class="settings-loading"><span class="head-spinner" /></div>}>
        <Show when={doc()} fallback={<div class="hint">Nothing to show.</div>}>
          <MarkdownContent text={doc()!} />
        </Show>
      </Show>
    </div>
  );
}
