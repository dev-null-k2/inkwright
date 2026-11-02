/**
 * Photo to ink, part two: from a binary ink mask to centre lines. Zhang–Suen thinning gives a
 * one-pixel skeleton; a chamfer distance transform gives the ink's half-width at every skeleton
 * pixel (so strokes keep their thickness); tracing walks the skeleton graph into polylines,
 * prunes short spurs that thinning leaves at blobby ends, and joins pieces across junctions
 * where the line clearly continues (so a "t" stays two strokes, not four).
 */

/** Zhang–Suen thinning (1984), in place on a copy. Only ink pixels are visited each pass. */
export function zhangSuen(bin: Uint8Array, w: number, h: number): Uint8Array {
  const img = new Uint8Array(bin);
  for (let x = 0; x < w; x++) { img[x] = 0; img[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { img[y * w] = 0; img[y * w + w - 1] = 0; }
  let active: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i]) active.push(i);
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      del.length = 0;
      for (const p of active) {
        if (!img[p]) continue;
        const p2 = img[p - w]!, p3 = img[p - w + 1]!, p4 = img[p + 1]!, p5 = img[p + w + 1]!;
        const p6 = img[p + w]!, p7 = img[p + w - 1]!, p8 = img[p - 1]!, p9 = img[p - w - 1]!;
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (A !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(p);
      }
      for (const p of del) img[p] = 0;
      if (del.length) changed = true;
    }
    active = active.filter((p) => img[p]);
  }
  return img;
}

/** Chamfer (3-4) distance from each ink pixel to the nearest background pixel, in pixels. */
export function distanceTransform(bin: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = bin[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i]!;
    if (x > 0) v = Math.min(v, d[i - 1]! + 3);
    if (y > 0) {
      v = Math.min(v, d[i - w]! + 3);
      if (x > 0) v = Math.min(v, d[i - w - 1]! + 4);
      if (x < w - 1) v = Math.min(v, d[i - w + 1]! + 4);
    }
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) v = Math.min(v, 3);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i]!;
    if (x < w - 1) v = Math.min(v, d[i + 1]! + 3);
    if (y < h - 1) {
      v = Math.min(v, d[i + w]! + 3);
      if (x < w - 1) v = Math.min(v, d[i + w + 1]! + 4);
      if (x > 0) v = Math.min(v, d[i + w - 1]! + 4);
    }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i]! / 3;
  return d;
}

export interface TracedPath {
  /** Pixel coordinates along the centre line. */
  points: { x: number; y: number }[];
  /** Half-width of the ink at each point, pixels. */
  radius: number[];
}

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const;

/** Walks a skeleton into polylines (see the module comment). */
export function traceSkeleton(skel: Uint8Array, w: number, h: number, dist: Float32Array, opts: { spur?: number } = {}): TracedPath[] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? skel[y * w + x]! : 0);
  const nbrs = (p: number): number[] => {
    const x = p % w, y = (p - x) / w;
    const out: number[] = [];
    for (const [dx, dy] of N8) {
      if (!at(x + dx, y + dy)) continue;
      // A diagonal step that an orthogonal pixel already bridges is the same connection twice
      // (pixel staircases); counting it would make every stair a junction.
      if (dx && dy && (at(x + dx, y) || at(x, y + dy))) continue;
      out.push((y + dy) * w + x + dx);
    }
    return out;
  };
  const deg = new Uint8Array(w * h);
  const pixels: number[] = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) { pixels.push(i); deg[i] = nbrs(i).length; }
  const isNode = (p: number) => deg[p] !== 2;
  const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const usedEdges = new Set<string>();
  const raw: number[][] = [];
  const walk = (start: number, first: number) => {
    const path = [start, first];
    usedEdges.add(edgeKey(start, first));
    let prev = start, cur = first;
    while (!isNode(cur)) {
      const next = nbrs(cur).find((q) => q !== prev && !usedEdges.has(edgeKey(cur, q)));
      if (next == null) break;
      usedEdges.add(edgeKey(cur, next));
      path.push(next);
      prev = cur; cur = next;
      if (cur === start) break;
    }
    raw.push(path);
  };
  for (const p of pixels) if (isNode(p)) for (const q of nbrs(p)) if (!usedEdges.has(edgeKey(p, q))) walk(p, q);
  // Pure loops (an "o") have no nodes: start anywhere on them.
  for (const p of pixels) for (const q of nbrs(p)) if (!usedEdges.has(edgeKey(p, q))) walk(p, q);
  for (const p of pixels) if (deg[p] === 0) raw.push([p]);

  // Junction clusters: adjacent junction pixels act as one junction.
  const toXY = (p: number) => ({ x: p % w, y: Math.floor(p / w) });
  let paths = raw.map((ps) => ps.map(toXY));
  const spur = opts.spur ?? 4;
  const len = (ps: { x: number; y: number }[]) => { let l = 0; for (let i = 1; i < ps.length; i++) l += Math.hypot(ps[i]!.x - ps[i - 1]!.x, ps[i]!.y - ps[i - 1]!.y); return l; };
  const endDeg = (pt: { x: number; y: number }) => deg[pt.y * w + pt.x]!;
  // Prune spurs: short branches from a junction to a free end.
  paths = paths.filter((ps) => {
    if (ps.length < 2) return true;
    const a = endDeg(ps[0]!), b = endDeg(ps[ps.length - 1]!);
    const isSpur = (a >= 3 && b === 1) || (a === 1 && b >= 3);
    const r = Math.max(...ps.map((p) => dist[p.y * w + p.x]!));
    return !(isSpur && len(ps) < Math.max(spur, r * 1.6));
  });

  // Join pieces that continue straight through a junction.
  const dirAt = (ps: { x: number; y: number }[], fromEnd: boolean) => {
    const k = Math.min(ps.length - 1, 6);
    const a = fromEnd ? ps[ps.length - 1]! : ps[0]!, b = fromEnd ? ps[ps.length - 1 - k]! : ps[k]!;
    const l = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    return { x: (a.x - b.x) / l, y: (a.y - b.y) / l };
  };
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < paths.length; i++) {
      for (const endI of [true, false]) {
        const pi = paths[i]!;
        if (pi.length < 3) continue;
        const e = endI ? pi[pi.length - 1]! : pi[0]!;
        if (endDeg(e) < 3) continue;
        const di = dirAt(pi, endI);
        let best = -1, bestEnd = true, bestCos = Math.cos((40 * Math.PI) / 180);
        for (let j = 0; j < paths.length; j++) {
          if (j === i || paths[j]!.length < 3) continue;
          for (const endJ of [true, false]) {
            const pj = paths[j]!;
            const f = endJ ? pj[pj.length - 1]! : pj[0]!;
            if (Math.abs(f.x - e.x) > 2 || Math.abs(f.y - e.y) > 2) continue;
            const dj = dirAt(pj, endJ);
            const c = -(di.x * dj.x + di.y * dj.y); // continuing means opposite outward directions
            if (c > bestCos) { bestCos = c; best = j; bestEnd = endJ; }
          }
        }
        if (best >= 0) {
          const a = endI ? pi : [...pi].reverse();
          const b = bestEnd ? [...paths[best]!].reverse() : paths[best]!;
          paths[i] = [...a, ...b.slice(1)];
          paths.splice(best, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return paths.filter((ps) => ps.length > 1 || dist[ps[0]!.y * w + ps[0]!.x]! >= 1.5).map((ps) => ({ points: ps, radius: ps.map((p) => Math.max(0.5, dist[p.y * w + p.x]!)) }));
}

/** Ramer–Douglas–Peucker on parallel point/radius arrays. */
export function simplifyPath(p: TracedPath, epsilon: number): TracedPath {
  const pts = p.points;
  if (pts.length < 3) return p;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  // A closed loop starts and ends on the same pixel: split it at its farthest point first, or
  // every point would be "on the chord" and the loop would vanish.
  let far0 = 0, farD = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i]!.x - pts[0]!.x, pts[i]!.y - pts[0]!.y); if (d > farD) { farD = d; far0 = i; } }
  const closed = Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y) < 1.5 && far0 > 0;
  if (closed) keep[far0] = 1;
  const stack: [number, number][] = closed ? [[0, far0], [far0, pts.length - 1]] : [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, fd = epsilon;
    const A = pts[a]!, B = pts[b]!;
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((B.x - A.x) * (A.y - pts[i]!.y) - (A.x - pts[i]!.x) * (B.y - A.y)) / L;
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const idx = [...keep.keys()].filter((i) => keep[i]);
  return { points: idx.map((i) => pts[i]!), radius: idx.map((i) => p.radius[i]!) };
}

/** Light smoothing (moving average) that keeps the ends in place: removes the pixel staircase. */
export function smoothPath(p: TracedPath, k = 2): TracedPath {
  const n = p.points.length;
  if (n < 5) return p;
  const pts = p.points.map((q, i) => {
    if (i === 0 || i === n - 1) return q;
    let x = 0, y = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { x += p.points[j]!.x; y += p.points[j]!.y; c++; }
    return { x: x / c, y: y / c };
  });
  return { points: pts, radius: p.radius };
}
