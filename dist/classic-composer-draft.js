/** Typed text, excluding app mention pills. Does not mutate the live editor.
 * Unknown pills/files/images are protected. Self-contained for CDP embedding.
 */
export function readComposerDraft(editor) {
  if (!editor) return null;
  if (String(editor.tagName || '').toUpperCase() === 'TEXTAREA') return String(editor.value || '').replace(/[\u2060\uFEFF]/g, '').trim();
  const copy = editor.cloneNode(true);
  for (const node of copy.querySelectorAll('[data-inline-selection-pill][data-symbol="ecosystemMention"][data-id^="plugin:"], [data-inline-selection-pill-cursor-target]')) node.remove();
  if (copy.querySelector('[data-inline-selection-pill], [data-inline-file-previewable], img, video, audio')) return null;
  return String(copy.textContent || '').replace(/[\u2060\uFEFF]/g, '').trim();
}
