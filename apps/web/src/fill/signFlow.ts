/**
 * "Sign a document": the guided path into Fill & sign.
 *
 * Fill & sign has always worked on any PDF note, but people looking for "sign a document" did not
 * find it behind ••• of an already-open PDF. This is the front door used by the library's New
 * menu, the editor's "+" menu, the welcome and the search palette:
 *
 *   pick a PDF or a photo of a page → it becomes a note → the editor opens with the form layer
 *   already on (fields to type into, Sign / Initials / Date / ✓ tools) → Export shares the signed
 *   PDF.
 *
 * A photo or scan is first wrapped in a one-page PDF, so the export is a PDF either way and the
 * same snapping to printed lines works on it.
 */
import { importFiles } from '../lib/actions.ts';
import { classifyFile } from '../lib/openFiles.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { requestFillOnOpen } from './signIntent.ts';

export { requestFillOnOpen, takeFillRequest } from './signIntent.ts';

/** What the picker offers: PDFs, and pictures of paper documents. */
export const SIGNABLE = 'application/pdf,.pdf,image/*';

/** A4 at 72 dpi: the page a photographed document is placed on when it has no size of its own. */
const A4 = { width: 595.28, height: 841.89 };

/**
 * The size of the PDF page for an image `w`×`h` pixels: A4-wide (or A4-tall for landscape pages
 * turned the other way), keeping the image's proportions so nothing is stretched.
 */
export function pageForImage(w: number, h: number): { width: number; height: number } {
  if (!(w > 0 && h > 0)) return { ...A4 };
  const landscape = w > h;
  const width = landscape ? A4.height : A4.width;
  return { width, height: (width * h) / w };
}

/** Wraps a photo or scan of a page in a one-page PDF (pdf-lib loads only here). */
export async function imageToPdf(file: File): Promise<File> {
  const { PDFDocument } = await import('pdf-lib');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await PDFDocument.create();
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  let img;
  if (isPng) img = await pdf.embedPng(bytes);
  else if (isJpg) img = await pdf.embedJpg(bytes);
  else {
    // WebP, HEIC (where the browser decodes it), GIF…: re-encode as PNG first.
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!blob) throw new Error('This picture could not be read.');
    img = await pdf.embedPng(new Uint8Array(await blob.arrayBuffer()));
  }
  const size = pageForImage(img.width, img.height);
  const page = pdf.addPage([size.width, size.height]);
  page.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height });
  pdf.setTitle(file.name.replace(/\.[^.]+$/, ''));
  const out = await pdf.save();
  return new File([out as BlobPart], `${file.name.replace(/\.[^.]+$/, '') || 'Document'}.pdf`, { type: 'application/pdf' });
}

/**
 * Opens `file` (a PDF or an image of a document) ready to sign: imports it as a note in
 * `notebookId` and navigates to it with the form layer on. Returns the new note's id.
 */
export async function openForSigning(file: File, notebookId?: string): Promise<string | null> {
  const app = useApp.getState();
  const kind = classifyFile(file);
  if (kind !== 'pdf' && kind !== 'image') {
    app.fail(`${file.name} isn't a PDF or a picture of a document.`);
    return null;
  }
  let pdf = file;
  if (kind === 'image') {
    try {
      pdf = await imageToPdf(file);
    } catch (e) {
      app.fail(`Couldn't open ${file.name}: ${(e as Error).message}`);
      return null;
    }
  }
  const id = await importFiles([pdf], notebookId);
  if (!id) return null;
  requestFillOnOpen(id);
  app.navigate({ name: 'editor', noteId: id });
  app.toast({ text: 'Type into the fields, tap Sign to place your signature, then Export.' });
  return id;
}

/** "Sign a document": the file picker, then {@link openForSigning}. */
export async function startSigning(notebookId?: string): Promise<string | null> {
  const [file] = await pickFiles(SIGNABLE, false);
  if (!file) return null;
  return openForSigning(file, notebookId);
}
