/**
 * Diagram page objects in exported PDFs: the same primitives the canvas draws (./diagramRender.ts),
 * through pdf-lib. A file of its own so pdf-lib (≈ 250 kB) loads with PDF export, not at startup.
 */
import { argbToHexOpacity, type DiagramObject } from '@inkwright/core';
import { rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { sceneOf } from './diagramRender.ts';

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
