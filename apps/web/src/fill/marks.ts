import { newId, type InkPoint, type InkStroke } from '@inkstone/core';
import type { Box } from './snap.ts';

/**
 * The small marks people put on paper forms — a checkmark, a cross — made as real ink strokes,
 * so they look hand-drawn, move/resize/recolour like any ink and export as vectors.
 */

/** Dark blue-black, the colour of a ballpoint on a form. */
export const FORM_INK = '#FF1B1F24';

function polyline(corners: [number, number][], t0: number): InkPoint[] {
  const out: InkPoint[] = [];
  let t = t0;
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1]!;
    const [bx, by] = corners[i]!;
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 1.5));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      // Pressure swells in the middle of each segment like a quick pen flick.
      const f = k / n;
      out.push({ x: ax + (bx - ax) * f, y: ay + (by - ay) * f, t: (t += 6), p: 0.45 + 0.35 * Math.sin(Math.PI * f), tilt: -1, orient: -1 });
    }
  }
  return out;
}

const penSize = (b: Box) => Math.max(1.3, Math.min(3, Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.12));

export function checkmark(b: Box, color = FORM_INK, now = Date.now(), makeId: () => string = () => newId()): InkStroke[] {
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const pts = polyline([[b.minX + w * 0.05, b.minY + h * 0.55], [b.minX + w * 0.38, b.maxY - h * 0.05], [b.maxX, b.minY + h * 0.02]], 0);
  return [{ id: makeId(), pen: 'ballpoint', color, size: penSize(b), points: pts, createdAt: now }];
}

export function cross(b: Box, color = FORM_INK, now = Date.now(), makeId: () => string = () => newId()): InkStroke[] {
  return [
    { id: makeId(), pen: 'ballpoint', color, size: penSize(b), points: polyline([[b.minX, b.minY], [b.maxX, b.maxY]], 0), createdAt: now },
    { id: makeId(), pen: 'ballpoint', color, size: penSize(b), points: polyline([[b.maxX, b.minY], [b.minX, b.maxY]], 0), createdAt: now + 1 },
  ];
}

/** Today's date the way the reader's locale writes it on a form ("11/01/2026", "01/11/2026"). */
export function formDate(d = new Date(), locale?: string): string {
  return d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}
