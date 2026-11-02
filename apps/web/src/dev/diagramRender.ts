/**
 * Diagram page objects on the canvas (the PDF side is ./diagramPdf.ts). Both draw the primitives
 * that `layoutDiagram` (@inkwright/core) produces — the same path data the SVG export uses — so
 * screen, thumbnails, SVG and PDF show one picture. Layouts are cached per IR object (they are pure).
 *
 * This file is on the startup path (the library draws thumbnails), so it must not import pdf-lib.
 */
import { argbToCss, layoutDiagram, type DiagramObject, type DiagramScene } from '@inkwright/core';

const scenes = new WeakMap<object, DiagramScene>();
/** The laid-out diagram, computed once per IR object. */
export function sceneOf(d: DiagramObject): DiagramScene {
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
