import { DOCUMENT_ROLE, mergeDocumentMarkdown, type PageInk, type TextBox } from '@inkwright/core';

/**
 * Document bodies (docs/VAULT_FORMAT.md › Documents) are single text boxes that can hold a whole
 * report, so the page merge's rule for text boxes — "edited on both sides: one side wins" — would
 * throw away a device's writing. Here a body edited on both sides is merged block by block
 * against the base instead (`mergeDocumentMarkdown`): paragraphs changed on different devices
 * both survive, and a paragraph changed differently on both is kept twice.
 *
 * `merged` is the page merge's result; only bodies present in all three versions and changed on
 * both sides are touched. Pure.
 */
export function mergeDocumentBodies(base: PageInk | null, local: PageInk, remote: PageInk, merged: TextBox[] | undefined): TextBox[] | undefined {
  if (!base || !merged?.some((t) => t.role === DOCUMENT_ROLE)) return merged;
  const find = (p: PageInk, id: string) => p.texts?.find((t) => t.id === id);
  return merged.map((t) => {
    if (t.role !== DOCUMENT_ROLE) return t;
    const o = find(base, t.id), l = find(local, t.id), r = find(remote, t.id);
    if (!o || !l || !r || l.text === r.text || l.text === o.text || r.text === o.text) return t;
    return { ...t, text: mergeDocumentMarkdown(o.text, l.text, r.text) };
  });
}
