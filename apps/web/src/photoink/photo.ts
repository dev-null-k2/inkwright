import { create } from 'zustand';
import { findPageCorners, newId, photoToInk, type NoteDocument, type PhotoToInkResult, type Quad, type Rgba } from '@inkwright/core';
import type { AppVault } from '../lib/vault.ts';

/**
 * Photo to ink in the app: decode the photo (EXIF orientation applied) into pixels, find the
 * page, let the user adjust the corners, trace in a worker, then add a page with the strokes
 * (one undo step) and the straightened photo kept as the page's hidden underlay.
 */

/** Longest side the photo is decoded at (the tracer reduces further; corners stay precise). */
const DECODE_MAX = 2000;

export async function decodePhoto(file: Blob): Promise<{ image: Rgba; url: string }> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions).catch(() => createImageBitmap(file));
  const k = Math.min(1, DECODE_MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h);
  return { image: { width: w, height: h, data: data.data }, url: c.toDataURL('image/jpeg', 0.85) };
}

export function detectCorners(image: Rgba): { quad: Quad; found: boolean } {
  return findPageCorners(image);
}

/** Traces in a worker when possible (falls back to this thread). */
export async function trace(image: Rgba, quad: Quad, pageWidth: number): Promise<PhotoToInkResult> {
  const now = Date.now();
  const here = () => photoToInk(image, { quad, pageWidth, now });
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return here();
  }
  try {
    return await new Promise<PhotoToInkResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: PhotoToInkResult; error?: string }>) => (e.data.ok ? resolve(e.data.result!) : reject(new Error(e.data.error)));
      // The worker itself could not start (a sandbox, an old browser): trace here instead.
      worker.onerror = (e) => { e.preventDefault(); try { resolve(here()); } catch (err) { reject(err as Error); } };
      // Copy the pixels: transferring would detach the dialog's own image.
      worker.postMessage({ image: { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }, quad, pageWidth, now });
    });
  } finally {
    worker.terminate();
  }
}

async function rgbaToPng(img: Rgba): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the photo'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Adds a page after `after` with the traced strokes and the photo underlay; returns its index. */
export async function addTracedPage(vault: AppVault, doc: NoteDocument, after: number, r: PhotoToInkResult): Promise<number> {
  const asset = vault.newAssetName('png');
  await vault.vault.writeAsset(doc.meta.id, asset, await rgbaToPng(r.rectified));
  const i = doc.addPage(after + 1, {
    size: { name: 'Photo', width: r.page.width, height: Math.round(r.page.height) },
    paper: { style: 'blank', tint: 'white', texture: 'standard', spacing: 0 },
    underlay: { asset, width: r.rectified.width, height: r.rectified.height, kind: 'photo' },
  });
  // Fresh ids for this note (the tracer's are only unique within one photo).
  const strokes = r.strokes.map((s) => ({ ...s, id: newId() }));
  doc.commit(i, { label: 'Photo to ink', strokes: { removed: [], added: strokes.map((item, index) => ({ index, item })) } }, 'other');
  return i;
}

/** "Show the original photo" over pages that have one — a view setting, never saved in the note. */
export const useUnderlayView = create<{ shown: boolean; toggle: () => void }>((set) => ({ shown: false, toggle: () => set((s) => ({ shown: !s.shown })) }));
