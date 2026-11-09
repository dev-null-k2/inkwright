/**
 * A mind map of notes: the title in the middle, sections around it, their points around those.
 * Pure layout and an SVG (shown in the app, exported as a file); no AI involved.
 */
import type { MeetingNotesVersion } from './model.ts';

export interface MindNode {
  id: string;
  label: string;
  x: number;
  y: number;
  depth: 0 | 1 | 2;
  parent?: string;
  mine?: boolean;
  /** Anchor for the label: left of the point on the left half, right on the right. */
  side: 'left' | 'right' | 'center';
}

const trim = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** Radial layout: sections spread round the centre, points fanned out beyond their section. */
export function mindMapLayout(title: string, v: Pick<MeetingNotesVersion, 'sections'>, opts: { r1?: number; r2?: number; maxPoints?: number } = {}): MindNode[] {
  const r1 = opts.r1 ?? 190;
  const r2 = opts.r2 ?? 360;
  const max = opts.maxPoints ?? 6;
  const sections = v.sections.filter((s) => s.items.length).slice(0, 9);
  const nodes: MindNode[] = [{ id: 'root', label: trim(title || 'Notes', 40), x: 0, y: 0, depth: 0, side: 'center' }];
  const weights = sections.map((s) => Math.max(1, Math.min(max, s.items.filter((i) => !i.depth).length)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let angle = -Math.PI / 2 - (Math.PI * weights[0]!) / total;
  sections.forEach((s, si) => {
    const span = (2 * Math.PI * weights[si]!) / total;
    const mid = angle + span / 2;
    const sid = `s${si}`;
    const side = Math.cos(mid) < -0.15 ? 'left' : Math.cos(mid) > 0.15 ? 'right' : 'center';
    nodes.push({ id: sid, label: trim(s.heading, 32), x: Math.cos(mid) * r1, y: Math.sin(mid) * r1, depth: 1, parent: 'root', side });
    const points = s.items.filter((i) => !i.depth).slice(0, max);
    points.forEach((it, pi) => {
      const a = points.length === 1 ? mid : angle + (span * (pi + 0.5)) / points.length;
      const pside = Math.cos(a) < 0 ? 'left' : 'right';
      nodes.push({ id: `${sid}p${pi}`, label: trim(it.text, 46), x: Math.cos(a) * r2, y: Math.sin(a) * r2, depth: 2, parent: sid, ...(it.mine ? { mine: true } : {}), side: pside });
    });
    angle += span;
  });
  return nodes;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The mind map as a standalone SVG, in the given colours (light paper by default). */
export function mindMapSvg(nodes: readonly MindNode[], c: { paper?: string; ink?: string; ai?: string; line?: string; accent?: string } = {}): string {
  const paper = c.paper ?? '#fffdf7', ink = c.ink ?? '#2b2330', ai = c.ai ?? '#5f5666', line = c.line ?? '#c9c2cc', accent = c.accent ?? '#356b53';
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const pad = 260;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 60;
  const by = new Map(nodes.map((n) => [n.id, n]));
  const edges = nodes.filter((n) => n.parent).map((n) => {
    const p = by.get(n.parent!)!;
    const mx = (p.x + n.x) / 2;
    return `<path d="M${p.x.toFixed(1)} ${p.y.toFixed(1)} C${mx.toFixed(1)} ${p.y.toFixed(1)} ${mx.toFixed(1)} ${n.y.toFixed(1)} ${n.x.toFixed(1)} ${n.y.toFixed(1)}" fill="none" stroke="${n.depth === 1 ? accent : line}" stroke-width="${n.depth === 1 ? 2.2 : 1.3}" stroke-linecap="round"/>`;
  });
  const labels = nodes.map((n) => {
    if (n.depth === 0) return `<g><rect x="${(n.x - 8 * n.label.length * 0.62 - 20).toFixed(1)}" y="${(n.y - 22).toFixed(1)}" width="${(n.label.length * 0.62 * 16 + 40).toFixed(1)}" height="44" rx="22" fill="${ink}"/><text x="${n.x}" y="${n.y + 6}" text-anchor="middle" font-size="18" font-weight="650" fill="${paper}">${esc(n.label)}</text></g>`;
    const anchor = n.side === 'left' ? 'end' : n.side === 'right' ? 'start' : 'middle';
    const dx = n.side === 'left' ? -10 : n.side === 'right' ? 10 : 0;
    const dy = n.side === 'center' ? (n.y < 0 ? -12 : 22) : 5;
    const dot = `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.depth === 1 ? 5 : 3.5}" fill="${n.depth === 1 ? accent : n.mine ? ink : ai}"/>`;
    return `${dot}<text x="${(n.x + dx).toFixed(1)}" y="${(n.y + dy).toFixed(1)}" text-anchor="${anchor}" font-size="${n.depth === 1 ? 16 : 13.5}" font-weight="${n.depth === 1 || n.mine ? 650 : 450}" fill="${n.depth === 2 && !n.mine ? ai : ink}">${esc(n.label)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}" font-family="Hanken Grotesk, system-ui, sans-serif"><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${paper}"/>${edges.join('')}${labels.join('')}</svg>`;
}
