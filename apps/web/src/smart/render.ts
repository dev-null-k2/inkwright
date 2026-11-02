import { PAPER_TINTS, argbToCss, cellRect, pagePaper, type NoteMeta, colEdges, formatMathNumber, graphGeometry, mathWidth, rowEdges, type GraphObject, type MathObject, type PageInk, type TableObject } from '@inkstone/core';
import { FONT_FAMILIES } from '../canvas/render.ts';

/** Draws a page's objects for a note (graphs adapt to dark paper). Cheap when there are none. */
export function drawPageObjectsFor(ctx: CanvasRenderingContext2D, note: NoteMeta, page: PageInk) {
  if (!page.objects?.length) return;
  drawPageObjects(ctx, page, { dark: !page.background && !!PAPER_TINTS[pagePaper(note, page).tint]?.dark });
}

/**
 * Canvas drawing of page objects (tables, solved results, graphs) — the same picture the SVG
 * (core/objectsvg.ts) and PDF (smart/pdf.ts) exporters produce. Drawn under the ink.
 */
export function drawPageObjects(ctx: CanvasRenderingContext2D, page: Pick<PageInk, 'objects'>, opts: { dark?: boolean } = {}) {
  for (const o of page.objects ?? []) {
    ctx.save();
    if (o.type === 'table') drawTable(ctx, o);
    else if (o.type === 'math') drawMath(ctx, o);
    else if (o.type === 'graph') drawGraph(ctx, o, !!opts.dark);
    ctx.restore();
  }
}

export function tableCellFontSize(t: TableObject, r: number): number {
  return Math.max(9, Math.min(16, t.rows[r]! * 0.5));
}

function drawTable(ctx: CanvasRenderingContext2D, t: TableObject) {
  const xs = colEdges(t), ys = rowEdges(t);
  ctx.strokeStyle = argbToCss(t.color, 0.9);
  ctx.lineWidth = t.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.roundRect(xs[0]!, ys[0]!, xs[xs.length - 1]! - xs[0]!, ys[ys.length - 1]! - ys[0]!, 1.5);
  for (let i = 1; i < xs.length - 1; i++) { ctx.moveTo(xs[i]!, ys[0]!); ctx.lineTo(xs[i]!, ys[ys.length - 1]!); }
  for (let i = 1; i < ys.length - 1; i++) {
    if (t.header && i === 1) continue;
    ctx.moveTo(xs[0]!, ys[i]!); ctx.lineTo(xs[xs.length - 1]!, ys[i]!);
  }
  ctx.stroke();
  if (t.header && ys.length > 2) {
    ctx.lineWidth = t.lineWidth * 1.8;
    ctx.beginPath();
    ctx.moveTo(xs[0]!, ys[1]!); ctx.lineTo(xs[xs.length - 1]!, ys[1]!);
    ctx.stroke();
  }
  ctx.fillStyle = argbToCss(t.color);
  ctx.textBaseline = 'middle';
  for (let r = 0; r < t.rows.length; r++) {
    for (let c = 0; c < t.cols.length; c++) {
      const text = t.cells[r]?.[c]?.text?.trim();
      if (!text) continue;
      const cr = cellRect(t, r, c);
      const size = tableCellFontSize(t, r);
      ctx.font = `${t.header && r === 0 ? 650 : 400} ${size}px ${FONT_FAMILIES.sans}`;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cr.minX + 2, cr.minY + 1, cr.maxX - cr.minX - 4, cr.maxY - cr.minY - 2);
      ctx.clip();
      ctx.fillText(text, cr.minX + 6, (cr.minY + cr.maxY) / 2);
      ctx.restore();
    }
  }
}

function drawMath(ctx: CanvasRenderingContext2D, m: MathObject) {
  const w = mathWidth(m), h = m.fontSize * 1.5;
  // A faint wash and a dotted edge: clearly a computed result, never mistaken for the user's ink.
  ctx.fillStyle = argbToCss(m.color, 0.07);
  ctx.beginPath();
  ctx.roundRect(m.x - 4, m.y, w + 8, h, m.fontSize * 0.3);
  ctx.fill();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = argbToCss(m.color, 0.28);
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = argbToCss(m.color, 0.85);
  ctx.font = `500 ${m.fontSize * 1.15}px ${FONT_FAMILIES.hand}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(m.result, m.x, m.y + m.fontSize * 1.1);
}

function drawGraph(ctx: CanvasRenderingContext2D, g: GraphObject, dark: boolean) {
  const geo = graphGeometry(g);
  const { plot } = geo;
  const axis = dark ? 'rgba(220,226,232,0.85)' : 'rgba(70,78,88,0.85)';
  const grid = dark ? 'rgba(220,226,232,0.14)' : 'rgba(70,78,88,0.13)';
  ctx.fillStyle = dark ? 'rgba(20,24,30,0.55)' : 'rgba(255,255,255,0.6)';
  ctx.strokeStyle = dark ? 'rgba(220,226,232,0.3)' : 'rgba(70,78,88,0.3)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.roundRect(g.x, g.y, g.width, g.height, 4);
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.lineWidth = 0.6;
  for (const x of geo.xTicks) { const p = geo.toPage(x, 0); ctx.strokeStyle = x === 0 ? axis : grid; ctx.lineWidth = x === 0 ? 1 : 0.6; ctx.beginPath(); ctx.moveTo(p.x, plot.y); ctx.lineTo(p.x, plot.y + plot.h); ctx.stroke(); }
  for (const y of geo.yTicks) { const p = geo.toPage(0, y); ctx.strokeStyle = y === 0 ? axis : grid; ctx.lineWidth = y === 0 ? 1 : 0.6; ctx.beginPath(); ctx.moveTo(plot.x, p.y); ctx.lineTo(plot.x + plot.w, p.y); ctx.stroke(); }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const cv of geo.curves) {
    ctx.strokeStyle = argbToCss(cv.color);
    ctx.lineWidth = 2;
    for (const l of cv.lines) {
      ctx.beginPath();
      l.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.fillStyle = argbToCss(cv.color);
    for (const r of cv.roots) { const p = geo.toPage(r, 0); ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
    if (cv.yIntercept != null) { const p = geo.toPage(0, cv.yIntercept); ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.lineWidth = 1.2; ctx.stroke(); }
  }
  ctx.restore();
  // Labels: x ticks along the axis, y ticks beside it, a legend top-left.
  ctx.fillStyle = dark ? 'rgba(220,226,232,0.75)' : 'rgba(70,78,88,0.8)';
  ctx.font = `400 8px ${FONT_FAMILIES.sans}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const o = geo.toPage(0, 0);
  const ly = Math.min(plot.y + plot.h - 10, Math.max(plot.y + 2, o.y + 3));
  for (const x of geo.xTicks) if (x !== 0) { const p = geo.toPage(x, 0); if (p.x > plot.x + 8 && p.x < plot.x + plot.w - 8) ctx.fillText(formatMathNumber(x), p.x, ly); }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const lx = Math.min(plot.x + plot.w - 24, Math.max(plot.x + 2, o.x + 3));
  for (const y of geo.yTicks) if (y !== 0) { const p = geo.toPage(0, y); if (p.y > plot.y + 6 && p.y < plot.y + plot.h - 6) ctx.fillText(formatMathNumber(y), lx, p.y); }
  ctx.font = `500 9.5px ${FONT_FAMILIES.sans}`;
  ctx.textBaseline = 'top';
  geo.curves.forEach((cv, i) => {
    ctx.fillStyle = argbToCss(cv.color);
    ctx.fillText(`${cv.label ?? 'y'} = ${cv.expr}`, plot.x + 6, plot.y + 4 + i * 12);
  });
}
