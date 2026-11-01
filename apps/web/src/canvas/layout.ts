import { isInfinite, pageSizeOf, type NoteMeta, type PageInk } from '@inkstone/core';

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
}

/** Stacks pages vertically, centred on the widest page. Boards are one infinite slot. */
export function layoutPages(note: NoteMeta, pages: readonly PageInk[]): DocLayout {
  if (note.kind === 'board') {
    return { slots: [{ index: 0, x: 0, y: 0, w: Infinity, h: Infinity, infinite: true }], width: Infinity, height: Infinity, infinite: true };
  }
  const sizes = pages.map((p) => {
    const s = pageSizeOf(note, p);
    return isInfinite(s) ? { width: 793.7, height: 1122.5 } : s;
  });
  const maxW = Math.max(...sizes.map((s) => s.width), 1);
  const slots: PageSlot[] = [];
  let y = 0;
  sizes.forEach((s, i) => {
    slots.push({ index: i, x: (maxW - s.width) / 2, y, w: s.width, h: s.height, infinite: false });
    y += s.height + PAGE_GAP;
  });
  return { slots, width: maxW, height: Math.max(0, y - PAGE_GAP), infinite: false };
}

/** The page under a document point, or (for paged notes) null when in a gap/outside. */
export function slotAt(layout: DocLayout, x: number, y: number): PageSlot | null {
  if (layout.infinite) return layout.slots[0]!;
  for (const s of layout.slots) if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
  return null;
}

/** The page whose vertical span is nearest a document y (page indicator, scroll targets). */
export function nearestSlot(layout: DocLayout, y: number): PageSlot {
  let best = layout.slots[0]!;
  let bestD = Infinity;
  for (const s of layout.slots) {
    const d = y < s.y ? s.y - y : y > s.y + s.h ? y - (s.y + s.h) : 0;
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
