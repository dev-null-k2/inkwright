import {
  STICKY_FONT, STICKY_ICON, STICKY_PAD, argbToCss, isOverlay, tapeCorners, wrapStickyText,
  type PageInk, type StickyObject, type TapeObject,
} from '@inkstone/core';
import { FONT_FAMILIES, drawStroke } from '../canvas/render.ts';

/**
 * Canvas drawing of overlay objects — sticky notes and tape — over a page's ink. The same picture
 * as the SVG (core overlays.ts) and PDF (studio/pdf.ts) exporters, so thumbnails, PNG export, the
 * AI's page images and the screen agree.
 */
export interface OverlayDrawOptions {
  /** Tape strips the reader has revealed (screen only; exports always cover). */
  revealed?: ReadonlySet<string>;
  revealAll?: boolean;
  /** Sticky being edited on screen (its text is shown in the editor instead). */
  editingSticky?: string | null;
}

export function drawOverlays(ctx: CanvasRenderingContext2D, page: Pick<PageInk, 'objects'>, opts: OverlayDrawOptions = {}): void {
  const list = page.objects?.filter(isOverlay);
  if (!list?.length) return;
  for (const o of list) {
    ctx.save();
    if (o.type === 'tape') drawTape(ctx, o, !!opts.revealAll || !!opts.revealed?.has(o.id));
    else drawSticky(ctx, o, opts.editingSticky === o.id);
    ctx.restore();
  }
}

function tapePath(ctx: CanvasRenderingContext2D, t: TapeObject) {
  const c = tapeCorners(t);
  ctx.beginPath();
  ctx.moveTo(c[0]!.x, c[0]!.y);
  for (let i = 1; i < 4; i++) ctx.lineTo(c[i]!.x, c[i]!.y);
  ctx.closePath();
}

/** Opaque strip with a faint woven texture; revealed, only a dashed outline remains. */
export function drawTape(ctx: CanvasRenderingContext2D, t: TapeObject, revealed: boolean) {
  tapePath(ctx, t);
  if (revealed) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = argbToCss(t.color, 0.75);
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  ctx.fillStyle = argbToCss(t.color, 1);
  ctx.fill();
  ctx.clip();
  // Washi weave: thin diagonal threads, a shade lighter.
  const len = Math.hypot(t.dx, t.dy);
  const ang = Math.atan2(t.dy, t.dx);
  ctx.translate(t.x, t.y);
  ctx.rotate(ang);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = -t.width; x < len + t.width; x += 5) { ctx.moveTo(x, -t.width / 2); ctx.lineTo(x + t.width, t.width / 2); }
  ctx.stroke();
}

export function drawSticky(ctx: CanvasRenderingContext2D, s: StickyObject, editing = false) {
  if (s.collapsed) {
    const k = STICKY_ICON;
    ctx.shadowColor = 'rgba(20,30,40,0.22)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1.5;
    ctx.fillStyle = argbToCss(s.color);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + k, s.y);
    ctx.lineTo(s.x + k, s.y + k * 0.68);
    ctx.lineTo(s.x + k * 0.68, s.y + k);
    ctx.lineTo(s.x, s.y + k);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = 'transparent';
    // The folded corner.
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.moveTo(s.x + k, s.y + k * 0.68);
    ctx.lineTo(s.x + k * 0.68, s.y + k * 0.68);
    ctx.lineTo(s.x + k * 0.68, s.y + k);
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.shadowColor = 'rgba(20,30,40,0.2)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2.5;
  ctx.fillStyle = argbToCss(s.color);
  ctx.beginPath();
  ctx.roundRect(s.x, s.y, s.width, s.height, 3);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.beginPath();
  ctx.rect(s.x, s.y, s.width, s.height);
  ctx.clip();
  if (s.text?.trim() && !editing) {
    ctx.fillStyle = '#1b1f24';
    ctx.font = `400 ${STICKY_FONT}px ${FONT_FAMILIES.sans}`;
    ctx.textBaseline = 'alphabetic';
    wrapStickyText(s.text, s.width - STICKY_PAD * 2, STICKY_FONT).forEach((l, i) => ctx.fillText(l, s.x + STICKY_PAD, s.y + STICKY_PAD + STICKY_FONT * (i + 1) * 1.3 - STICKY_FONT * 0.3));
  }
  // Ink is stored relative to the sticky: draw it translated so each stroke's cached path is reused.
  ctx.translate(s.x, s.y);
  for (const st of s.strokes ?? []) drawStroke(ctx, st, { paperColor: argbToCss(s.color) });
  ctx.restore();
}
