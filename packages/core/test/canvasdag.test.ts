import { describe, expect, it } from 'vitest';
import { describeValue, extractGraph, findGraphCycles, findHook, parseOp, runDag, runLocalOp, topoOrder, valueFromText, type DagGraph, type DagValue, type InkStroke, type TextBox } from '../src/index.ts';
import { generateSketch, makeStroke } from './fixtures/sketches.ts';
import { scoreSketch } from './fixtures/score-sketch.ts';

type P = [number, number];
const line = (a: P, b: P, step = 2): P[] => { const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]); };
const path = (...c: P[]): P[] => c.slice(1).flatMap((p, i) => line(c[i]!, p).slice(i ? 1 : 0));
const box = (id: string, x: number, y: number, w = 140, h = 60): InkStroke => makeStroke(id, path([x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + 3]));
const label = (id: string, x: number, y: number, text: string): TextBox => ({ id, x, y, width: 110, text, fontSize: 14, color: '#FF000000', font: 'sans', createdAt: 0 });
const vhead = (id: string, tip: P, dir: P): InkStroke => {
  const [ux, uy] = dir;
  return makeStroke(id, path([tip[0] - ux * 10 - uy * 6, tip[1] - uy * 10 + ux * 6], tip, [tip[0] - ux * 10 + uy * 6, tip[1] - uy * 10 - ux * 6]));
};

describe('graph extraction', () => {
  it('reads boxes, typed labels and an arrow with a separate V head', () => {
    const g = extractGraph({
      strokes: [box('a', 0, 0), box('b', 300, 0), makeStroke('s', line([150, 30], [292, 32])), vhead('h', [294, 32], [1, 0])],
      texts: [label('ta', 15, 20, 'fetch example.com/x.csv'), label('tb', 315, 20, 'count')],
    });
    expect(g.nodes.map((n) => n.label)).toEqual(['fetch example.com/x.csv', 'count']);
    expect(g.edges).toEqual([{ id: 'e1', from: 'n1', to: 'n2', strokeIds: ['s', 'h'], by: 'arrowhead' }]);
    expect(g.order).toEqual(['n1', 'n2']);
    expect(g.cycles).toEqual([]);
  });

  it('trusts the head over drawing order: an arrow drawn backwards still points the right way', () => {
    const g = extractGraph({ strokes: [box('a', 0, 0), box('b', 300, 0), makeStroke('s', line([292, 32], [150, 30])), vhead('h', [294, 32], [1, 0])] });
    expect(g.edges.map((e) => [e.from, e.to, e.by])).toEqual([['n1', 'n2', 'arrowhead']]);
  });

  it('reads a hook (barb drawn in the same stroke) and falls back to drawing order without a head', () => {
    const hooked = makeStroke('s', [...line([150, 30], [295, 30]), ...line([295, 30], [284, 22]).slice(1)]);
    expect(findHook(hooked.points)).toMatchObject({ end: 'end' });
    const g = extractGraph({ strokes: [box('a', 0, 0), box('b', 300, 0), hooked] });
    expect(g.edges.map((e) => [e.from, e.to, e.by])).toEqual([['n1', 'n2', 'hook']]);
    const plain = extractGraph({ strokes: [box('a', 0, 0), box('b', 300, 0), makeStroke('s', line([295, 30], [150, 30]))] });
    expect(plain.edges.map((e) => [e.from, e.to, e.by])).toEqual([['n2', 'n1', 'order']]);
  });

  it('accepts snapped rectangles, ellipses and boxes drawn as four sides; a frame around boxes is not a step', () => {
    const snapped = { ...box('a', 0, 0), shape: 'rectangle' as const };
    const sides = [makeStroke('t', line([300, 0], [440, 2])), makeStroke('r', line([438, -3], [441, 62])), makeStroke('b', line([443, 60], [298, 61])), makeStroke('l', line([301, 64], [299, -2]))];
    const frame = makeStroke('f', path([-40, -40], [520, -40], [520, 140], [-40, 140], [-40, -37]));
    const g = extractGraph({ strokes: [frame, snapped, ...sides, makeStroke('s', line([145, 30], [295, 30])), vhead('h', [297, 30], [1, 0])] });
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes[1]!.boxStrokeIds.sort()).toEqual(['b', 'l', 'r', 't']);
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([['n1', 'n2']]);
  });

  it('keeps handwriting inside a box as its label, using recognized lines where they exist', () => {
    const ink = makeStroke('w', line([20, 30], [80, 34]));
    const ink2 = makeStroke('w2', line([20, 44], [60, 44]));
    const g = extractGraph({ strokes: [box('a', 0, 0), ink, ink2], lines: [{ text: 'sum price', strokeIds: ['w'], bounds: { minX: 20, minY: 25, maxX: 80, maxY: 38 } }] });
    expect(g.nodes[0]).toMatchObject({ label: 'sum price', labelFrom: 'recognized', labelStrokeIds: ['w', 'w2'], unreadStrokeIds: ['w2'] });
  });

  it('finds cycles and refuses an order for them; reports lines that connect nothing', () => {
    const g = extractGraph({ strokes: [
      box('a', 0, 0), box('b', 300, 0),
      makeStroke('s1', line([145, 20], [295, 20])), vhead('h1', [297, 20], [1, 0]),
      makeStroke('s2', line([295, 45], [145, 45])), vhead('h2', [143, 45], [-1, 0]),
      makeStroke('x', line([100, 300], [260, 330])),
    ] });
    expect(g.cycles).toEqual([['n1', 'n2']]);
    expect(g.order).toBeNull();
    expect(g.loose).toEqual(['x']);
    expect(findGraphCycles(['a'], [{ from: 'a', to: 'a' }])).toEqual([['a']]);
    expect(topoOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ from: 'c', to: 'a' }])).toEqual(['b', 'c', 'a']);
  });

  it('extracts messy synthetic sketches exactly (see the eval for the full measurement)', () => {
    let exact = 0;
    for (let seed = 200; seed < 220; seed++) if (scoreSketch(generateSketch(seed)).exact) exact++;
    expect(exact).toBeGreaterThanOrEqual(18);
  });
});

describe('ops', () => {
  const t: DagValue = { kind: 'table', columns: ['item', 'Price', 'date'], rows: [['tea', 4, '2024-01-02'], ['cake', 12.5, '2024-01-01'], ['jam', 30, '2024-01-03'], ['bread', null, '2024-01-04']] };
  it('parses verbs from handwriting-ish labels', () => {
    expect(parseOp('Fetch example.com/data.csv')).toEqual({ op: 'fetch', url: 'https://example.com/data.csv' });
    expect(parseOp('filter price > 10')).toEqual({ op: 'filter', column: 'price', cmp: '>', value: '10' });
    expect(parseOp('filter item is "jam"')).toEqual({ op: 'filter', column: 'item', cmp: '=', value: 'jam' });
    expect(parseOp('filter jam')).toEqual({ op: 'filter', value: 'jam' });
    expect(parseOp('sort by date desc')).toEqual({ op: 'sort', column: 'date', desc: true });
    expect(parseOp('top 2')).toEqual({ op: 'limit', n: 2 });
    expect(parseOp('Sum of price.')).toEqual({ op: 'agg', fn: 'sum', column: 'price' });
    expect(parseOp('average')).toEqual({ op: 'agg', fn: 'avg' });
    expect(parseOp('count')).toEqual({ op: 'count' });
    expect(parseOp('chart line')).toEqual({ op: 'chart', kind: 'line' });
    expect(parseOp('42')).toEqual({ op: 'const', value: { kind: 'number', value: 42 } });
    expect(parseOp('summarize the findings')).toEqual({ op: 'agent', prompt: 'summarize the findings' });
  });
  it('runs filter, sort, limit, aggregates, count and chart deterministically', async () => {
    const f = await runLocalOp(parseOp('filter price > 10'), [t]);
    expect(f.kind === 'table' && f.rows.map((r) => r[0])).toEqual(['cake', 'jam']);
    const s = await runLocalOp(parseOp('sort by date'), [t]);
    expect(s.kind === 'table' && s.rows.map((r) => r[0])).toEqual(['cake', 'tea', 'jam', 'bread']);
    expect(await runLocalOp(parseOp('sum price'), [t])).toEqual({ kind: 'number', value: 46.5 });
    expect(await runLocalOp(parseOp('max'), [t])).toEqual({ kind: 'number', value: 30 });
    expect(await runLocalOp(parseOp('sum'), [{ kind: 'number', value: 2 }, { kind: 'number', value: 3 }])).toEqual({ kind: 'number', value: 5 });
    expect(await runLocalOp(parseOp('count'), [t])).toEqual({ kind: 'number', value: 4 });
    expect(await runLocalOp(parseOp('filter tea'), [t])).toMatchObject({ rows: [['tea', 4, '2024-01-02']] });
    const c = await runLocalOp(parseOp('chart'), [t]);
    expect(c.kind).toBe('chart');
    await expect(runLocalOp(parseOp('filter colour = red'), [t])).rejects.toThrow(/No column “colour”/);
    await expect(runLocalOp(parseOp('sum'), [])).rejects.toThrow(/needs a table/);
  });
  it('fetches through the supplied fetcher and reads CSV or JSON', async () => {
    const fetchText = async (url: string) => (url.endsWith('.csv') ? { text: 'a,b\n1,2\n', contentType: 'text/csv' } : { text: '[{"x":1}]', contentType: 'application/json' });
    expect(await runLocalOp(parseOp('fetch example.com/t.csv'), [], { fetchText })).toEqual({ kind: 'table', columns: ['a', 'b'], rows: [[1, 2]] });
    expect(await runLocalOp(parseOp('fetch https://api.example.com/x'), [], { fetchText })).toEqual({ kind: 'table', columns: ['x'], rows: [[1]] });
    await expect(runLocalOp({ op: 'fetch', url: 'file:///etc/passwd' }, [], { fetchText })).rejects.toThrow(/http/);
  });
  it('turns values into text and agent replies back into values', () => {
    expect(describeValue({ kind: 'table', columns: ['a'], rows: [[1], [2]] }, 1)).toBe('| a |\n| --- |\n| 1 |\n… 1 more rows');
    expect(valueFromText(' 1,234 ')).toEqual({ kind: 'number', value: 1234 });
    expect(valueFromText('| a | b |\n|---|---|\n| x | 2 |')).toEqual({ kind: 'table', columns: ['a', 'b'], rows: [['x', 2]] });
    expect(valueFromText('Hello')).toEqual({ kind: 'text', value: 'Hello' });
  });
});

describe('running a graph', () => {
  const g = (edges: [string, string][], ids = ['a', 'b', 'c', 'd']): DagGraph => ({
    nodes: ids.map((id) => ({ id, rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, label: id, labelFrom: 'typed', boxStrokeIds: [], labelStrokeIds: [], unreadStrokeIds: [] })),
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to, strokeIds: [], by: 'arrowhead' })),
    cycles: [], order: null, loose: [],
  });
  it('runs in dependency order with inputs from upstream, and skips what follows a failure', async () => {
    const seen: string[] = [];
    const res = await runDag(g([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]), {
      exec: async (n, inputs) => {
        seen.push(`${n.id}<${inputs.map((i) => i.from).join(',')}`);
        if (n.id === 'c') throw new Error('nope');
        return { kind: 'number', value: inputs.reduce((s, i) => s + (i.value.kind === 'number' ? i.value.value : 0), 1) };
      },
    });
    expect(seen.slice(0, 1)).toEqual(['a<']);
    expect(seen).toContain('b<a');
    expect(res.a).toMatchObject({ status: 'done', output: { value: 1 } });
    expect(res.b).toMatchObject({ status: 'done', output: { value: 2 } });
    expect(res.c).toMatchObject({ status: 'error', error: 'nope' });
    expect(res.d!.status).toBe('skipped');
  });
  it('re-runs one step from cached inputs, and asks for its inputs when they are missing', async () => {
    const graph = g([['a', 'b']], ['a', 'b']);
    let calls = 0;
    const exec = async () => { calls++; return { kind: 'text', value: 'x' } as DagValue; };
    const one = await runDag(graph, { only: 'b', cached: { a: { kind: 'number', value: 3 } }, exec });
    expect(Object.keys(one)).toEqual(['b']);
    expect(calls).toBe(1);
    const none = await runDag(graph, { only: 'b', exec });
    expect(none.b).toMatchObject({ status: 'error', error: 'Run the steps before it first (a)' });
  });
  it('cancels: running steps abort and queued ones never start', async () => {
    const ac = new AbortController();
    const started: string[] = [];
    const p = runDag(g([['a', 'b']], ['a', 'b']), {
      signal: ac.signal,
      exec: (n, _i, signal) => { started.push(n.id); return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); },
    });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const res = await p;
    expect(started).toEqual(['a']);
    expect(res.a!.status).toBe('cancelled');
    expect(res.b!.status).toBe('cancelled');
  });
  it('refuses cyclic graphs', async () => {
    await expect(runDag({ ...g([['a', 'b'], ['b', 'a']], ['a', 'b']), cycles: [['a', 'b']] }, { exec: async () => ({ kind: 'text', value: '' }) })).rejects.toThrow(/cycle/);
  });
});
