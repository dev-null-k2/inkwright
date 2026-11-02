/**
 * On-device OCR for the memory timeline: tesseract.js (Tesseract 5's LSTM engine compiled to
 * WebAssembly) in a Web Worker, with its files bundled into the desktop app
 * (scripts/vite-desktop-assets.ts) — nothing is downloaded and no pixels leave the device.
 *
 * Why tesseract.js and not the app's handwriting recognizers or the OS's OCR: the app's
 * recognizers read *ink strokes*, not pixels; Apple's Vision and Windows.Media.Ocr are faster
 * and better on their systems, but there is no equivalent on Linux, and one engine everywhere
 * means one behaviour to test (this one runs in CI and in the e2e suite). The engine sits behind
 * `recognize`, so OS engines can be added per platform later. docs/MEMORY_TIMELINE.md has the
 * measured cost.
 */
import type { Worker as TesseractWorker } from 'tesseract.js';

export const OCR_ENGINE_ID = 'tesseract.js 7 · eng';

let worker: Promise<TesseractWorker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** The worker holds ~40 MB; it is let go after a few idle minutes and started again when needed. */
const IDLE_MS = 3 * 60_000;

const asset = (name: string) => new URL(`tesseract/${name}`, document.baseURI).href;

function getWorker(): Promise<TesseractWorker> {
  worker ??= (async () => {
    const { createWorker, OEM } = await import('tesseract.js');
    return createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: asset('worker.min.js'),
      corePath: asset('tesseract-core-simd-lstm.wasm.js'),
      langPath: new URL('tesseract/', document.baseURI).href,
      gzip: true,
      // The model is a bundled file; keeping a second copy in IndexedDB would only cost space.
      cacheMethod: 'none',
    });
  })().catch((e) => {
    worker = null;
    throw e;
  });
  return worker;
}

function scheduleRelease() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stopOcr(), IDLE_MS);
}

/** Stops the worker (module switched off, capture stopped, or idle). */
export async function stopOcr(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const w = worker;
  worker = null;
  if (w) await (await w).terminate().catch(() => {});
}

/** A grayscale image (one byte per pixel) as a canvas tesseract.js can read. */
export function grayToCanvas(gray: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const v = gray[i]!;
    img.data[j] = v;
    img.data[j + 1] = v;
    img.data[j + 2] = v;
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Recognises the text in an image (a canvas, or a grayscale buffer). */
export async function recognize(image: HTMLCanvasElement): Promise<string> {
  const w = await getWorker();
  try {
    const { data } = await w.recognize(image);
    return data.text ?? '';
  } finally {
    scheduleRelease();
  }
}
