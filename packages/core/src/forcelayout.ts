/**
 * A small, deterministic force-directed layout for the knowledge graph, in 2D or 3D:
 * many-body repulsion (Barnes–Hut above a few hundred nodes), springs along edges (shorter for
 * links than for tags or notebooks), a gentle pull of each note toward its notebook's centre (so
 * notebooks read as clusters) and a weak gravity that keeps islands on screen.
 *
 * The same ids always start in the same places (positions are seeded from the id), so the graph
 * looks the same every time it is opened and stays put while filters or the time slider change.
 */
import type { GraphData, GraphEdgeKind } from './graph.ts';

export interface Vec3 { x: number; y: number; z: number }

export interface LayoutOptions {
  dims?: 2 | 3;
  /** Start from these positions (e.g. the previous layout) where known. */
  initial?: ReadonlyMap<string, Vec3>;
}

const DISTANCE: Record<GraphEdgeKind, number> = { link: 34, related: 52, tag: 44, notebook: 58 };
const STRENGTH: Record<GraphEdgeKind, number> = { link: 0.9, related: 0.25, tag: 0.35, notebook: 0.45 };

/** FNV-1a → [0, 1) pair, so each id has a stable starting spot. */
function hash2(s: string): [number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  const a = (h >>> 0) / 4294967296;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return [a, (h >>> 0) / 4294967296];
}

interface Cell {
  // Bounds (cube) and aggregate
  cx: number; cy: number; cz: number; half: number;
  mass: number; mx: number; my: number; mz: number;
  body: number; // index of the single body, -1 if none / internal
  kids: (Cell | null)[] | null;
}

export class ForceLayout {
  readonly ids: string[];
  readonly index = new Map<string, number>();
  x: Float64Array; y: Float64Array; z: Float64Array;
  private vx: Float64Array; private vy: Float64Array; private vz: Float64Array;
  private charge: Float64Array;
  private links: { s: number; t: number; dist: number; strength: number; bias: number }[] = [];
  private cluster: Int32Array;
  private clusterCount: number;
  dims: 2 | 3;
  alpha = 1;
  readonly alphaMin = 0.003;
  private alphaDecay = 1 - Math.pow(0.003, 1 / 320);
  private velocityDecay = 0.4;

  constructor(data: GraphData, opts: LayoutOptions = {}) {
    this.dims = opts.dims ?? 3;
    const n = data.nodes.length;
    this.ids = data.nodes.map((d) => d.id);
    this.ids.forEach((id, i) => this.index.set(id, i));
    this.x = new Float64Array(n); this.y = new Float64Array(n); this.z = new Float64Array(n);
    this.vx = new Float64Array(n); this.vy = new Float64Array(n); this.vz = new Float64Array(n);
    this.charge = new Float64Array(n);
    const radius = 18 * Math.cbrt(Math.max(1, n)) + 10;
    data.nodes.forEach((d, i) => {
      const prev = opts.initial?.get(d.id);
      if (prev) { this.x[i] = prev.x; this.y[i] = prev.y; this.z[i] = this.dims === 3 ? prev.z : 0; }
      else {
        const [u, v] = hash2(d.id);
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const r = radius * (0.35 + 0.65 * ((u * 7.31 + v * 3.17) % 1));
        this.x[i] = r * Math.sin(phi) * Math.cos(theta);
        this.y[i] = r * Math.sin(phi) * Math.sin(theta);
        this.z[i] = this.dims === 3 ? r * Math.cos(phi) : 0;
      }
      // Hubs push harder so their neighbourhoods breathe.
      this.charge[i] = -(d.kind === 'notebook' ? 90 : d.kind === 'tag' ? 45 : 60) * (1 + Math.min(4, d.degree) * 0.08);
    });
    const degree = new Float64Array(n);
    const edges = data.edges.filter((e) => this.index.has(e.source) && this.index.has(e.target));
    for (const e of edges) { degree[this.index.get(e.source)!]++; degree[this.index.get(e.target)!]++; }
    for (const e of edges) {
      const s = this.index.get(e.source)!, t = this.index.get(e.target)!;
      if (s === t) continue;
      const w = e.kind === 'link' ? Math.min(2, 1 + Math.log(Math.max(1, e.weight)) * 0.3) : e.kind === 'related' ? 0.5 + e.weight : 1;
      this.links.push({
        s, t, dist: DISTANCE[e.kind] / Math.sqrt(w),
        strength: STRENGTH[e.kind] / Math.min(degree[s]!, degree[t]!),
        bias: degree[s]! / (degree[s]! + degree[t]!),
      });
    }
    const cl = new Map<string, number>();
    this.cluster = new Int32Array(n).fill(-1);
    data.nodes.forEach((d, i) => {
      if (!d.cluster) return;
      if (!cl.has(d.cluster)) cl.set(d.cluster, cl.size);
      this.cluster[i] = cl.get(d.cluster)!;
    });
    this.clusterCount = cl.size;
  }

  get size(): number { return this.ids.length; }

  get settled(): boolean { return this.alpha < this.alphaMin; }

  /** Wakes the layout up (after dragging or a dimension change). */
  reheat(alpha = 0.6): void { this.alpha = Math.max(this.alpha, alpha); }

  /** Switches between flat and deep; the layout re-settles from where it is. */
  setDims(d: 2 | 3): void {
    if (d === this.dims) return;
    this.dims = d;
    for (let i = 0; i < this.size; i++) {
      if (d === 2) { this.z[i] = 0; this.vz[i] = 0; }
      else this.z[i] = (hash2(this.ids[i]!)[0] - 0.5) * 40;
    }
    this.reheat(0.8);
  }

  position(id: string): Vec3 | null {
    const i = this.index.get(id);
    return i == null ? null : { x: this.x[i]!, y: this.y[i]!, z: this.z[i]! };
  }

  positions(): Map<string, Vec3> {
    const m = new Map<string, Vec3>();
    this.ids.forEach((id, i) => m.set(id, { x: this.x[i]!, y: this.y[i]!, z: this.z[i]! }));
    return m;
  }

  /** Runs up to [n] steps (stops early once settled). Returns the remaining alpha. */
  run(n: number): number {
    for (let k = 0; k < n && !this.settled; k++) this.tick();
    return this.alpha;
  }

  tick(): void {
    const n = this.size;
    if (!n) { this.alpha = 0; return; }
    this.alpha += (0 - this.alpha) * this.alphaDecay;
    const a = this.alpha;
    const { x, y, z, vx, vy, vz } = this;
    const three = this.dims === 3;

    // Springs.
    for (const l of this.links) {
      let dx = x[l.t]! + vx[l.t]! - x[l.s]! - vx[l.s]!;
      let dy = y[l.t]! + vy[l.t]! - y[l.s]! - vy[l.s]!;
      let dz = three ? z[l.t]! + vz[l.t]! - z[l.s]! - vz[l.s]! : 0;
      let d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const f = ((d - l.dist) / d) * a * l.strength;
      dx *= f; dy *= f; dz *= f;
      vx[l.t]! -= dx * l.bias; vy[l.t]! -= dy * l.bias; if (three) vz[l.t]! -= dz * l.bias;
      vx[l.s]! += dx * (1 - l.bias); vy[l.s]! += dy * (1 - l.bias); if (three) vz[l.s]! += dz * (1 - l.bias);
      void d;
    }

    // Repulsion.
    if (n <= 220) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = x[j]! - x[i]!, dy = y[j]! - y[i]!, dz = three ? z[j]! - z[i]! : 0;
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1e-6) { dx = (hash2(this.ids[j]!)[0] - 0.5) * 1e-3; dy = (hash2(this.ids[i]!)[1] - 0.5) * 1e-3; d2 = dx * dx + dy * dy; }
          if (d2 < 1) d2 = Math.sqrt(d2);
          const fi = (this.charge[j]! * a) / d2, fj = (this.charge[i]! * a) / d2;
          vx[i]! += dx * fi; vy[i]! += dy * fi; if (three) vz[i]! += dz * fi;
          vx[j]! -= dx * fj; vy[j]! -= dy * fj; if (three) vz[j]! -= dz * fj;
        }
      }
    } else this.barnesHut(a);

    // Notebook clusters: a soft pull toward the cluster centre.
    if (this.clusterCount) {
      const cx = new Float64Array(this.clusterCount), cy = new Float64Array(this.clusterCount), cz = new Float64Array(this.clusterCount), cn = new Float64Array(this.clusterCount);
      for (let i = 0; i < n; i++) { const c = this.cluster[i]!; if (c < 0) continue; cx[c]! += x[i]!; cy[c]! += y[i]!; cz[c]! += z[i]!; cn[c]!++; }
      const k = 0.06 * a;
      for (let i = 0; i < n; i++) {
        const c = this.cluster[i]!;
        if (c < 0 || cn[c]! < 2) continue;
        vx[i]! += (cx[c]! / cn[c]! - x[i]!) * k;
        vy[i]! += (cy[c]! / cn[c]! - y[i]!) * k;
        if (three) vz[i]! += (cz[c]! / cn[c]! - z[i]!) * k;
      }
    }

    // Weak gravity toward the origin, then integrate.
    const g = 0.03 * a;
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < n; i++) {
      vx[i]! -= x[i]! * g; vy[i]! -= y[i]! * g; if (three) vz[i]! -= z[i]! * g;
      vx[i]! *= 1 - this.velocityDecay; vy[i]! *= 1 - this.velocityDecay; vz[i]! *= 1 - this.velocityDecay;
      x[i]! += vx[i]!; y[i]! += vy[i]!;
      if (three) z[i]! += vz[i]!; else z[i] = 0;
      mx += x[i]!; my += y[i]!; mz += z[i]!;
    }
    // Keep the centre of mass at the origin so the camera never has to chase it.
    mx /= n; my /= n; mz /= n;
    for (let i = 0; i < n; i++) { x[i]! -= mx; y[i]! -= my; if (three) z[i]! -= mz; }
  }

  /** O(n log n) repulsion with an octree (a quadtree when flat: z is 0 everywhere). */
  private barnesHut(a: number) {
    const n = this.size;
    const { x, y, z, vx, vy, vz } = this;
    const three = this.dims === 3;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, x[i]!); maxX = Math.max(maxX, x[i]!);
      minY = Math.min(minY, y[i]!); maxY = Math.max(maxY, y[i]!);
      minZ = Math.min(minZ, z[i]!); maxZ = Math.max(maxZ, z[i]!);
    }
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 1;
    const root: Cell = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2, half, mass: 0, mx: 0, my: 0, mz: 0, body: -1, kids: null };
    const insert = (c: Cell, i: number, depth: number) => {
      const q = this.charge[i]!;
      // Aggregate (charge-weighted centre).
      const m = c.mass + q;
      c.mx = (c.mx * c.mass + x[i]! * q) / m; c.my = (c.my * c.mass + y[i]! * q) / m; c.mz = (c.mz * c.mass + z[i]! * q) / m;
      c.mass = m;
      if (!c.kids && c.body < 0 && c.mass === q) { c.body = i; return; }
      if (depth > 24) return; // coincident points: keep the aggregate only
      if (!c.kids) {
        c.kids = [null, null, null, null, null, null, null, null];
        const b = c.body;
        c.body = -1;
        if (b >= 0) this.place(c, b, depth, insert);
      }
      this.place(c, i, depth, insert);
    };
    for (let i = 0; i < n; i++) insert(root, i, 0);
    const theta2 = 0.81;
    for (let i = 0; i < n; i++) {
      const stack: Cell[] = [root];
      while (stack.length) {
        const c = stack.pop()!;
        if (!c.mass) continue;
        const dx = c.mx - x[i]!, dy = c.my - y[i]!, dz = three ? c.mz - z[i]! : 0;
        let d2 = dx * dx + dy * dy + dz * dz;
        const w = c.half * 2;
        if (c.body === i) continue;
        if (c.kids && (w * w) / (d2 || 1e-9) >= theta2) {
          for (const k of c.kids) if (k) stack.push(k);
          continue;
        }
        if (d2 < 1e-6) continue;
        if (d2 < 1) d2 = Math.sqrt(d2);
        const f = (c.mass * a) / d2;
        vx[i]! += dx * f; vy[i]! += dy * f; if (three) vz[i]! += dz * f;
      }
    }
  }

  private place(c: Cell, i: number, depth: number, insert: (c: Cell, i: number, depth: number) => void) {
    const ox = this.x[i]! >= c.cx ? 1 : 0, oy = this.y[i]! >= c.cy ? 1 : 0, oz = this.z[i]! >= c.cz ? 1 : 0;
    const k = ox | (oy << 1) | (oz << 2);
    let kid = c.kids![k];
    if (!kid) {
      const h = c.half / 2;
      kid = c.kids![k] = { cx: c.cx + (ox ? h : -h), cy: c.cy + (oy ? h : -h), cz: c.cz + (oz ? h : -h), half: h, mass: 0, mx: 0, my: 0, mz: 0, body: -1, kids: null };
    }
    insert(kid, i, depth + 1);
  }
}
