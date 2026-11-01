/**
 * Decoded images and rendered PDF pages, cached per note asset. Rendering is async; callers get
 * whatever is ready now (possibly a lower-resolution PDF render) and a callback when better
 * pixels arrive, so the canvas never blocks on decoding.
 */
export type AssetLoader = (noteId: string, name: string) => Promise<Uint8Array | null>;

type Bitmap = ImageBitmap | HTMLCanvasElement;

export class AssetCache {
  private images = new Map<string, Bitmap | 'loading' | 'error'>();
  private pdfDocs = new Map<string, Promise<any>>();
  private pdfPages = new Map<string, { scale: number; bmp: Bitmap }>();
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
  pdfPage(noteId: string, name: string, pageNumber: number, scale: number): Bitmap | null {
    const key = `${noteId}/${name}#${pageNumber}`;
    const have = this.pdfPages.get(key);
    // Render in steps of 1.5× so zooming does not re-render constantly; cap pixel count.
    const want = Math.min(4, Math.pow(1.5, Math.ceil(Math.log(Math.max(0.25, scale)) / Math.log(1.5))));
    if ((!have || have.scale < want * 0.99) && !this.pdfPending.has(key)) {
      this.pdfPending.add(key);
      this.renderPdf(noteId, name, pageNumber, want)
        .then((bmp) => {
          if (bmp) {
            this.pdfPages.set(key, { scale: want, bmp });
            this.onReady();
          }
        })
        .catch((e) => console.warn('PDF render failed', e))
        .finally(() => this.pdfPending.delete(key));
    }
    return have?.bmp ?? null;
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

  private async renderPdf(noteId: string, name: string, pageNumber: number, scale: number): Promise<Bitmap | null> {
    const doc = await this.pdfDoc(noteId, name);
    const page = await doc.getPage(pageNumber);
    // PDF points are 1/72 in; page units are 1/96 in.
    const base = page.getViewport({ scale: 96 / 72 });
    const maxPx = 4096;
    const s = Math.min(scale, maxPx / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: (96 / 72) * s });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    return canvas;
  }

  clear() {
    this.images.clear();
    this.pdfPages.clear();
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
