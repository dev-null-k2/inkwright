import type { Rect } from './geometry.ts';
import type { ContentOrigin, InkPoint, InkStroke } from './model.ts';
import { strokeBounds, translateStroke } from './gestures.ts';
import { argbToHexOpacity } from './ids.ts';
import { formatNumber as f, outlineToSvgPath, penLook, strokeOutline, centerlineSvgPath } from './outline.ts';

/**
 * Overlay page objects: things that sit *on top of* the ink, like real paper on paper.
 *  - Sticky notes: a coloured square you write or type on, movable, resizable and collapsible to
 *    a small icon. Its handwriting belongs to it (`strokes`, in sticky coordinates), so it moves
 *    and collapses with the note and is drawn over the sticky's paper.
 *  - Tape: an opaque strip covering ink for self-testing; tapping it reveals what is underneath.
 *    Whether a strip is revealed is a view state of the open note, never saved: tape always
 *    covers again when the note is reopened, exported or printed.
 * Both are `PageInk.objects` (see objects.ts and docs/VAULT_FORMAT.md) and go through
 * `NoteDocument.editObjects`, so they undo, sync, and enter the authorship chain like any object.
 */

interface OverlayBase {
  id: string;
  /** Top-left corner (sticky) or start of the strip (tape), page units. */
  x: number;
  y: number;
  createdAt: number;
  /** Set when the overlay was not made by hand (a result an executable canvas step wrote). */
  origin?: ContentOrigin;
}

export interface StickyObject extends OverlayBase {
  type: 'sticky';
  width: number;
  height: number;
  /** Paper colour `#AARRGGBB`. */
  color: string;
  /** Typed text (plain text, shown at the top). */
  text?: string;
  /** Handwriting on the sticky, in coordinates relative to its top-left corner. */
  strokes?: InkStroke[];
  /** Folded away to a small icon at (x, y). */
  collapsed?: boolean;
}

export interface TapeObject extends OverlayBase {
  type: 'tape';
  /** The strip runs from (x, y) to (x + dx, y + dy). */
  dx: number;
  dy: number;
  /** Strip thickness, page units. */
  width: number;
  /** `#AARRGGBB` (drawn fully opaque). */
  color: string;
}

export type OverlayObject = StickyObject | TapeObject;

export const STICKY_COLORS = ['#FFFCE58A', '#FFFFC9A8', '#FFC9EBC3', '#FFBFE0F4', '#FFF3C6DC'] as const;
export const TAPE_COLORS = ['#FF8FA7B8', '#FFB9A58C', '#FF9DB79A', '#FFC79AA0'] as const;
/** Size of a collapsed sticky's icon, page units. */
export const STICKY_ICON = 26;
export const STICKY_DEFAULT = { width: 180, height: 180 } as const;
export const TAPE_DEFAULT_WIDTH = 20;

export function isOverlay(o: { type: string }): o is OverlayObject {
  return o.type === 'sticky' || o.type === 'tape';
}

/** Where a sticky is drawn: the whole square, or its icon when collapsed. */
export function stickyRect(s: StickyObject): Rect {
  if (s.collapsed) return { minX: s.x, minY: s.y, maxX: s.x + STICKY_ICON, maxY: s.y + STICKY_ICON };
  return { minX: s.x, minY: s.y, maxX: s.x + s.width, maxY: s.y + s.height };
}

/** The four corners of a tape strip (a rotated rectangle), clockwise from the start's left side. */
export function tapeCorners(t: TapeObject): { x: number; y: number }[] {
  const len = Math.hypot(t.dx, t.dy) || 1;
  const nx = (-t.dy / len) * (t.width / 2), ny = (t.dx / len) * (t.width / 2);
  return [
    { x: t.x + nx, y: t.y + ny },
    { x: t.x + t.dx + nx, y: t.y + t.dy + ny },
    { x: t.x + t.dx - nx, y: t.y + t.dy - ny },
    { x: t.x - nx, y: t.y - ny },
  ];
}

export function tapeRect(t: TapeObject): Rect {
  const c = tapeCorners(t);
  return { minX: Math.min(...c.map((p) => p.x)), minY: Math.min(...c.map((p) => p.y)), maxX: Math.max(...c.map((p) => p.x)), maxY: Math.max(...c.map((p) => p.y)) };
}

export function overlayRect(o: OverlayObject): Rect {
  return o.type === 'sticky' ? stickyRect(o) : tapeRect(o);
}

/** Distance from a point to the tape's centre line (segment). */
function segDist(t: TapeObject, px: number, py: number): number {
  const l2 = t.dx * t.dx + t.dy * t.dy;
  const u = l2 ? Math.max(0, Math.min(1, ((px - t.x) * t.dx + (py - t.y) * t.dy) / l2)) : 0;
  return Math.hypot(px - (t.x + u * t.dx), py - (t.y + u * t.dy));
}

/** Whether a page point is on the tape strip (with `slop` extra on each side for fingers). */
export function hitTape(t: TapeObject, x: number, y: number, slop = 0): boolean {
  return segDist(t, x, y) <= t.width / 2 + slop;
}

export function hitSticky(s: StickyObject, x: number, y: number, slop = 0): boolean {
  const r = stickyRect(s);
  return x >= r.minX - slop && x <= r.maxX + slop && y >= r.minY - slop && y <= r.maxY + slop;
}

/** The topmost overlay at a page point (later objects are drawn on top). */
export function overlayAt(objects: readonly { type: string }[] | undefined, x: number, y: number, slop = 0): OverlayObject | null {
  const list = (objects ?? []).filter(isOverlay);
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i]!;
    if (o.type === 'tape' ? hitTape(o, x, y, slop) : hitSticky(o, x, y, slop)) return o;
  }
  return null;
}

/** Makes a tape strip from a drag; null when the drag is too short to be one. */
export function tapeFromDrag(id: string, a: { x: number; y: number }, b: { x: number; y: number }, width: number, color: string, now: number, minLength = 8): TapeObject | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.hypot(dx, dy) < minLength) return null;
  return { type: 'tape', id, x: a.x, y: a.y, dx, dy, width, color, createdAt: now };
}

/** A stroke written on a sticky, in the sticky's own coordinates. */
export function strokeIntoSticky(s: StickyObject, stroke: InkStroke): StickyObject {
  return { ...s, strokes: [...(s.strokes ?? []), translateStroke(stroke, -s.x, -s.y)] };
}

/** The sticky's handwriting in page coordinates (for hit-testing and export). */
export function stickyStrokesOnPage(s: StickyObject): InkStroke[] {
  return (s.strokes ?? []).map((st) => translateStroke(st, s.x, s.y));
}

/**
 * Resizes a sticky; its handwriting keeps its size (like cutting a bigger piece of paper) but is
 * never left outside — the sticky can't be made smaller than the ink on it.
 */
export function resizeSticky(s: StickyObject, width: number, height: number, min = 60): StickyObject {
  let w = Math.max(min, width), h = Math.max(min, height);
  if (s.strokes?.length) {
    let maxX = 0, maxY = 0;
    for (const st of s.strokes) { const b = strokeBounds(st); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY); }
    w = Math.max(w, maxX + 4);
    h = Math.max(h, maxY + 4);
  }
  return { ...s, width: w, height: h };
}

/** Ink points under an eraser path, in sticky coordinates. */
export function toStickyPoint(s: StickyObject, p: { x: number; y: number }): InkPoint {
  return { x: p.x - s.x, y: p.y - s.y, t: 0, p: -1, tilt: -1, orient: -1 };
}

/** Plain text of overlays (search, note.md, agents): sticky text. Tape hides nothing from text. */
export function overlaysText(objects: readonly { type: string }[] | undefined): string {
  return (objects ?? []).filter(isOverlay).flatMap((o) => (o.type === 'sticky' && o.text?.trim() ? [`Sticky note: ${o.text.trim()}`] : [])).join('\n');
}

// ---- SVG ----------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SANS = "Inter, 'Helvetica Neue', Arial, sans-serif";

/** Wraps sticky text into lines that fit its width (approximate glyph width 0.52 em). */
export function wrapStickyText(text: string, width: number, fontSize: number): string[] {
  const max = Math.max(4, Math.floor(width / (fontSize * 0.52)));
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      if (!w) continue;
      if (line && (line + ' ' + w).length > max) { out.push(line); line = w; }
      else line = line ? line + ' ' + w : w;
    }
    out.push(line);
  }
  return out;
}

export const STICKY_FONT = 15;
export const STICKY_PAD = 10;

/** SVG of the page's overlays, drawn after (over) the ink. Tape is always covering here. */
export function overlaysSvg(objects: readonly { type: string }[] | undefined): string {
  const list = (objects ?? []).filter(isOverlay);
  if (!list.length) return '';
  const out: string[] = ['<g id="overlays">'];
  for (const o of list) {
    if (o.type === 'tape') {
      const c = argbToHexOpacity(o.color);
      const pts = tapeCorners(o).map((p) => `${f(p.x)},${f(p.y)}`).join(' ');
      out.push(`<polygon class="tape" points="${pts}" fill="${c.rgb}" stroke="${c.rgb}" stroke-width="0.6" stroke-linejoin="round"/>`);
      continue;
    }
    const c = argbToHexOpacity(o.color);
    if (o.collapsed) {
      const s = STICKY_ICON;
      out.push(`<g class="sticky is-collapsed"><path d="M${f(o.x)} ${f(o.y)}h${f(s)}v${f(s * 0.68)}l${f(-s * 0.32)} ${f(s * 0.32)}h${f(-s * 0.68)}z" fill="${c.rgb}" stroke="#000" stroke-opacity="0.18" stroke-width="0.6"/></g>`);
      continue;
    }
    out.push(`<g class="sticky"><rect x="${f(o.x)}" y="${f(o.y)}" width="${f(o.width)}" height="${f(o.height)}" rx="3" fill="${c.rgb}" stroke="#000" stroke-opacity="0.12" stroke-width="0.6"/>`);
    if (o.text?.trim()) {
      const lines = wrapStickyText(o.text, o.width - STICKY_PAD * 2, STICKY_FONT);
      out.push(`<text font-family="${SANS}" font-size="${STICKY_FONT}" fill="#1b1f24">${lines.map((l, i) => `<tspan x="${f(o.x + STICKY_PAD)}" y="${f(o.y + STICKY_PAD + STICKY_FONT * (i + 1) * 1.3 - STICKY_FONT * 0.3)}">${esc(l) || ' '}</tspan>`).join('')}</text>`);
    }
    for (const st of stickyStrokesOnPage(o)) {
      const look = penLook(st.pen);
      const sc = argbToHexOpacity(st.color);
      const op = f(Math.min(1, sc.opacity * look.opacity));
      if (look.dashed) out.push(`<path d="${centerlineSvgPath(st.points)}" fill="none" stroke="${sc.rgb}" stroke-opacity="${op}" stroke-width="${f(st.size)}"/>`);
      else out.push(`<path d="${outlineToSvgPath(strokeOutline(st))}" fill="${sc.rgb}" fill-opacity="${op}"/>`);
    }
    out.push('</g>');
  }
  out.push('</g>');
  return out.join('\n');
}
