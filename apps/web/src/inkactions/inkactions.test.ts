import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { NoteDocument, classifyPage, datasetFromCsv, newNote, newPage, runSqlWithRepair, sqlIdent, type Reference } from '@inkwright/core';
import { sqlJsEngine, normalizeCell, type SqlJsStatic } from '../datasandbox/engine.ts';
import { dataTableObject, parseDataText } from '../datasandbox/data.ts';
import { placeTypedAnswer, writeInInk } from '../inkanswer/write.ts';
import { noteBibliography } from '../papers/Bibliography.tsx';
import { INK_ACTION_MODULES } from './modules.ts';
import { BUILTIN_MODULES, BUILTIN_PRESETS } from '../modules/builtin.ts';

const doc = () => new NoteDocument(newNote({ id: 'n', title: 'T', pageId: 'p', now: 0 }), [newPage('p')]);

describe('AI answers in ink (app side)', () => {
  it('writes AI ink near the selection as one undo step, never as handwriting', async () => {
    const d = doc();
    const near = { minX: 60, minY: 80, maxX: 300, maxY: 120 };
    const placed = await writeInInk(d, 0, 'Paris is the capital of France.', { near, animate: false });
    const strokes = d.page(0).strokes;
    expect(strokes.length).toBe(placed.strokeIds.length);
    expect(strokes.every((s) => s.origin === 'ai' && s.pen === 'ballpoint')).toBe(true);
    expect(Math.min(...strokes.flatMap((s) => s.points.map((p) => p.y)))).toBeGreaterThan(120);
    expect(classifyPage(d.page(0)).counts.aiInk).toBe(strokes.length);
    expect(d.history.undoLabel).toBe('AI answer in ink');
    d.undo();
    expect(d.page(0).strokes).toHaveLength(0);
  });
  it('can answer in typed text instead, also marked AI', () => {
    const d = doc();
    const placed = placeTypedAnswer(d, 0, 'Forty-two.', null);
    expect(d.page(0).texts).toEqual([expect.objectContaining({ id: placed.textId, origin: 'ai', text: 'Forty-two.' })]);
  });
});

describe('data sandbox engines', () => {
  it('loads typed datasets into SQLite (the fallback) and answers SQL like DuckDB would', async () => {
    const SQL = (await initSqlJs()) as unknown as SqlJsStatic;
    const engine = sqlJsEngine(SQL);
    const d = datasetFromCsv('Sales 2024.csv', 'Region,Amount,Paid,Day\nNorth,10.5,yes,2024-01-02\nSouth,5,no,2024-01-03\nNorth,7,yes,2024-01-04\n');
    expect(d.name).toBe(sqlIdent('Sales 2024.csv'));
    await engine.load(d);
    const r = await engine.query(`SELECT region, sum(amount) AS total, sum(paid) AS paid FROM ${d.name} GROUP BY region ORDER BY total DESC`);
    expect(r).toEqual({ columns: ['region', 'total', 'paid'], rows: [['North', 17.5, 2], ['South', 5, 0]] });
    await expect(engine.query('SELECT nope FROM sales_2024')).rejects.toThrow(/no such column/);
    // Switching notes drops the previous note's tables: they can't be queried from another note.
    await engine.drop(d.name);
    await expect(engine.query(`SELECT * FROM ${d.name}`)).rejects.toThrow(/no such table/);
    await engine.close();
  });
  it('feeds real engine errors back through the repair loop', async () => {
    const SQL = (await initSqlJs()) as unknown as SqlJsStatic;
    const engine = sqlJsEngine(SQL);
    const d = datasetFromCsv('t.csv', 'a,b\n1,2\n3,4\n');
    await engine.load(d);
    const seen: string[] = [];
    const out = await runSqlWithRepair({
      sql: 'SELECT sum(c) FROM t', question: 'total of b', datasets: [d], dialect: 'SQLite', engine: 'SQLite (sql.js)',
      run: (q) => engine.query(q),
      ask: async (m) => { seen.push(m[m.length - 1]!.content); return '```sql\nSELECT sum(b) AS total FROM t\n```'; },
    });
    expect(out.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(seen[0]).toMatch(/no such column: c/);
    expect(out.result!.rows).toEqual([[6]]);
  });
  it('normalizes engine values and previews data as a smart-ink table', () => {
    expect(normalizeCell(10n)).toBe(10);
    expect(normalizeCell(new Date('2024-01-02T00:00:00Z'))).toBe('2024-01-02');
    const d = parseDataText('x.json', '[{"name":"a","n":1},{"name":"b","n":2}]');
    const t = dataTableObject({ columns: d.columns.map((c) => c.name), rows: d.rows, x: 10, y: 20, origin: 'import', data: { asset: 'x.json', table: d.name, rowCount: 2, columns: [] } });
    expect(t.cells.map((r) => r.map((c) => c.text))).toEqual([['name', 'n'], ['a', '1'], ['b', '2']]);
    expect(t.header).toBe(true);
    expect(t.rows).toHaveLength(3);
  });
});

describe('bibliography of a note', () => {
  it('lists cited papers in order and reports keys missing from the library', () => {
    const d = doc();
    d.upsertText(0, { id: 't', x: 0, y: 0, width: 300, text: 'See [@b2020] and [@a2019; @zz]. Again [@b2020].', fontSize: 14, color: '#FF000000', font: 'sans', createdAt: 0 });
    const lib: { ref: Reference }[] = [{ ref: { id: 'a2019', type: 'book', title: 'A' } }, { ref: { id: 'b2020', type: 'book', title: 'B' } }];
    expect(noteBibliography(d, lib)).toEqual({ refs: [lib[1]!.ref, lib[0]!.ref], missing: ['zz'] });
  });
});

describe('modules', () => {
  it('registers every ink action as a module, in the presets that suit it', () => {
    const ids = BUILTIN_MODULES.map((m) => m.id);
    for (const m of INK_ACTION_MODULES) expect(ids).toContain(m.id);
    const student = BUILTIN_PRESETS.find((p) => p.id === 'student')!.modules;
    expect(INK_ACTION_MODULES.every((m) => student.includes(m.id))).toBe(true);
    expect(BUILTIN_PRESETS.find((p) => p.id === 'writer')!.modules).toEqual(expect.arrayContaining(['ink-answers', 'accessibility', 'papers']));
  });
  it('gives the assistant its tools only through the modules', async () => {
    const tools = (await Promise.all(INK_ACTION_MODULES.filter((m) => m.aiTools).map((m) => m.aiTools!()))).flat().map((t) => t.name);
    expect(tools.sort()).toEqual(['list_datasets', 'query_data', 'write_in_ink']);
  });
});
