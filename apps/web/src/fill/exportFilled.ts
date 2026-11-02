import { PDFContentStream, PDFDocument, PDFName, PDFRef, concatTransformationMatrix, degrees, popGraphicsState, pushGraphicsState, type PDFPage } from 'pdf-lib';
import { pageSizeOf, type NoteMeta, type PageInk } from '@inkstone/core';
import { K, SourcePdfs, drawPageItems, drawPaperBackground, drawPdfPageBackground, embedFonts, type ReadAsset } from '../lib/pdfdraw.ts';
import { fillPdfForm, type FillReport } from './formWriter.ts';
import { pdfAssetsOf } from './pdfForm.ts';

/**
 * "Export filled PDF": the user's original PDF comes back as a real document. The PDF that most
 * pages of the note come from is loaded as is (vector content, text, links, metadata and form
 * stay), its form fields get the values filled in Inkstone (optionally flattened), its pages are
 * put in the note's order with the user's rotation, and ink, typed text and signatures are drawn
 * on top as vectors. Pages that don't come from that PDF (blank pages, other PDFs, a second copy
 * of a page) are added the same way the note exporter draws them.
 */

export interface FilledExportOptions {
  /** Turn fields into plain page content, so values can't be changed any more. */
  flatten?: boolean;
  /** Title for the document's metadata (the original title is kept when omitted). */
  title?: string;
}

export interface FilledExportResult {
  bytes: Uint8Array;
  report: FillReport;
}

/**
 * Maps the displayed page (origin bottom-left, width/height as shown) to the PDF page's user space,
 * for a page whose visible box is `crop` and whose total clockwise rotation is `rot` — the inverse
 * of what viewers do when they show a rotated, cropped page.
 */
export function displayToUserMatrix(crop: { x: number; y: number; width: number; height: number }, rot: number): [number, number, number, number, number, number] {
  const r = ((rot % 360) + 360) % 360;
  const { x, y, width: w, height: h } = crop;
  if (r === 90) return [0, 1, -1, 0, x + w, y];
  if (r === 180) return [-1, 0, 0, -1, x + w, y + h];
  if (r === 270) return [0, -1, 1, 0, x, y + h];
  return [1, 0, 0, 1, x, y];
}

export async function exportFilledPdf(note: NoteMeta, pages: readonly PageInk[], readAsset: ReadAsset, opts: FilledExportOptions = {}): Promise<FilledExportResult> {
  const primary = pdfAssetsOf(pages)[0];
  const primaryBytes = primary ? await readAsset(primary) : null;
  if (!primary || !primaryBytes) throw new Error('This note has no PDF to fill.');
  const out = await PDFDocument.load(primaryBytes, { ignoreEncryption: true, updateMetadata: false });
  if (opts.title) out.setTitle(opts.title);
  out.setModificationDate(new Date(note.updatedAt));
  const report = await fillPdfForm(out, note.forms?.[primary], { flatten: opts.flatten });
  const fonts = await embedFonts(out);
  const sources = new SourcePdfs(readAsset, note);
  const originals = out.getPages();
  const used = new Set<number>();
  const ordered: PDFPage[] = [];

  for (const page of pages) {
    const bg = page.background;
    const n = (bg?.pageNumber ?? 1) - 1;
    if (bg?.kind === 'pdf' && bg.asset === primary && originals[n] && !used.has(n)) {
      // The original page: keep it, turn it like the note shows it, draw on top.
      used.add(n);
      const p = originals[n]!;
      const own = p.getRotation().angle;
      const rot = (((own + (bg.rotation ?? 0)) % 360) + 360) % 360;
      if (bg.rotation) p.setRotation(degrees(rot));
      const crop = p.getCropBox();
      const H = rot === 90 || rot === 270 ? crop.width : crop.height;
      if (hasItems(page)) {
        isolateExistingContent(out, p);
        p.pushOperators(pushGraphicsState(), concatTransformationMatrix(...displayToUserMatrix(crop, rot)));
        await drawPageItems(out, p, page, H, fonts, readAsset);
        p.pushOperators(popGraphicsState());
      }
      ordered.push(p);
      continue;
    }
    // Anything else becomes a new page drawn like the note exporter does.
    const size = pageSizeOf(note, page);
    const W = size.width * K, H = size.height * K;
    const p = out.addPage([W, H]);
    if (bg?.kind === 'pdf') {
      const src = await sources.get(bg.asset);
      if (src) await drawPdfPageBackground(out, p, src, bg.pageNumber ?? 1, bg.rotation ?? 0, W, H);
    } else {
      drawPaperBackground(p, note, page, size, fonts);
    }
    await drawPageItems(out, p, page, H, fonts, readAsset);
    ordered.push(p);
  }

  // Put pages in the note's order; original pages the note no longer shows are left out.
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  for (const p of ordered) out.addPage(p);
  if (!report.flattened) dropOrphanFields(out);
  return { bytes: await out.save({ updateFieldAppearances: false }), report };
}

const hasItems = (p: PageInk) => p.strokes.length > 0 || !!p.texts?.length || !!p.images?.length;

/**
 * Wraps the page's existing content in q … Q, so a transformation it leaves behind (many PDFs end
 * with an unbalanced `cm`) can't shift what we draw on top.
 */
function isolateExistingContent(pdf: PDFDocument, p: PDFPage) {
  p.node.normalize();
  const start = pdf.context.register(PDFContentStream.of(pdf.context.obj({}), [pushGraphicsState()]));
  const end = pdf.context.register(PDFContentStream.of(pdf.context.obj({}), [popGraphicsState()]));
  p.node.wrapContentStreams(start, end);
}

/** Removes form fields whose every widget sat on a page that is no longer in the document. */
function dropOrphanFields(pdf: PDFDocument) {
  let form;
  try { form = pdf.getForm(); } catch { return; }
  const live = new Set(pdf.getPages().map((p) => p.ref.toString()));
  const annotRefs = new Set<string>();
  for (const p of pdf.getPages()) {
    const annots = p.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i);
      if (r instanceof PDFRef) annotRefs.add(r.toString());
    }
  }
  for (const f of form.getFields()) {
    const widgets = f.acroField.getWidgets();
    const alive = widgets.some((w) => {
      const pRef = w.dict.get(PDFName.of('P'));
      if (pRef instanceof PDFRef && live.has(pRef.toString())) return true;
      const ref = pdf.context.getObjectRef(w.dict);
      return !!ref && annotRefs.has(ref.toString());
    });
    if (!alive && widgets.length) {
      try { form.acroForm.removeField(f.acroField); } catch { /* keep it */ }
    }
  }
}
