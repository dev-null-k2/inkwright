import { extractGraph, type DagGraph } from '../../src/index.ts';
import type { Sketch } from './sketches.ts';

/** Compares an extracted graph with a sketch's truth (nodes matched by overlap). */
export function scoreSketch(s: Sketch, g: DagGraph = extractGraph(s)) {
  const iou = (a: Sketch['truth']['nodes'][number]['rect'], b: Sketch['truth']['nodes'][number]['rect']) => {
    const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
    const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
    const inter = ix * iy;
    const area = (r: typeof a) => (r.maxX - r.minX) * (r.maxY - r.minY);
    return inter / (area(a) + area(b) - inter);
  };
  const map = new Map<string, number>();
  g.nodes.forEach((n) => {
    let best = -1, bv = 0.5;
    s.truth.nodes.forEach((t, i) => { const v = iou(n.rect, t.rect); if (v > bv && ![...map.values()].includes(i)) { bv = v; best = i; } });
    if (best >= 0) map.set(n.id, best);
  });
  const nodeTp = map.size;
  const labelsOk = g.nodes.filter((n) => map.has(n.id) && (n.label === s.truth.nodes[map.get(n.id)!]!.label || (n.labelFrom === 'none' && n.unreadStrokeIds.length > 0))).length;
  const found = new Set(g.edges.map((e) => `${map.get(e.from)}>${map.get(e.to)}`));
  const truth = new Set(s.truth.edges.map(([a, b]) => `${a}>${b}`));
  const edgeTp = [...found].filter((e) => truth.has(e)).length;
  const exact = nodeTp === s.truth.nodes.length && g.nodes.length === s.truth.nodes.length && edgeTp === truth.size && found.size === truth.size && g.edges.length === truth.size && labelsOk === g.nodes.length && (g.cycles.length > 0) === s.truth.cyclic;
  return { nodeTp, nodesFound: g.nodes.length, nodesTrue: s.truth.nodes.length, edgeTp, edgesFound: g.edges.length, edgesTrue: truth.size, labelsOk, exact, cycleOk: (g.cycles.length > 0) === s.truth.cyclic };
}
