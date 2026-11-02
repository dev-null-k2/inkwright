import { useEffect, useRef } from 'react';
import type { PageSize, PaperSpec } from '@inkwright/core';
import { drawPaper } from '../canvas/render.ts';

/** A miniature sheet of paper drawn with the real template geometry. */
export function PaperPreview({ paper, size, width = 72, board }: { paper: PaperSpec; size: PageSize; width?: number; board?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = board ? 900 : size.width || 794;
  const h = board ? 675 : size.height || 1123;
  const height = Math.round((width * h) / w);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const k = (width * dpr) / w;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const r = { minX: 0, minY: 0, maxX: w, maxY: h };
    // Exaggerate line weight so it reads at thumbnail size.
    drawPaper({ ctx, scale: k * 0.45, visible: r }, paper, board ? null : r, r);
  }, [paper, w, h, width, height, board]);
  return <canvas ref={ref} className="paper-preview" style={{ width, height }} aria-hidden />;
}
