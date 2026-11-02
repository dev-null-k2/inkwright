import {
  STICKY_FONT, STICKY_ICON, STICKY_PAD, argbToHexOpacity, centerlineSvgPath, isOverlay, outlineToSvgPath, penLook, stickyStrokesOnPage,
  strokeOutline, tapeCorners, wrapStickyText, type PageInk,
} from '@inkstone/core';
import { LineCapStyle, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/** Points per page unit (as in lib/pdfdraw.ts). */
const K = 72 / 96;

const col = (argb: string) => {
  const { rgb: hex, opacity } = argbToHexOpacity(argb);
  const h = hex.replace('#', '');
  return { color: rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255), opacity };
};

/** Characters the standard PDF fonts can encode (others are dropped from sticky text). */
const encodable = (s: string) => s.replace(/[^\x20-\x7E -ÿ‘’“”–—•…]/g, '');

/**
 * Sticky notes and tape in exported PDFs, as vectors over the ink — the same picture as the
 * canvas (studio/render.ts) and SVG (core overlays.ts). Tape always covers in exports.
 */
export function drawOverlaysPdf(p: PDFPage, page: Pick<PageInk, 'objects'>, H: number, font: PDFFont): void {
  for (const o of (page.objects ?? []).filter(isOverlay)) {
    if (o.type === 'tape') {
      const c = tapeCorners(o);
      const d = `M${c[0]!.x} ${c[0]!.y}L${c[1]!.x} ${c[1]!.y}L${c[2]!.x} ${c[2]!.y}L${c[3]!.x} ${c[3]!.y}Z`;
      p.drawSvgPath(d, { x: 0, y: H, scale: K, color: col(o.color).color, opacity: 1, borderWidth: 0 });
      continue;
    }
    const { color } = col(o.color);
    if (o.collapsed) {
      const s = STICKY_ICON;
      p.drawSvgPath(`M${o.x} ${o.y}h${s}v${s * 0.68}l${-s * 0.32} ${s * 0.32}h${-s * 0.68}Z`, { x: 0, y: H, scale: K, color, opacity: 1, borderColor: rgb(0, 0, 0), borderOpacity: 0.18, borderWidth: 0.4 });
      continue;
    }
    p.drawRectangle({ x: o.x * K, y: H - (o.y + o.height) * K, width: o.width * K, height: o.height * K, color, opacity: 1, borderColor: rgb(0, 0, 0), borderOpacity: 0.12, borderWidth: 0.4 });
    if (o.text?.trim()) {
      wrapStickyText(o.text, o.width - STICKY_PAD * 2, STICKY_FONT).forEach((line, i) => {
        const y = o.y + STICKY_PAD + STICKY_FONT * (i + 1) * 1.3 - STICKY_FONT * 0.3;
        if (y > o.y + o.height) return;
        try { p.drawText(encodable(line), { x: (o.x + STICKY_PAD) * K, y: H - y * K, size: STICKY_FONT * K, font, color: rgb(0.106, 0.122, 0.141) }); } catch { /* glyph not in font */ }
      });
    }
    for (const s of stickyStrokesOnPage(o)) {
      const look = penLook(s.pen);
      const c = col(s.color);
      if (look.dashed) p.drawSvgPath(centerlineSvgPath(s.points), { x: 0, y: H, scale: K, borderColor: c.color, borderWidth: s.size, borderOpacity: c.opacity, borderDashArray: [s.size * 3, s.size * 2.2], borderLineCap: LineCapStyle.Round });
      else p.drawSvgPath(outlineToSvgPath(strokeOutline(s)), { x: 0, y: H, scale: K, color: c.color, opacity: c.opacity * look.opacity, borderWidth: 0 });
    }
  }
}
