import { boundsOf, rectIntersects, type Rect } from '../geometry.ts';
import { handwrite, type HandStyle, type HandwritingStyle } from '../handwrite.ts';
import type { InkStroke, PageInk, TextBox } from '../model.ts';
import { objectRect } from '../objects.ts';

/**
 * AI answers in ink: where an answer goes on the page, how it is laid out in handwriting, and the
 * write-on animation. Pure functions; the app commits the strokes through `NoteDocument.commit`
 * (one undo step) with `origin: 'ai'`, so authorship never counts them as the user's writing.
 */

/** Markdown and typography → what the single-line handwriting fonts can write. */
export function plainForHandwriting(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, alias?: string) => alias ?? t)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[( |x|X)\]\s+/gm, (_m, c: string) => (c === ' ' ? '[ ] ' : '[x] '))
    .replace(/^\s*[*+•]\s+/gm, '- ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/^>\s?/gm, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/×/g, 'x')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Approximate box of a typed text block (font metrics are the app's; this is for placement). */
export function textBoxBounds(t: TextBox): Rect {
  const lines = t.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil((l.length * t.fontSize * 0.52) / Math.max(20, t.width))), 0);
  return { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + lines * t.fontSize * 1.35 };
}

/** Everything that takes room on a page. */
export function occupiedRects(page: Pick<PageInk, 'strokes' | 'texts' | 'images' | 'objects'>): Rect[] {
  const out: Rect[] = [];
  for (const s of page.strokes) if (s.points.length) out.push(boundsOf(s.points));
  for (const t of page.texts ?? []) out.push(textBoxBounds(t));
  for (const im of page.images ?? []) out.push({ minX: im.x, minY: im.y, maxX: im.x + im.width, maxY: im.y + im.height });
  for (const o of page.objects ?? []) out.push(objectRect(o));
  return out;
}

export interface PlaceOptions {
  /** Page size; 0 width/height = an infinite board. */
  page: { width: number; height: number };
  /** Space to keep from other content and the page edge. */
  gap?: number;
  margin?: number;
}

/**
 * A free rectangle for an answer near `near` (the selection): below it, then beside it, then
 * below everything on the page. The answer's height is unknown until it is laid out at the width
 * found, so the caller passes the height it needs for a given width (`heightFor`). Returns null
 * when the page has no room (the caller adds a page).
 */
export function findFreeSpace(occupied: readonly Rect[], near: Rect | null, heightFor: (width: number) => number, o: PlaceOptions): Rect | null {
  const gap = o.gap ?? 14;
  const margin = o.margin ?? 48;
  const infinite = o.page.width <= 0 || o.page.height <= 0;
  const W = infinite ? Infinity : o.page.width, H = infinite ? Infinity : o.page.height;
  const minWidth = 160;
  const fits = (r: Rect) => r.maxY <= H - margin / 2 && r.maxX <= W - margin / 2 + 1 && !occupied.some((q) => rectIntersects(r, { minX: q.minX - gap, minY: q.minY - gap, maxX: q.maxX + gap, maxY: q.maxY + gap }));
  const at = (x: number, y: number, maxW: number, maxSlide = Infinity): Rect | null => {
    const width = Math.min(maxW, infinite ? 520 : W - margin - x);
    if (width < minWidth) return null;
    // Slide down past anything in the way, in small steps.
    for (let yy = y, k = 0; k < 60; k++, yy += gap) {
      const r = { minX: x, minY: yy, maxX: x + width, maxY: yy + heightFor(width) };
      if (fits(r)) return r;
      if (r.maxY > H || yy - y > maxSlide) return null;
    }
    return null;
  };
  const tries: (Rect | null)[] = [];
  if (near) {
    // Near means near: a spot found far down the page loses to one beside the selection.
    tries.push(at(Math.max(margin, near.minX), near.maxY + gap, Math.max(minWidth, Math.min(560, (infinite ? 560 : W - margin - Math.max(margin, near.minX)))), 160));
    tries.push(at(near.maxX + gap * 2, near.minY, 520, 160));
  }
  const bottom = occupied.reduce((m, r) => Math.max(m, r.maxY), margin);
  tries.push(at(margin, bottom + gap * 2, infinite ? 560 : W - margin * 2));
  return tries.find((r): r is Rect => !!r) ?? null;
}

export interface InkAnswerOptions {
  style?: HandwritingStyle;
  color?: string;
  /** Preferred x-height; shrinks (down to 6) when the answer would not fit `maxHeight`. */
  xHeight?: number;
  maxHeight?: number;
  seed?: number;
  startTime?: number;
  newId?: () => string;
  /** Write in a hand like the writer's (`handStyleOf`): pen, tip size, slant and messiness. */
  hand?: Partial<Pick<HandStyle, 'pen' | 'size' | 'slant' | 'messiness'>>;
}

/** Lays an answer out as handwriting in an area; returns the strokes and the box they fill. */
export function layoutInkAnswer(text: string, area: { x: number; y: number; width: number }, o: InkAnswerOptions = {}): { strokes: InkStroke[]; rect: Rect; xHeight: number } {
  const plain = plainForHandwriting(text);
  let xh = o.xHeight ?? 8.5;
  for (;;) {
    const r = handwrite(plain, { x: area.x, y: area.y, width: area.width, xHeight: xh, style: o.style ?? 'script', color: o.color, seed: o.seed, startTime: o.startTime, origin: 'ai', pen: o.hand?.pen ?? 'ballpoint', size: o.hand?.size ?? Math.max(1.1, xh * 0.17), messiness: o.hand?.messiness ?? 0.3, ...(o.hand?.slant != null ? { slant: o.hand.slant } : {}), ...(o.newId ? { newId: o.newId } : {}) });
    const pts = r.strokes.flatMap((s) => s.points);
    const b = pts.length ? boundsOf(pts) : { minX: area.x, minY: area.y, maxX: area.x, maxY: area.y };
    const rect = { minX: area.x, minY: area.y, maxX: Math.max(b.maxX, area.x), maxY: Math.max(r.bottom, b.maxY) };
    if (o.maxHeight == null || rect.maxY - rect.minY <= o.maxHeight || xh <= 6) return { strokes: r.strokes, rect, xHeight: xh };
    xh = Math.max(6, xh * 0.85);
  }
}

/** Height an answer needs at a width (for `findFreeSpace`). */
export function inkAnswerHeight(text: string, width: number, o: Pick<InkAnswerOptions, 'style' | 'xHeight'> = {}): number {
  const r = layoutInkAnswer(text, { x: 0, y: 0, width }, { ...o, seed: 1 });
  return r.rect.maxY - r.rect.minY;
}

/**
 * The write-on animation: the strokes as they look after `progress` (0..1) of the writing, by ink
 * length (a long stroke takes longer, like a pen). Finished strokes are returned as the same
 * objects, so a renderer that caches by identity redraws only the stroke being written.
 */
export function writeOnFrame(strokes: readonly InkStroke[], progress: number): InkStroke[] {
  const lens = strokes.map((s) => { let l = 0; for (let i = 1; i < s.points.length; i++) l += Math.hypot(s.points[i]!.x - s.points[i - 1]!.x, s.points[i]!.y - s.points[i - 1]!.y); return Math.max(l, 1); });
  const total = lens.reduce((a, b) => a + b, 0);
  let left = Math.max(0, Math.min(1, progress)) * total;
  const out: InkStroke[] = [];
  for (let i = 0; i < strokes.length && left > 0; i++) {
    const s = strokes[i]!;
    if (left >= lens[i]!) { out.push(s); left -= lens[i]!; continue; }
    // Part of this stroke: points up to the length written so far.
    let acc = 0;
    const pts = [s.points[0]!];
    for (let k = 1; k < s.points.length; k++) {
      acc += Math.hypot(s.points[k]!.x - s.points[k - 1]!.x, s.points[k]!.y - s.points[k - 1]!.y);
      if (acc > left) break;
      pts.push(s.points[k]!);
    }
    out.push({ ...s, points: pts });
    left = 0;
  }
  return out;
}

/** True when the answer box overlaps nothing (tests and sanity checks). */
export function isFree(r: Rect, occupied: readonly Rect[]): boolean {
  return !occupied.some((q) => rectIntersects(r, q));
}
