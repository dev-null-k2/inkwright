/**
 * Decoded images and rendered PDF pages, cached per note asset. Rendering is async; callers get
 * whatever is ready now (possibly a lower-resolution PDF render) and a callback when better
 * pixels arrive, so the canvas never blocks on decoding.
 */
import type { FormFieldValue, NoteMeta, PageBackground } from '@inkwright/core';
import { coerce, fieldsFromAnnotations, storageEntries } from '../fill/pdfForm.ts';

export type AssetLoader = (noteId: string, name: string) => Promise<Uint8Array | null>;

type Bitmap = ImageBitmap | HTMLCanvasElement;

export class AssetCache {
  private images = new Map<string, Bitmap | 'loading' | 'error'>();
  private pdfDocs = new Map<string, Promise<any>>();
  private pdfPages = new Map<string, { scale: number; bmp: Bitmap; sig: string }>();
  private rotated = new Map<string, Bitmap>();
  /** Form values most recently asked for, per page render key. */
  private latestSig = new Map<string, string>();
  private pdfPending = new Set<string>();
  constructor(private load: AssetLoader, private onReady: () => void) {}

  image(noteId: string, name: string): Bitmap | null {
    const key = `${noteId}/${name}`;
    const v = this.images.get(key);
    if (v && v !== 'loading' && v !== 'error') return v;
    if (!v) {
      this.images.set(key, 'loading');
      this.load(noteId, name)
        .then(async (bytes) => {
          if (!bytes) throw new Error('missing');
          const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
          this.images.set(key, bmp);
          this.onReady();
        })
        .catch(() => this.images.set(key, 'error'));
    }
    return null;
  }

  /** Best available render of a PDF page; requests a sharper one for `scale` (px per unit). */
  pdfPage(noteId: string, name: string, pageNumber: number, scale: number, opts: { rotation?: number; form?: Record<string, FormFieldValue>; fresh?: boolean } = {}): Bitmap | null {
    const rot = (((opts.rotation ?? 0) % 360) + 360) % 360;
    const key = `${noteId}/${name}#${pageNumber}@${rot}`;
    const sig = opts.form && Object.keys(opts.form).length ? JSON.stringify(opts.form) : '';
    const have = this.pdfPages.get(key);
    this.latestSig.set(key, sig);
    // Render in steps of 1.5× so zooming does not re-render constantly; cap pixel count.
    const want = Math.min(4, Math.pow(1.5, Math.ceil(Math.log(Math.max(0.25, scale)) / Math.log(1.5))));
    const stale = !!have && have.sig !== sig;
    const pendingKey = `${key}|${sig}`;
    if ((!have || stale || have.scale < want * 0.99) && !this.pdfPending.has(pendingKey)) {
      this.pdfPending.add(pendingKey);
      const scaleNow = stale ? Math.max(want, have!.scale) : want;
      this.renderPdf(noteId, name, pageNumber, scaleNow, rot, opts.form)
        .then((bmp) => {
          if (bmp) {
            const cur = this.pdfPages.get(key);
            // Renders can finish out of order while values change: keep the latest values' render.
            const latest = this.latestSig.get(key) === sig;
            if (latest && (!cur || cur.sig !== sig || cur.scale <= scaleNow)) this.pdfPages.set(key, { scale: scaleNow, bmp, sig });
            else if (!cur) this.pdfPages.set(key, { scale: scaleNow, bmp, sig });
            this.onReady();
          }
        })
        .catch((e) => console.warn('PDF render failed', e))
        .finally(() => this.pdfPending.delete(pendingKey));
    }
    // While new form values render, the previous render stays on screen (no flash), except for
    // one-off renders (export, thumbnails) that must show the current values.
    if (opts.fresh && stale) return null;
    return have?.bmp ?? null;
  }

  /**
   * A page's imported background (PDF page or image) with the user's extra rotation and, for
   * PDFs, the form values filled in Inkwright drawn into the fields.
   */
  background(note: Pick<NoteMeta, 'id' | 'forms'>, bg: PageBackground, scale: number, fresh = false): Bitmap | null {
    if (bg.kind === 'pdf') return this.pdfPage(note.id, bg.asset, bg.pageNumber ?? 1, scale, { rotation: bg.rotation, form: note.forms?.[bg.asset], fresh });
    const img = this.image(note.id, bg.asset);
    const rot = (((bg.rotation ?? 0) % 360) + 360) % 360;
    if (!img || !rot) return img;
    const key = `${note.id}/${bg.asset}@${rot}`;
    let out = this.rotated.get(key);
    if (!out) {
      const c = document.createElement('canvas');
      const swap = rot === 90 || rot === 270;
      c.width = swap ? img.height : img.width;
      c.height = swap ? img.width : img.height;
      const ctx = c.getContext('2d')!;
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      out = c;
      this.rotated.set(key, out);
    }
    return out;
  }

  /** The loaded pdf.js document of a PDF asset (shared with rendering). */
  pdfDocument(noteId: string, name: string): Promise<any> {
    return this.pdfDoc(noteId, name);
  }

  private async pdfDoc(noteId: string, name: string) {
    const key = `${noteId}/${name}`;
    let p = this.pdfDocs.get(key);
    if (!p) {
      p = (async () => {
        const bytes = await this.load(noteId, name);
        if (!bytes) throw new Error('PDF asset missing');
        const pdfjs = await loadPdfJs();
        return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      })();
      this.pdfDocs.set(key, p);
    }
    return p;
  }

  private async renderPdf(noteId: string, name: string, pageNumber: number, scale: number, extraRotation = 0, form?: Record<string, FormFieldValue>): Promise<Bitmap | null> {
    const doc = await this.pdfDoc(noteId, name);
    const page = await doc.getPage(pageNumber);
    const rotation = (((page.rotate ?? 0) + extraRotation) % 360 + 360) % 360;
    // PDF points are 1/72 in; page units are 1/96 in.
    const base = page.getViewport({ scale: 96 / 72, rotation });
    const maxPx = 4096;
    const s = Math.min(scale, maxPx / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: (96 / 72) * s, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    // Form fields are drawn into the page (like printing) with the values filled in Inkwright;
    // without this pdf.js leaves fields to an HTML layer and filled-in PDFs would look empty.
    const fields = fieldsFromAnnotations([{ pageNumber, annotations: await page.getAnnotations({ intent: 'display' }) }]);
    const storage = doc.annotationStorage;
    for (const f of fields) {
      const v = form?.[f.name];
      for (const [id, value] of v === undefined ? [] : storageEntries(f, coerce(f, v))) storage.setValue(id, value);
      if (v === undefined) for (const w of f.widgets) storage.remove?.(w.id);
    }
    const pdfjs = await loadPdfJs();
    await page.render({ canvasContext: ctx, canvas, viewport, annotationMode: pdfjs.AnnotationMode?.ENABLE_STORAGE ?? 3 }).promise;
    return canvas;
  }

  clear() {
    this.images.clear();
    this.pdfPages.clear();
    this.rotated.clear();
    for (const d of this.pdfDocs.values()) d.then((doc) => (doc.loadingTask?.destroy?.() ?? doc.destroy?.())).catch(() => {});
    this.pdfDocs.clear();
  }
}

let pdfjsPromise: Promise<any> | null = null;

/** Lazy-loads pdf.js with its worker inlined, so it works offline and in a single-file build. */
export function loadPdfJs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      try {
        const { default: PdfWorker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline');
        pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
      } catch (e) {
        console.warn('PDF worker unavailable, rendering on the main thread', e);
      }
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/** Reads page count and sizes (page units) of a PDF for import. */
export async function inspectPdf(bytes: Uint8Array): Promise<{ count: number; sizes: { width: number; height: number }[] }> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const sizes: { width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const v = page.getViewport({ scale: 96 / 72 });
    sizes.push({ width: Math.round(v.width * 10) / 10, height: Math.round(v.height * 10) / 10 });
  }
  const count = doc.numPages;
  await (task.destroy?.() ?? doc.destroy?.());
  return { count, sizes };
}
