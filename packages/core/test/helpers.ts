import type { InkPoint, InkStroke, PenType } from '../src/index.ts';

type P = [number, number];

/** Synthesizes realistic pen input for tests. */
export function stroke(id: string, pts: P[], size = 2, pen: PenType = 'fountain', msPerPoint = 8): InkStroke {
  return {
    id,
    pen,
    color: '#FF1B1F24',
    size,
    createdAt: 0,
    points: pts.map(([x, y], i): InkPoint => ({ x, y, t: i * msPerPoint, p: 0.5, tilt: -1, orient: -1 })),
  };
}

/** Interpolates a polyline through corners at ~step spacing (like a digitizer). */
export function polyline(corners: P[], step = 2): P[] {
  const out: P[] = [];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1]!;
    const [bx, by] = corners[i]!;
    const n = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(corners[corners.length - 1]!);
  return out;
}

/** A cursive-looking word: moves right while oscillating gently. */
export function word(x0: number, y: number, width = 100): P[] {
  return Array.from({ length: 101 }, (_, i) => {
    const f = i / 100;
    return [x0 + f * width, y + 6 * Math.sin(f * 10 * Math.PI)] as P;
  });
}

export function horizontalScribble(x0: number, x1: number, y0: number, y1: number, passes: number): P[] {
  const corners = Array.from({ length: passes + 1 }, (_, i) => [i % 2 === 0 ? x0 : x1, y0 + ((y1 - y0) * i) / passes] as P);
  return polyline(corners, 2);
}

export function verticalScribble(x0: number, x1: number, yTop: number, yBottom: number, passes: number): P[] {
  const corners = Array.from({ length: passes + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / passes, i % 2 === 0 ? yTop : yBottom] as P);
  return polyline(corners, 2);
}

/** Points along a circle/ellipse with hand-like wobble. */
export function wobblyEllipse(cx: number, cy: number, rx: number, ry: number, wobble = 0.03, n = 90, overshoot = 0.06): P[] {
  const out: P[] = [];
  for (let i = 0; i <= n * (1 + overshoot); i++) {
    const t = (i / n) * Math.PI * 2;
    const w = 1 + wobble * Math.sin(i * 0.7) + wobble * 0.5 * Math.cos(i * 1.9);
    out.push([cx + rx * w * Math.cos(t), cy + ry * w * Math.sin(t)]);
  }
  return out;
}

export function jitter(pts: P[], amount: number, seed = 1): P[] {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return pts.map(([x, y]) => [x + r() * amount, y + r() * amount] as P);
}
