/**
 * Notebooks exported as PDF from GoodNotes, Notability (and OneNote, Noteshelf, Samsung Notes…).
 * Their structure lives in the PDF itself:
 *
 * - **GoodNotes** exports a notebook as one PDF whose outline (bookmarks) holds the notebook's
 *   own outline entries, each pointing at a page; handwriting is vector paths, and pages that were
 *   OCR'd for search carry an invisible text layer.
 * - **Notability** exports one PDF per note (several notes → several PDFs, or one merged PDF with
 *   an outline entry per note).
 *
 * `planPdfSections` turns the outline into the notes to create: each top-level outline entry
 * starts a note that runs until the next entry; pages before the first entry form a lead note.
 * When the outline is one entry per page (a page-by-page index rather than sections) or there is
 * none, the whole PDF stays one note. Pages stay annotatable PDF pages either way, and the text
 * layer is what search and the assistant read (the app's semantic memory indexes PDF text).
 */

export interface PdfOutlineItem {
  title: string;
  /** 0-based page the entry points at; null when it points nowhere resolvable. */
  page: number | null;
  children?: PdfOutlineItem[];
}

export interface PdfSection {
  title: string;
  /** 0-based, inclusive. */
  from: number;
  /** 0-based, inclusive. */
  to: number;
}

/** Which app most likely made the PDF, from its Producer/Creator metadata (for tags). */
export function pdfNotebookApp(meta: { producer?: string | null; creator?: string | null }): 'goodnotes' | 'notability' | 'onenote' | null {
  const s = `${meta.producer ?? ''} ${meta.creator ?? ''}`.toLowerCase();
  if (s.includes('goodnotes')) return 'goodnotes';
  if (s.includes('notability')) return 'notability';
  if (s.includes('onenote')) return 'onenote';
  return null;
}

/** The notes a PDF notebook becomes. Always covers every page exactly once, in order. */
export function planPdfSections(title: string, pageCount: number, outline: readonly PdfOutlineItem[] | null | undefined): PdfSection[] {
  const whole = [{ title, from: 0, to: Math.max(0, pageCount - 1) }];
  if (pageCount <= 0) return [];
  const starts = (outline ?? [])
    .filter((o) => o.page != null && o.page >= 0 && o.page < pageCount && o.title.trim())
    .map((o) => ({ title: o.title.trim().replace(/\s+/g, ' ').slice(0, 200), page: o.page! }))
    .sort((a, b) => a.page - b.page);
  // Keep the first entry per page.
  const uniq = starts.filter((s, i) => i === 0 || s.page !== starts[i - 1]!.page);
  if (uniq.length < 2) return whole;
  // A page-by-page index is not sections.
  if (uniq.length >= pageCount * 0.8 && pageCount > 3) return whole;
  const out: PdfSection[] = [];
  if (uniq[0]!.page > 0) out.push({ title, from: 0, to: uniq[0]!.page - 1 });
  uniq.forEach((s, i) => out.push({ title: s.title, from: s.page, to: (uniq[i + 1]?.page ?? pageCount) - 1 }));
  return out;
}
