import { argbToHexOpacity } from './ids.ts';
import { formatMathNumber, graphGeometry } from './mathexpr.ts';
import { cellText, colEdges, rowEdges, type GraphObject, type MathObject, type PageObject, type TableObject } from './objects.ts';
import { formatNumber as f } from './outline.ts';
import { diagramObjectSvg } from './dev/diagram.ts';

/**
 * SVG for page objects (tables, solved results, graphs) — used by the page SVG export, the
 * vault's derived `pages/*.svg`, and the MCP server, so every tool sees the same page.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SANS = "Inter, 'Helvetica Neue', Arial, sans-serif";
const HAND = "'Caveat', 'Segoe Print', cursive";

/** Objects drawn under the ink (overlays — stickies, tape — are drawn over it by `overlaysSvg`). */
export function objectsSvg(objects: readonly PageObject[] | undefined): string {
  objects = objects?.filter((o) => o.type !== 'sticky' && o.type !== 'tape');
  if (!objects?.length) return '';
  const parts: string[] = ['<g id="objects">'];
  for (const o of objects) {
    if (o.type === 'table') parts.push(tableSvg(o));
    else if (o.type === 'math') parts.push(mathSvg(o));
    else if (o.type === 'graph') parts.push(graphSvg(o));
    else if (o.type === 'diagram') parts.push(diagramObjectSvg(o));
  }
  parts.push('</g>');
  return parts.join('\n');
}

function tableSvg(t: TableObject): string {
  const c = argbToHexOpacity(t.color);
  const xs = colEdges(t), ys = rowEdges(t);
  const out: string[] = [`<g class="table" stroke="${c.rgb}" stroke-opacity="${f(c.opacity)}" stroke-width="${f(t.lineWidth)}" fill="none">`];
  out.push(`<rect x="${f(t.x)}" y="${f(t.y)}" width="${f(xs[xs.length - 1]! - t.x)}" height="${f(ys[ys.length - 1]! - t.y)}" rx="1.5"/>`);
  for (let i = 1; i < xs.length - 1; i++) out.push(`<line x1="${f(xs[i]!)}" y1="${f(ys[0]!)}" x2="${f(xs[i]!)}" y2="${f(ys[ys.length - 1]!)}"/>`);
  for (let i = 1; i < ys.length - 1; i++) out.push(`<line x1="${f(xs[0]!)}" y1="${f(ys[i]!)}" x2="${f(xs[xs.length - 1]!)}" y2="${f(ys[i]!)}"${t.header && i === 1 ? ` stroke-width="${f(t.lineWidth * 1.8)}"` : ''}/>`);
  out.push('</g>');
  // Typed cell text (ink in cells is part of the page's strokes).
  for (let r = 0; r < t.rows.length; r++) {
    for (let col = 0; col < t.cols.length; col++) {
      const text = t.cells[r]?.[col]?.text?.trim();
      if (!text) continue;
      const size = Math.min(16, t.rows[r]! * 0.55);
      out.push(`<text x="${f(xs[col]! + 6)}" y="${f(ys[r]! + t.rows[r]! / 2 + size * 0.35)}" font-family="${SANS}" font-size="${f(size)}"${t.header && r === 0 ? ' font-weight="600"' : ''} fill="${c.rgb}">${esc(text)}</text>`);
    }
  }
  return out.join('\n');
}

function mathSvg(m: MathObject): string {
  const c = argbToHexOpacity(m.color);
  const w = Math.max(m.fontSize, m.result.length * m.fontSize * 0.5 + m.fontSize * 0.6);
  return [
    `<g class="math-result" data-origin="${m.origin}">`,
    `<rect x="${f(m.x - 4)}" y="${f(m.y)}" width="${f(w + 8)}" height="${f(m.fontSize * 1.5)}" rx="${f(m.fontSize * 0.3)}" fill="${c.rgb}" fill-opacity="0.07"/>`,
    `<text x="${f(m.x)}" y="${f(m.y + m.fontSize * 1.1)}" font-family="${HAND}" font-size="${f(m.fontSize * 1.15)}" fill="${c.rgb}" fill-opacity="${f(c.opacity * 0.85)}">${esc(m.result)}</text>`,
    '</g>',
  ].join('\n');
}

function graphSvg(g: GraphObject): string {
  const geo = graphGeometry(g);
  const { plot } = geo;
  const out: string[] = [`<g class="graph"><rect x="${f(g.x)}" y="${f(g.y)}" width="${f(g.width)}" height="${f(g.height)}" rx="4" fill="#ffffff" fill-opacity="0.6" stroke="#8a929c" stroke-opacity="0.5"/>`];
  const clipId = `clip-${g.id}`;
  out.push(`<clipPath id="${clipId}"><rect x="${f(plot.x)}" y="${f(plot.y)}" width="${f(plot.w)}" height="${f(plot.h)}"/></clipPath>`);
  out.push(`<g clip-path="url(#${clipId})">`);
  for (const x of geo.xTicks) { const p = geo.toPage(x, 0); out.push(`<line x1="${f(p.x)}" y1="${f(plot.y)}" x2="${f(p.x)}" y2="${f(plot.y + plot.h)}" stroke="#8a929c" stroke-opacity="${x === 0 ? 0.9 : 0.18}" stroke-width="${x === 0 ? 1 : 0.6}"/>`); }
  for (const y of geo.yTicks) { const p = geo.toPage(0, y); out.push(`<line x1="${f(plot.x)}" y1="${f(p.y)}" x2="${f(plot.x + plot.w)}" y2="${f(p.y)}" stroke="#8a929c" stroke-opacity="${y === 0 ? 0.9 : 0.18}" stroke-width="${y === 0 ? 1 : 0.6}"/>`); }
  for (const cv of geo.curves) {
    const c = argbToHexOpacity(cv.color);
    for (const l of cv.lines) out.push(`<polyline fill="none" stroke="${c.rgb}" stroke-width="2" stroke-linejoin="round" points="${l.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"/>`);
    for (const r of cv.roots) { const p = geo.toPage(r, 0); out.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="3" fill="${c.rgb}"/>`); }
    if (cv.yIntercept != null) { const p = geo.toPage(0, cv.yIntercept); out.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="3" fill="none" stroke="${c.rgb}"/>`); }
  }
  out.push('</g>');
  const origin = geo.toPage(0, 0);
  const ly = Math.min(plot.y + plot.h - 3, Math.max(plot.y + 10, origin.y + 11));
  for (const x of geo.xTicks) if (x !== 0) { const p = geo.toPage(x, 0); out.push(`<text x="${f(p.x)}" y="${f(ly)}" font-family="${SANS}" font-size="8" text-anchor="middle" fill="#5c646e">${esc(formatMathNumber(x))}</text>`); }
  geo.curves.forEach((cv, i) => {
    const c = argbToHexOpacity(cv.color);
    out.push(`<text x="${f(plot.x + 6)}" y="${f(plot.y + 12 + i * 12)}" font-family="${SANS}" font-size="9" fill="${c.rgb}">${esc(`${cv.label ?? 'y'} = ${cv.expr}`)}</text>`);
  });
  out.push('</g>');
  return out.join('\n');
}
