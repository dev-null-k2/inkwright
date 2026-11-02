import { argbToHexOpacity, cellRect, colEdges, formatMathNumber, graphGeometry, mathWidth, rowEdges, type GraphObject, type MathObject, type PageInk, type TableObject } from '@inkwright/core';
import { LineCapStyle, rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';
import { canvasBytes } from '../lib/canvasBytes.ts';
import { tableCellFontSize, drawPageObjects } from './render.ts';
import { drawDiagramPdf } from '../dev/diagramRender.ts';

/**
 * Page objects in exported PDFs: tables and graphs as vectors (crisp at any zoom, table text is
 * real text), solved results rasterized at print resolution (they use a handwriting-style font
 * the standard PDF fonts do not have).
 */

/** Points per page unit. */
const K = 72 / 96;

const col = (hex: string) => {
  const { rgb: c, opacity } = argbToHexOpacity(hex);
  const h = c.replace('#', '');
  return { color: rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255), opacity };
};

export async function drawPageObjectsPdf(pdf: PDFDocument, p: PDFPage, page: PageInk, H: number, font: PDFFont, bold: PDFFont): Promise<void> {
  for (const o of page.objects ?? []) {
    if (o.type === 'table') tablePdf(p, o, H, font, bold);
    else if (o.type === 'graph') graphPdf(p, o, H, font);
    else if (o.type === 'math') await mathPdf(pdf, p, o, H);
    else if (o.type === 'diagram') drawDiagramPdf(p, o, H, font, bold);
  }
}

function tablePdf(p: PDFPage, t: TableObject, H: number, font: PDFFont, bold: PDFFont) {
  const { color, opacity } = col(t.color);
  const xs = colEdges(t), ys = rowEdges(t);
  const line = (x1: number, y1: number, x2: number, y2: number, w = t.lineWidth) =>
    p.drawLine({ start: { x: x1 * K, y: H - y1 * K }, end: { x: x2 * K, y: H - y2 * K }, thickness: w * K, color, opacity: opacity * 0.9, lineCap: LineCapStyle.Round });
  const x0 = xs[0]!, x1 = xs[xs.length - 1]!, y0 = ys[0]!, y1 = ys[ys.length - 1]!;
  line(x0, y0, x1, y0); line(x0, y1, x1, y1); line(x0, y0, x0, y1); line(x1, y0, x1, y1);
  for (let i = 1; i < xs.length - 1; i++) line(xs[i]!, y0, xs[i]!, y1);
  for (let i = 1; i < ys.length - 1; i++) line(x0, ys[i]!, x1, ys[i]!, t.header && i === 1 ? t.lineWidth * 1.8 : t.lineWidth);
  for (let r = 0; r < t.rows.length; r++) {
    for (let c = 0; c < t.cols.length; c++) {
      let text = t.cells[r]?.[c]?.text?.trim();
      if (!text) continue;
      const cr = cellRect(t, r, c);
      const size = tableCellFontSize(t, r);
      const f = t.header && r === 0 ? bold : font;
      // Fit the cell like the canvas clip does: trim characters that would overflow.
      const maxW = (cr.maxX - cr.minX - 10) * K;
      try {
        while (text.length > 1 && f.widthOfTextAtSize(text, size * K) > maxW) text = text.slice(0, -1);
        p.drawText(text, { x: (cr.minX + 6) * K, y: H - ((cr.minY + cr.maxY) / 2 + size * 0.35) * K, size: size * K, font: f, color, opacity });
      } catch { /* glyph not in the standard font: the cell's ink still carries it */ }
    }
  }
}

function graphPdf(p: PDFPage, g: GraphObject, H: number, font: PDFFont) {
  const geo = graphGeometry(g);
  const { plot } = geo;
  const grey = rgb(0.27, 0.3, 0.34);
  p.drawRectangle({ x: g.x * K, y: H - (g.y + g.height) * K, width: g.width * K, height: g.height * K, color: rgb(1, 1, 1), opacity: 0.6, borderColor: grey, borderOpacity: 0.3, borderWidth: 0.6 });
  const inside = (x: number, y: number) => x >= plot.x - 0.01 && x <= plot.x + plot.w + 0.01 && y >= plot.y - 0.01 && y <= plot.y + plot.h + 0.01;
  for (const x of geo.xTicks) {
    const q = geo.toPage(x, 0);
    p.drawLine({ start: { x: q.x * K, y: H - plot.y * K }, end: { x: q.x * K, y: H - (plot.y + plot.h) * K }, thickness: (x === 0 ? 1 : 0.5) * K, color: grey, opacity: x === 0 ? 0.85 : 0.15 });
    if (x !== 0 && q.x > plot.x + 8 && q.x < plot.x + plot.w - 8) {
      const o = geo.toPage(0, 0);
      const ly = Math.min(plot.y + plot.h - 10, Math.max(plot.y + 2, o.y + 3));
      const label = formatMathNumber(x).replace('−', '-');
      p.drawText(label, { x: q.x * K - font.widthOfTextAtSize(label, 8 * K) / 2, y: H - (ly + 7) * K, size: 8 * K, font, color: grey, opacity: 0.8 });
    }
  }
  for (const y of geo.yTicks) {
    const q = geo.toPage(0, y);
    p.drawLine({ start: { x: plot.x * K, y: H - q.y * K }, end: { x: (plot.x + plot.w) * K, y: H - q.y * K }, thickness: (y === 0 ? 1 : 0.5) * K, color: grey, opacity: y === 0 ? 0.85 : 0.15 });
  }
  geo.curves.forEach((cv, i) => {
    const { color } = col(cv.color);
    for (const l of cv.lines) {
      // Clip to the plot: keep runs of points inside it.
      let run: { x: number; y: number }[] = [];
      const flush = () => {
        if (run.length > 1) p.drawSvgPath(run.map((q, k) => `${k ? 'L' : 'M'}${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join(''), { x: 0, y: H, scale: K, borderColor: color, borderWidth: 2, borderLineCap: LineCapStyle.Round });
        run = [];
      };
      for (const q of l) { if (inside(q.x, q.y)) run.push(q); else flush(); }
      flush();
    }
    for (const r of cv.roots) { const q = geo.toPage(r, 0); p.drawCircle({ x: q.x * K, y: H - q.y * K, size: 3 * K, color }); }
    if (cv.yIntercept != null) { const q = geo.toPage(0, cv.yIntercept); if (inside(q.x, q.y)) p.drawCircle({ x: q.x * K, y: H - q.y * K, size: 3 * K, borderColor: color, borderWidth: 1.2 * K }); }
    try {
      p.drawText(`${cv.label ?? 'y'} = ${cv.expr}`, { x: (plot.x + 6) * K, y: H - (plot.y + 12 + i * 12) * K, size: 9.5 * K, font, color });
    } catch { /* non-Latin label */ }
  });
}

async function mathPdf(pdf: PDFDocument, p: PDFPage, m: MathObject, H: number) {
  const w = mathWidth(m) + 8, h = m.fontSize * 1.5;
  const k = 4;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * k) + 4;
  c.height = Math.ceil(h * k) + 4;
  const ctx = c.getContext('2d')!;
  ctx.scale(k, k);
  ctx.translate(-(m.x - 4), -m.y);
  drawPageObjects(ctx, { objects: [m] });
  const png = await pdf.embedPng(await canvasBytes(c, 'image/png'));
  p.drawImage(png, { x: (m.x - 4) * K, y: H - (m.y + c.height / k) * K, width: (c.width / k) * K, height: (c.height / k) * K });
}
