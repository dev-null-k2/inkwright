import { isInfinite, pageSizeOf, type NoteMeta, type PageInk } from '@inkwright/core';

/** Where each page sits in document space (page units). */
export interface PageSlot {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  infinite: boolean;
}

export const PAGE_GAP = 28;

export interface DocLayout {
  slots: PageSlot[];
  width: number;
  height: number;
  infinite: boolean;
  /** Pages sit side by side in pairs (two-page view). */
  spreads?: boolean;
}

/**
 * Stacks pages vertically, centred on the widest page. Boards are one infinite slot. With
 * `spreads`, pages pair up side by side like an open book (1–2, 3–4, …), each spread centred and
 * its pages top-aligned; spreads stack vertically.
 */
export function layoutPages(note: NoteMeta, pages: readonly PageInk[], opts: { spreads?: boolean } = {}): DocLayout {
  if (note.kind === 'board') {
    return { slots: [{ index: 0, x: 0, y: 0, w: Infinity, h: Infinity, infinite: true }], width: Infinity, height: Infinity, infinite: true };
  }
  const sizes = pages.map((p) => {
    const s = pageSizeOf(note, p);
    return isInfinite(s) ? { width: 793.7, height: 1122.5 } : s;
  });
  if (opts.spreads) return layoutSpreads(sizes);
  const maxW = Math.max(...sizes.map((s) => s.width), 1);
  const slots: PageSlot[] = [];
  let y = 0;
  sizes.forEach((s, i) => {
    slots.push({ index: i, x: (maxW - s.width) / 2, y, w: s.width, h: s.height, infinite: false });
    y += s.height + PAGE_GAP;
  });
  return { slots, width: maxW, height: Math.max(0, y - PAGE_GAP), infinite: false };
}

/** Gap between the two pages of a spread (the "gutter"), page units. */
export const SPREAD_GUTTER = 18;

function layoutSpreads(sizes: { width: number; height: number }[]): DocLayout {
  const rows: { a: number; b: number | null; w: number; h: number }[] = [];
  for (let i = 0; i < sizes.length; i += 2) {
    const a = sizes[i]!, b = sizes[i + 1];
    rows.push({ a: i, b: b ? i + 1 : null, w: a.width + (b ? SPREAD_GUTTER + b.width : 0), h: Math.max(a.height, b?.height ?? 0) });
  }
  const maxW = Math.max(...rows.map((r) => r.w), 1);
  const slots: PageSlot[] = [];
  let y = 0;
  for (const r of rows) {
    const x0 = (maxW - r.w) / 2;
    const a = sizes[r.a]!;
    slots.push({ index: r.a, x: x0, y, w: a.width, h: a.height, infinite: false });
    if (r.b != null) {
      const b = sizes[r.b]!;
      slots.push({ index: r.b, x: x0 + a.width + SPREAD_GUTTER, y, w: b.width, h: b.height, infinite: false });
    }
    y += r.h + PAGE_GAP;
  }
  return { slots, width: maxW, height: Math.max(0, y - PAGE_GAP), infinite: false, spreads: true };
}

/** Height of the spread (or page) row that a slot is in. */
export function rowHeight(layout: DocLayout, slot: PageSlot): number {
  return Math.max(...layout.slots.filter((s) => s.y === slot.y).map((s) => s.h));
}

/**
 * Whether "Auto" should show two pages side by side: a paged note with more than one page, on a
 * screen wide enough and not portrait — desktops, landscape tablets and unfolded foldables like
 * the Razr Fold's inner display.
 */
export function autoSpreads(width: number, height: number, pageCount: number): boolean {
  return pageCount >= 2 && width >= 800 && width >= height * 0.95;
}

/** The page under a document point, or (for paged notes) null when in a gap/outside. */
export function slotAt(layout: DocLayout, x: number, y: number): PageSlot | null {
  if (layout.infinite) return layout.slots[0]!;
  for (const s of layout.slots) if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
  return null;
}

/**
 * The page whose vertical span is nearest a document y (page indicator, scroll targets). With
 * spreads, `x` picks between the two pages of a row (ties go to the left page).
 */
export function nearestSlot(layout: DocLayout, y: number, x?: number): PageSlot {
  let best = layout.slots[0]!;
  let bestD = Infinity;
  for (const s of layout.slots) {
    let d = y < s.y ? s.y - y : y > s.y + s.h ? y - (s.y + s.h) : 0;
    if (x != null && layout.spreads) d = d * 1000 + (x < s.x ? s.x - x : x > s.x + s.w ? x - (s.x + s.w) : 0);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

export class Viewport {
  zoom = 1;
  panX = 0;
  panY = 0;
  width = 0;
  height = 0;

  toScreen(x: number, y: number) {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  }

  toDoc(sx: number, sy: number) {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  /** Visible document rectangle. */
  visible() {
    const a = this.toDoc(0, 0);
    const b = this.toDoc(this.width, this.height);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }

  zoomAt(factor: number, sx: number, sy: number, min = 0.15, max = 12) {
    const z = Math.max(min, Math.min(max, this.zoom * factor));
    const d = this.toDoc(sx, sy);
    this.zoom = z;
    this.panX = sx - d.x * z;
    this.panY = sy - d.y * z;
  }
}
