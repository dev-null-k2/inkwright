/**
 * Diagram page objects on the canvas and in exported PDFs. Both draw the primitives that
 * `layoutDiagram` (@inkwright/core) produces — the same path data the SVG export uses — so screen,
 * thumbnails, SVG and PDF show one picture. Layouts are cached per IR object (they are pure).
 */
import { argbToCss, argbToHexOpacity, layoutDiagram, type DiagramObject, type DiagramScene } from '@inkwright/core';
import { rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const scenes = new WeakMap<object, DiagramScene>();
function sceneOf(d: DiagramObject): DiagramScene {
  let s = scenes.get(d.ir);
  if (!s) scenes.set(d.ir, (s = layoutDiagram(d.ir)));
  return s;
}

const paths = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = paths.get(d);
  if (!p) {
    if (paths.size > 4000) paths.clear();
    paths.set(d, (p = new Path2D(d)));
  }
  return p;
}

/** Light ink on dark paper, like graphs. */
const inkFor = (d: DiagramObject, dark: boolean) => (dark ? '#FFE9E4EC' : d.color);

export function drawDiagram(ctx: CanvasRenderingContext2D, d: DiagramObject, opts: { dark?: boolean; font: string }) {
  const scene = sceneOf(d);
  const k = d.width / scene.width;
  const ink = inkFor(d, !!opts.dark);
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.scale(k, k);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const p of scene.prims) {
    const a = p.muted ? 0.62 : 1;
    if (p.t === 'path') {
      const path = path2d(p.d);
      if (p.fill === 'ink') { ctx.fillStyle = argbToCss(ink, a); ctx.fill(path); }
      else if (p.fill === 'wash') { ctx.fillStyle = argbToCss(ink, 0.035); ctx.fill(path); }
      if (p.stroke) {
        ctx.setLineDash(p.dash ? [5, 4] : []);
        ctx.strokeStyle = argbToCss(ink, a);
        ctx.lineWidth = p.width ?? 1.2;
        ctx.stroke(path);
      }
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = argbToCss(ink, a);
      ctx.font = `${p.weight ?? 400} ${p.size}px ${opts.font}`;
      ctx.textAlign = p.anchor === 'middle' ? 'center' : 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(p.text, p.x, p.y);
    }
  }
  ctx.restore();
}

/** Points per page unit (as in smart/pdf.ts). */
const K = 72 / 96;

export function drawDiagramPdf(page: PDFPage, d: DiagramObject, H: number, font: PDFFont, bold: PDFFont) {
  const scene = sceneOf(d);
  const k = (d.width / scene.width) * K;
  const { rgb: hex, opacity } = argbToHexOpacity(d.color);
  const h = hex.replace('#', '');
  const color = rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
  // drawSvgPath maps SVG's y-down coordinates from (x, y) downwards.
  const origin = { x: d.x * K, y: H - d.y * K, scale: k };
  for (const p of scene.prims) {
    const a = (p.muted ? 0.62 : 1) * opacity;
    if (p.t === 'path') {
      page.drawSvgPath(p.d, {
        ...origin,
        ...(p.fill === 'ink' ? { color, opacity: a } : p.fill === 'wash' ? { color, opacity: 0.035 } : {}),
        ...(p.stroke ? { borderColor: color, borderOpacity: a, borderWidth: (p.width ?? 1.2) * k, ...(p.dash ? { borderDashArray: [5 * k, 4 * k] } : {}) } : {}),
      });
    } else {
      const f = (p.weight ?? 400) >= 550 ? bold : font;
      const size = p.size * k;
      let w = 0;
      try { w = f.widthOfTextAtSize(p.text, size); } catch { continue; /* glyph outside the standard font */ }
      const x = d.x * K + p.x * k - (p.anchor === 'middle' ? w / 2 : 0);
      try { page.drawText(p.text, { x, y: H - (d.y * K + p.y * k), size, font: f, color, opacity: a }); } catch { /* skip unencodable text */ }
    }
  }
}
