import { describe, expect, it } from 'vitest';
import {
  SearchIndex, matchScore, snippet, tokenize, paperElements, rect, strokeOutline, outlineToSvgPath, penLook,
  boundsOf, rectWidth, invert, multiply, applyAffine, scaling, translation, countReversals, convexHull, pointInPolygon, simplify,
  newNote, type NoteMeta, type PageInk,
} from '../src/index.ts';
import { stroke, word, polyline } from './helpers.ts';

const note = (id: string, title: string, tags: string[] = [], extra: Partial<NoteMeta> = {}): NoteMeta => ({ ...newNote({ id, title, pageId: 'p', now: Date.now() }), tags, ...extra });
const page = (text?: string): PageInk => ({ id: 'p', strokes: [], recognizedText: text, formatVersion: 2 });

describe('search', () => {
  it('tokenizes with accent folding', () => {
    expect(tokenize('Café-Résumé 2026!')).toEqual(['cafe', 'resume', '2026']);
    expect(matchScore('lau bet', 'Launch the beta')).toBe(1);
  });
  it('finds by prefix across title, tags and handwriting, ranking title hits higher', () => {
    const idx = new SearchIndex();
    idx.indexNote(note('a', 'Groceries'), [page('milk eggs launch')]);
    idx.indexNote(note('b', 'Launch plan', ['work']), [page('beta in March')]);
    idx.indexNote(note('c', 'Diary'), [page('nothing here')]);
    const hits = idx.search('laun');
    expect(hits.map((h) => h.noteId)).toEqual(['b', 'a']);
    expect(idx.search('work beta').map((h) => h.noteId)).toEqual(['b']);
    expect(idx.search('zebra')).toEqual([]);
  });
  it('excludes trashed notes and supports removal', () => {
    const idx = new SearchIndex();
    idx.indexNote(note('a', 'Alpha', [], { trashedAt: 1 }), [page()]);
    idx.indexNote(note('b', 'Alpha two'), [page()]);
    expect(idx.search('alpha').map((h) => h.noteId)).toEqual(['b']);
    idx.remove('b');
    expect(idx.search('alpha')).toEqual([]);
  });
  it('builds snippets around matches', () => {
    const s = snippet('The quick brown fox jumps over the lazy dog '.repeat(5), ['lazy'], 20);
    expect(s).toContain('«lazy»');
    expect(s.startsWith('…')).toBe(true);
  });
});

describe('paper templates', () => {
  const A4 = rect(0, 0, 793.7, 1122.5);
  it('ruled paper has rules below the header and a margin', () => {
    const els = paperElements({ style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: 0 }, A4, A4);
    const rules = els.filter((e) => e.kind === 'line' && e.role === 'rule');
    expect(rules.length).toBeGreaterThan(30);
    expect(Math.min(...rules.map((e: any) => e.y1))).toBeGreaterThanOrEqual(96);
    expect(els.some((e) => e.role === 'margin')).toBe(true);
  });
  it('every style renders something within the page, blank renders nothing', () => {
    for (const style of ['dot_grid', 'square_grid', 'graph_mm', 'isometric', 'cornell', 'music', 'planner_day', 'planner_week', 'todo'] as const) {
      const els = paperElements({ style, tint: 'white', texture: 'standard', spacing: 0 }, A4, A4);
      expect(els.length, style).toBeGreaterThan(5);
    }
    expect(paperElements({ style: 'blank', tint: 'white', texture: 'standard', spacing: 0 }, A4, A4)).toEqual([]);
  });
  it('boards repeat the pattern over any region', () => {
    const els = paperElements({ style: 'dot_grid', tint: 'white', texture: 'standard', spacing: 20 }, rect(-1000, -1000, -900, -900), null);
    expect(els.length).toBe(36);
  });
  it('caps element count for huge regions', () => {
    expect(paperElements({ style: 'dot_grid', tint: 'white', texture: 'standard', spacing: 4 }, rect(0, 0, 100000, 100000), null).length).toBeLessThanOrEqual(20001);
  });
});

describe('outline & geometry', () => {
  it('fountain pen outline is wider with pressure', () => {
    const light = stroke('a', polyline([[0, 0], [200, 0]]));
    light.points.forEach((p) => (p.p = 0.1));
    const heavy = stroke('b', polyline([[0, 0], [200, 0]]));
    heavy.points.forEach((p) => (p.p = 1));
    const h = (s: typeof light) => { const b = boundsOf(strokeOutline({ ...s, size: 6 }).map(([x, y]) => ({ x: x!, y: y! }))); return b.maxY - b.minY; };
    expect(h(heavy)).toBeGreaterThan(h(light));
  });
  it('produces a closed svg path', () => {
    const d = outlineToSvgPath(strokeOutline(stroke('a', word(0, 0))));
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });
  it('pen looks', () => {
    expect(penLook('highlighter').underlay).toBe(true);
    expect(penLook('dashed').dashed).toBe(true);
    expect(penLook('pencil').grain).toBe(true);
  });
  it('affine helpers invert correctly', () => {
    const m = multiply(translation(10, 20), scaling(2, 5, 5));
    const p = applyAffine(m, 3, 4);
    const back = applyAffine(invert(m), p.x, p.y);
    expect(back.x).toBeCloseTo(3);
    expect(back.y).toBeCloseTo(4);
  });
  it('counts reversals with hysteresis', () => {
    expect(countReversals([0, 10, 0, 10, 0], 5)).toBe(3);
    expect(countReversals([0, 1, 0, 1, 0], 5)).toBe(0);
  });
  it('hull, point-in-polygon, simplify', () => {
    const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    expect(hull).toHaveLength(4);
    expect(pointInPolygon(5, 5, hull)).toBe(true);
    expect(pointInPolygon(15, 5, hull)).toBe(false);
    const line = polyline([[0, 0], [100, 0]]).map(([x, y]) => ({ x, y }));
    expect(simplify(line, 0.5)).toHaveLength(2);
    expect(rectWidth(boundsOf(line))).toBe(100);
  });
});

import { nominalWidth as _nominalWidth } from '../src/index.ts';
describe('nominalWidth', () => {
  it('matches what the outline draws: fountain ≈1.41×, brush thin at mid pressure, marker even', () => {
    expect(_nominalWidth('fountain', 2, 0.5)).toBeCloseTo(2 * 2 * Math.sin(Math.PI / 4), 5);
    expect(_nominalWidth('brush', 4, 0.5)).toBeCloseTo(2 * 4 * 0.25, 5);
    expect(_nominalWidth('marker', 6, 0.9)).toBeCloseTo(6, 5);
    expect(_nominalWidth('fountain', 2, 1)).toBeGreaterThan(_nominalWidth('fountain', 2, 0.1));
    expect(_nominalWidth('fountain', 2, -1)).toBeCloseTo(_nominalWidth('fountain', 2, 0.5), 5);
  });
});
