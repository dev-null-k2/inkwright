import { newId, type InkPoint, type InkStroke, type PenType } from '@inkstone/core';
import type { SecretStore } from '@inkstone/ai';

/**
 * The signature & initials library: signatures drawn with the pen (kept as real ink), typed in a
 * handwriting style, or imported from a photo/scan with the paper removed. Saved on this device
 * only, encrypted with the app's WebCrypto secret store (AES-GCM key that never leaves the
 * browser/app), so a signature is never synced or exported unless placed on a document.
 */

export type SignatureKind = 'signature' | 'initials';

/** Ink normalized to a box `aspect × 100` (height 100 units), origin top-left. */
export interface SignatureInk { pen: PenType; size: number; points: [number, number, number, number][] }

export interface SavedSignature {
  id: string;
  kind: SignatureKind;
  source: 'drawn' | 'typed' | 'image';
  createdAt: number;
  /** Width / height. */
  aspect: number;
  /** Drawn: the strokes. */
  ink?: SignatureInk[];
  /** Typed / imported: transparent PNG (base64, no data: prefix), dark ink. */
  png?: string;
  /** Typed: the words and style, for the library's label. */
  text?: string;
  style?: string;
}

export const NORMAL_HEIGHT = 100;
const STORE_KEY = 'inkstone.signatures.v1';

/** Normalizes drawn strokes to the library's box (height 100, small margin). */
export function normalizeInk(strokes: InkStroke[]): { ink: SignatureInk[]; aspect: number } | null {
  const pts = strokes.flatMap((s) => s.points);
  if (!pts.length) return null;
  const pad = Math.max(...strokes.map((s) => s.size)) / 2 + 1;
  const minX = Math.min(...pts.map((p) => p.x)) - pad, maxX = Math.max(...pts.map((p) => p.x)) + pad;
  const minY = Math.min(...pts.map((p) => p.y)) - pad, maxY = Math.max(...pts.map((p) => p.y)) + pad;
  const h = Math.max(1, maxY - minY);
  const k = NORMAL_HEIGHT / h;
  return {
    aspect: Math.max(0.2, (maxX - minX) / h),
    ink: strokes.map((s) => ({
      pen: s.pen,
      size: s.size * k,
      points: s.points.map((p) => [round((p.x - minX) * k), round((p.y - minY) * k), Math.round(p.t), round(p.p)] as [number, number, number, number]),
    })),
  };
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Real strokes for placing a drawn signature with its top-left at (x, y), `height` tall. */
export function inkForPlacement(sig: SavedSignature, x: number, y: number, height: number, color: string, now = Date.now(), makeId: () => string = () => newId()): InkStroke[] {
  const k = height / NORMAL_HEIGHT;
  return (sig.ink ?? []).map((s, i) => ({
    id: makeId(),
    pen: s.pen,
    color,
    size: Math.max(0.6, s.size * k),
    createdAt: now + i,
    points: s.points.map(([px, py, t, p]): InkPoint => ({ x: x + px * k, y: y + py * k, t, p, tilt: -1, orient: -1 })),
  }));
}

/**
 * Removes the paper behind a photographed or scanned signature: estimates paper and ink
 * brightness from the image, turns paper transparent with a soft edge, and makes the ink one
 * dark colour (so it can be recoloured later). Returns the ink's bounding box (pixels) or null
 * when the image has no ink.
 */
export function removeBackground(rgba: Uint8ClampedArray, width: number, height: number, ink: [number, number, number] = [20, 24, 32]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const n = width * height;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    const l = Math.round((0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!) * a + 255 * (1 - a));
    lum[i] = l;
    hist[l]!++;
  }
  const pct = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]!; if (acc >= q * n) return v; }
    return 255;
  };
  const paper = pct(0.6); // most of a signature photo is paper
  const darkest = pct(0.005);
  if (paper - darkest < 40) return null; // flat image: nothing to keep
  const hi = paper - (paper - darkest) * 0.25; // lighter than this → transparent
  const lo = darkest + (paper - darkest) * 0.25; // darker than this → fully opaque
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    const l = lum[i]!;
    const alpha = l >= hi ? 0 : l <= lo ? 255 : Math.round(255 * (hi - l) / (hi - lo));
    rgba[i * 4] = ink[0];
    rgba[i * 4 + 1] = ink[1];
    rgba[i * 4 + 2] = ink[2];
    rgba[i * 4 + 3] = alpha;
    if (alpha > 64) {
      const x = i % width, y = (i / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** Recolours transparent ink in place (keeps alpha). `color` is `#AARRGGBB` or `#RRGGBB`. */
export function tintInk(rgba: Uint8ClampedArray, color: string): void {
  const h = color.replace('#', '');
  const hex = h.length === 8 ? h.slice(2) : h;
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
  }
}

/** The saved signatures, encrypted at rest in the app's secret store. */
export class SignatureLibrary {
  private cache: SavedSignature[] | null = null;
  constructor(private store: SecretStore) {}

  async list(): Promise<SavedSignature[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await this.store.get(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      this.cache = Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch (e) {
      console.warn('Could not read saved signatures', e);
      this.cache = [];
    }
    return this.cache;
  }

  async add(sig: Omit<SavedSignature, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<SavedSignature> {
    const entry: SavedSignature = { ...sig, id: sig.id ?? newId(), createdAt: sig.createdAt ?? Date.now() };
    const next = [entry, ...(await this.list())];
    await this.write(next);
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.write((await this.list()).filter((s) => s.id !== id));
  }

  private async write(list: SavedSignature[]) {
    if (list.length) await this.store.set(STORE_KEY, JSON.stringify(list));
    else await this.store.delete(STORE_KEY);
    this.cache = list;
  }
}

function valid(s: unknown): s is SavedSignature {
  const x = s as SavedSignature;
  return !!x && typeof x.id === 'string' && (x.kind === 'signature' || x.kind === 'initials') && typeof x.aspect === 'number' && (Array.isArray(x.ink) || typeof x.png === 'string');
}
