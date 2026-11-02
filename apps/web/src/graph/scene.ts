import type { ForceLayout, GraphData, GraphEdgeKind, GraphNodeKind } from '@inkwright/core';

/**
 * What the graph renderers draw, shared by the 3D (three.js) and 2D (canvas) views: nodes with
 * their colours and sizes, edges by kind, notebook clouds, and the palette read from the app's
 * CSS variables so the graph wears the same Duan / Aizome / Celadon / Sumi colours as the app.
 */

export type RGB = [number, number, number];

export interface GraphTheme {
  dark: boolean;
  desk: RGB;
  ink: RGB;
  ink2: RGB;
  ink3: RGB;
  iron: RGB;
  eye: RGB;
  eyeCore: RGB;
  raised: RGB;
  /** The palette has no shadows or motion (Sumi, e-ink). */
  flat: boolean;
}

export interface DisplayNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  color: RGB;
  /** Radius in layout units. */
  size: number;
  createdAt: number;
  cluster?: string;
  noteId?: string;
}

export interface DisplayEdge {
  s: number;
  t: number;
  kind: GraphEdgeKind;
  color: RGB;
  alpha: number;
}

export interface DisplayCluster {
  id: string;
  name: string;
  color: RGB;
  members: number[];
}

export interface DisplayGraph {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  clusters: DisplayCluster[];
  index: Map<string, number>;
}

/** Contract both renderers keep; GraphView drives them the same way. */
export interface GraphRenderer {
  readonly kind: '3d' | '2d';
  /** Frames drawn so far (tests use it to know the view is alive). */
  frames: number;
  setGraph(g: DisplayGraph, layout: ForceLayout): void;
  /** Target opacity per node (0 hidden … 1 full); renderers ease toward it. */
  setTargets(alpha: Float32Array, instant?: boolean): void;
  setSelected(id: string | null): void;
  setHovered(id: string | null): void;
  /** Nodes whose titles are shown. */
  setLabels(ids: readonly string[]): void;
  setTheme(t: GraphTheme): void;
  focus(id: string, animate: boolean): void;
  fit(animate: boolean): void;
  /** Node under a viewport point, if any. */
  pick(clientX: number, clientY: number): string | null;
  /** Where a node is on screen (viewport px), or null when hidden/behind. */
  screenPos(id: string): { x: number; y: number } | null;
  resize(): void;
  destroy(): void;
}

function parseColor(css: string, fallback: RGB): RGB {
  const s = css.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const n = parseInt(m[1]!, 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]!].map((c) => parseInt(c + c, 16) / 255) as RGB;
  const r = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (r) return [Number(r[1]) / 255, Number(r[2]) / 255, Number(r[3]) / 255];
  return fallback;
}

export const luminance = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const css = ([r, g, b]: RGB, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

/** The app palette, read from the CSS variables in effect right now. */
export function readTheme(el: Element = document.documentElement): GraphTheme {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: RGB) => parseColor(cs.getPropertyValue(name), fb);
  const desk = v('--desk', [0.91, 0.9, 0.92]);
  return {
    dark: luminance(desk) < 0.4,
    desk,
    ink: v('--ink', [0.17, 0.14, 0.19]),
    ink2: v('--ink-2', [0.37, 0.34, 0.4]),
    ink3: v('--ink-3', [0.54, 0.5, 0.56]),
    iron: v('--iron', [0.21, 0.42, 0.33]),
    eye: v('--eye', [0.37, 0.61, 0.49]),
    eyeCore: v('--eye-core', [0.17, 0.14, 0.19]),
    raised: v('--raised', [0.98, 0.98, 0.99]),
    flat: document.documentElement.getAttribute('data-palette') === 'sumi',
  };
}

/** `#AARRGGBB` → RGB. */
export function argbRgb(hex: string | undefined, fb: RGB): RGB {
  if (!hex) return fb;
  const c = hex.replace('#', '');
  const h = c.length === 8 ? c.slice(2) : c;
  return /^[0-9a-f]{6}$/i.test(h) ? parseColor(`#${h}`, fb) : fb;
}

/** A notebook colour that reads on this desk (dark covers are lifted at night, pale ones deepened by day). */
function onDesk(c: RGB, t: GraphTheme): RGB {
  const l = luminance(c);
  if (t.dark && l < 0.45) return mix(c, [1, 1, 1], 0.42 - l * 0.4);
  if (!t.dark && l > 0.7) return mix(c, t.ink, 0.35);
  return c;
}

const EDGE_ALPHA: Record<GraphEdgeKind, number> = { link: 0.62, related: 0.36, tag: 0.26, notebook: 0.2 };

/** Turns graph data into drawable nodes, edges and notebook clouds for a theme. */
export function displayGraph(data: GraphData, theme: GraphTheme): DisplayGraph {
  const index = new Map<string, number>();
  const nodes: DisplayNode[] = data.nodes.map((n, i) => {
    index.set(n.id, i);
    const base = n.kind === 'tag' ? theme.ink3 : n.color ? onDesk(argbRgb(n.color, theme.ink2), theme) : theme.ink2;
    const size = n.kind === 'note' ? 2.6 + Math.sqrt(n.degree) * 1.15 + Math.min(1.5, n.pageCount * 0.15) : n.kind === 'tag' ? 1.7 + Math.sqrt(n.degree) * 0.5 : 2.2;
    return { id: n.id, kind: n.kind, label: n.label, color: base, size, createdAt: n.createdAt, cluster: n.cluster, noteId: n.kind === 'note' ? n.id : undefined };
  });
  const edges: DisplayEdge[] = data.edges.map((e) => {
    const s = index.get(e.source)!, t = index.get(e.target)!;
    const color = e.kind === 'link' ? theme.ink2 : e.kind === 'related' ? theme.iron : e.kind === 'notebook' ? nodes[t]!.color : theme.ink3;
    return { s, t, kind: e.kind, color, alpha: EDGE_ALPHA[e.kind] * (e.kind === 'link' ? Math.min(1.4, 1 + (e.weight - 1) * 0.15) : 1) };
  });
  const clusters: DisplayCluster[] = data.clusters.map((c) => ({
    id: c.id, name: c.name, color: onDesk(argbRgb(c.color, theme.ink3), theme), members: c.nodeIds.map((id) => index.get(id)!).filter((i) => i != null),
  }));
  return { nodes, edges, clusters, index };
}

/** Centre and radius of a cluster in the current layout. */
export function clusterExtent(layout: ForceLayout, members: readonly number[]): { x: number; y: number; z: number; r: number } {
  let x = 0, y = 0, z = 0;
  for (const i of members) { x += layout.x[i]!; y += layout.y[i]!; z += layout.z[i]!; }
  const n = Math.max(1, members.length);
  x /= n; y /= n; z /= n;
  let r = 0;
  for (const i of members) r = Math.max(r, Math.hypot(layout.x[i]! - x, layout.y[i]! - y, layout.z[i]! - z));
  return { x, y, z, r: Math.max(18, r) };
}

/** Paints a suminagashi-style ring cloud (concentric floating-ink rings) for a notebook cluster. */
export function ringTexture(color: RGB, size = 256, seed = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const cx = size / 2;
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const grad = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
  grad.addColorStop(0, css(color, 0.42));
  grad.addColorStop(0.55, css(color, 0.16));
  grad.addColorStop(1, css(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // Rings drift a little, like ink on water.
  for (let r = 10 + rnd() * 8; r < cx * 0.92; r += 7 + rnd() * 9) {
    g.beginPath();
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const w = r * (1 + 0.045 * Math.sin(a * 3 + seed) + 0.03 * Math.cos(a * 5 + r * 0.1));
      const px = cx + Math.cos(a) * w, py = cx + Math.sin(a) * w;
      if (k) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.strokeStyle = css(color, 0.22 * (1 - r / cx));
    g.lineWidth = 1 + rnd() * 2.2;
    g.stroke();
  }
  return c;
}

export const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
