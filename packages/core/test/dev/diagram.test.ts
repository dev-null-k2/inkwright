import { describe, expect, it } from 'vitest';
import {
  diagramSvg, findCycles, formatReceipt, layoutDiagram, makeDiagramObject, objectRect, objectsSvg, objectsText, parseDiagramInput,
  sceneOverlaps, validateDiagram, type DiagramIR,
} from '../../src/index.ts';

const GOOD: DiagramIR = {
  title: 'Checkout',
  nodes: [
    { id: 'web', label: 'Web app', kind: 'client' },
    { id: 'api', label: 'Checkout API', kind: 'service', group: 'backend', code: 'src/server.ts#POST /checkout' },
    { id: 'db', label: 'Orders DB', kind: 'database', group: 'backend' },
    { id: 'q', label: 'Events', kind: 'queue' },
    { id: 'mail', label: 'Mailer', kind: 'job' },
    { id: 'psp', label: 'Payments', kind: 'external' },
  ],
  edges: [
    { from: 'web', to: 'api', label: 'POST /checkout' },
    { from: 'api', to: 'db', kind: 'data' },
    { from: 'api', to: 'psp' },
    { from: 'api', to: 'q', kind: 'async' },
    { from: 'q', to: 'mail', kind: 'async' },
    { from: 'web', to: 'mail', kind: 'depends' },
  ],
  groups: [{ id: 'backend', label: 'Backend' }],
};

const codes = (ir: unknown, opts = {}) => validateDiagram(ir, opts).errors.map((e) => e.code);

describe('validateDiagram', () => {
  it('accepts a good diagram and checks code refs against the graph', () => {
    const r = validateDiagram(GOOD, { resolveCode: (ref) => ref === 'src/server.ts#POST /checkout' });
    expect(r.ok).toBe(true);
    expect(r.stats).toEqual({ nodes: 6, edges: 6, groups: 1 });
    expect(formatReceipt(r)).toMatch(/^Valid diagram/);
    // Without a code graph the reference can't be checked: a warning, not an error.
    expect(validateDiagram(GOOD).warnings.map((w) => w.code)).toEqual(['unchecked_code_ref']);
  });

  it('reports unknown refs with JSON pointers and did-you-mean hints', () => {
    const r = validateDiagram({ ...GOOD, edges: [...GOOD.edges, { from: 'api', to: 'dbb' }] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'unknown_node_ref', path: '/edges/6/to', hint: 'Did you mean "db"?' });
    expect(formatReceipt(r)).toContain('1. [unknown_node_ref] /edges/6/to');
  });

  it('finds schema problems, duplicates, unknown kinds and groups, self loops', () => {
    expect(codes(null)).toEqual(['schema']);
    expect(codes({ nodes: [] })).toEqual(['empty']);
    expect(codes({ nodes: [{ id: '1x' }], edges: [] })).toEqual(['schema']);
    expect(codes({ nodes: [{ id: 'a' }, { id: 'a' }], edges: [] })).toEqual(['duplicate_id']);
    const k = validateDiagram({ nodes: [{ id: 'a', kind: 'databse' }], edges: [] });
    expect(k.errors[0]).toMatchObject({ code: 'unknown_kind', hint: expect.stringContaining('Did you mean "database"?') });
    expect(codes({ nodes: [{ id: 'a', group: 'g' }], edges: [], groups: [{ id: 'h' }] })).toEqual(['unknown_group']);
    expect(codes({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'a' }] })).toEqual(['self_loop']);
    expect(codes({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', kind: 'rpc' }] })).toEqual(['unknown_kind']);
    expect(codes({ nodes: Array.from({ length: 61 }, (_, i) => ({ id: `n${i}` })), edges: [] })).toEqual(['too_large']);
  });

  it('rejects cycles where they are not allowed', () => {
    const cyc = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] };
    expect(validateDiagram(cyc).ok).toBe(true); // calls may go round
    const r = validateDiagram({ ...cyc, acyclic: true });
    expect(r.errors.map((e) => e.code)).toEqual(['cycle']);
    expect(r.errors[0]!.message).toBe('Cycle: a → b → c → a.');
    expect(codes({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', kind: 'depends' }, { from: 'b', to: 'a', kind: 'depends' }] })).toEqual(['cycle']);
    expect(findCycles(['a', 'b'], [{ from: 'a', to: 'b' }])).toEqual([]);
  });

  it('rejects unbound code refs and overlapping fixed layouts', () => {
    expect(codes(GOOD, { resolveCode: () => false })).toEqual(['unbound_code_ref']);
    const fixed = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }], layout: { a: { x: 0, y: 0 }, b: { x: 40, y: 10 } } };
    const r = validateDiagram(fixed);
    expect(r.errors[0]).toMatchObject({ code: 'overlap', path: '/layout/b' });
    expect(validateDiagram({ ...fixed, layout: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } } }).ok).toBe(true);
  });

  it('turns JSON syntax errors into a receipt-friendly issue', () => {
    expect(parseDiagramInput('{"nodes": [').error?.code).toBe('schema');
    expect(parseDiagramInput({ nodes: [] }).ir).toEqual({ nodes: [] });
  });

  it('is deterministic', () => {
    const bad = { nodes: [{ id: 'a', kind: 'x' }, { id: 'a' }], edges: [{ from: 'q', to: 'a' }] };
    expect(JSON.stringify(validateDiagram(bad))).toBe(JSON.stringify(validateDiagram(JSON.parse(JSON.stringify(bad)))));
  });
});

describe('layoutDiagram', () => {
  it('lays out without overlaps, flows downstream, and keeps groups together', () => {
    const scene = layoutDiagram(GOOD);
    expect(sceneOverlaps(scene)).toEqual([]);
    const box = (id: string) => scene.boxes.find((b) => b.id === id)!;
    expect(box('web').y).toBeLessThan(box('api').y);
    expect(box('api').y).toBeLessThan(box('db').y);
    expect(box('q').y).toBeLessThan(box('mail').y);
    expect(scene.width).toBeGreaterThan(200);
    expect(JSON.stringify(layoutDiagram(GOOD))).toBe(JSON.stringify(scene));
  });

  it('lays out left to right, cycles included, and honours fixed positions', () => {
    const lr = layoutDiagram({ direction: 'LR', nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] });
    expect(sceneOverlaps(lr)).toEqual([]);
    const box = (id: string) => lr.boxes.find((b) => b.id === id)!;
    expect(box('a').x).toBeLessThan(box('b').x);
    const fixed = layoutDiagram({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [], layout: { a: { x: 10, y: 10 }, b: { x: 300, y: 10 } } });
    expect(fixed.boxes.map((b) => [b.x, b.y])).toEqual([[10, 10], [300, 10]]);
  });

  it('draws shapes by kind, dashed async edges and labels as SVG', () => {
    const svg = diagramSvg(GOOD);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('>Checkout API</text>');
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).toContain('>POST /checkout</text>');
    expect(svg).toContain('>service · code</text>');
    expect(svg).not.toContain('NaN');
  });

  it('becomes a page object that every exporter knows', () => {
    const o = makeDiagramObject(GOOD, { id: 'd1', x: 40, y: 60, width: 500, now: 1, origin: 'ai' });
    expect(o).toMatchObject({ type: 'diagram', x: 40, y: 60, width: 500, origin: 'ai' });
    expect(objectRect(o)).toEqual({ minX: 40, minY: 60, maxX: 540, maxY: 60 + o.height });
    expect(objectsSvg([o])).toContain('class="diagram" transform="translate(40 60) scale(');
    expect(objectsText([o])).toContain('Web app → Checkout API (POST /checkout)');
  });
});
