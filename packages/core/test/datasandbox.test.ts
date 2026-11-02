import { describe, expect, it } from 'vitest';
import {
  chartSvg,
  datasetFromCsv,
  datasetFromJson,
  datasetToCsv,
  describeDataset,
  extractSql,
  inferChart,
  inferType,
  chartTicks,
  parseDelimited,
  readOnlySql,
  runSqlWithRepair,
  sniffDelimiter,
  tableName,
  uniqueColumns,
} from '../src/index.ts';

describe('CSV', () => {
  it('parses quotes, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const text = '﻿name,note\r\n"Smith, J.","said ""hi""\nthen left"\r\nLee,\r\n';
    expect(parseDelimited(text)).toEqual([['name', 'note'], ['Smith, J.', 'said "hi"\nthen left'], ['Lee', '']]);
  });
  it('sniffs semicolons and tabs', () => {
    expect(sniffDelimiter('a;b;c\n1;2,5;3\n')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(sniffDelimiter('a,b\n1,2\n')).toBe(',');
  });
  it('types columns and converts values', () => {
    const d = datasetFromCsv('Sales 2024 (Q1).csv', 'region,amount,units,paid,day,code\nNorth,"1,200.50",3,yes,2024-01-02,007\nSouth,99,,no,2024-01-03,A1\n,NA,4,true,2024-02-01,12\n');
    expect(d.name).toBe('sales_2024_q1');
    expect(d.columns.map((c) => c.type)).toEqual(['text', 'number', 'integer', 'boolean', 'date', 'text']);
    expect(d.rows[0]).toEqual(['North', 1200.5, 3, true, '2024-01-02', '007']);
    expect(d.rows[1]).toEqual(['South', 99, null, false, '2024-01-03', 'A1']);
    expect(d.rows[2]![0]).toBeNull();
    expect(d.rows[2]![1]).toBeNull();
  });
  it('round-trips through CSV and makes names safe', () => {
    const d = datasetFromCsv('x.csv', 'a,b\n"q,1",2\n');
    expect(datasetToCsv(d)).toBe('a,b\n"q,1",2\n');
    expect(tableName('2024.csv')).toBe('t_2024');
    expect(tableName('select.csv')).toBe('select');
    expect(tableName('a.csv', new Set(['a']))).toBe('a_2');
    expect(uniqueColumns(['', 'a', 'A', 'Region Name'])).toEqual(['column_1', 'a', 'a_2', 'region_name']);
    expect(inferType(['1', '2.5'])).toBe('number');
    expect(inferType(['2024-13-40'])).toBe('text');
  });
});

describe('JSON', () => {
  it('reads arrays of objects with nesting, wrapped arrays, arrays of arrays and NDJSON', () => {
    const a = datasetFromJson('people.json', JSON.stringify([{ name: 'Ann', age: 31, address: { city: 'Oslo' }, tags: ['a'] }, { name: 'Bo', age: 25.5, extra: true }]));
    expect(a.columns).toEqual([{ name: 'name', type: 'text' }, { name: 'age', type: 'number' }, { name: 'address_city', type: 'text' }, { name: 'tags', type: 'text' }, { name: 'extra', type: 'boolean' }]);
    expect(a.rows[0]).toEqual(['Ann', 31, 'Oslo', '["a"]', null]);
    expect(datasetFromJson('w.json', '{"meta":1,"data":[{"x":1},{"x":2}]}').rows).toEqual([[1], [2]]);
    expect(datasetFromJson('m.json', '[["x","y"],[1,2]]').columns.map((c) => c.name)).toEqual(['x', 'y']);
    expect(datasetFromJson('n.ndjson', '{"x":1}\n{"x":2}\n').rows).toHaveLength(2);
    expect(() => datasetFromJson('bad.json', '{oops')).toThrow(/not valid JSON/);
  });
  it('describes a dataset for a prompt', () => {
    const d = datasetFromCsv('s.csv', 'Region Name,amount\nN,1\n');
    expect(describeDataset(d)).toContain('s(region_name TEXT, amount INTEGER) — 1 rows');
  });
});

describe('read-only SQL', () => {
  it('allows one SELECT/WITH and refuses writes, multiple statements and file access', () => {
    expect(readOnlySql('select 1;')).toBe('select 1');
    expect(readOnlySql("WITH x AS (SELECT 'drop table' AS s) SELECT * FROM x -- delete")).toContain('WITH');
    expect(() => readOnlySql('DROP TABLE x')).toThrow(/Only SELECT/);
    expect(() => readOnlySql('select 1; drop table x')).toThrow(/one statement/);
    expect(() => readOnlySql("select * from read_csv('/etc/passwd')")).toThrow(/files/);
    expect(() => readOnlySql('select * from x where 1=1 and exists (select 1) union select * from y; ')).not.toThrow();
    expect(() => readOnlySql('select "update" from x')).not.toThrow();
  });
  it('extracts SQL from fenced or chatty replies', () => {
    expect(extractSql('Here:\n```sql\nSELECT 1\n```\nDone')).toBe('SELECT 1');
    expect(extractSql('Sure! SELECT a FROM t; -- that is it')).toBe('SELECT a FROM t');
  });
});

describe('repair loop', () => {
  const d = datasetFromCsv('sales.csv', 'region,amount\nN,10\nS,5\nN,7\n');
  const run = async (sql: string) => {
    if (/amout/.test(sql)) throw new Error('Binder Error: Referenced column "amout" not found');
    if (/sum\(amount\)/i.test(sql)) return { columns: ['region', 'total'], rows: [['N', 17], ['S', 5]] as (string | number)[][] };
    throw new Error('Parser Error: syntax error');
  };
  it('feeds the engine error back verbatim and succeeds on the second try', async () => {
    const seen: string[] = [];
    let t = 0;
    const out = await runSqlWithRepair({
      question: 'total by region', datasets: [d], dialect: 'DuckDB', run, engine: 'Fake', clock: () => (t += 5),
      ask: async (msgs) => {
        seen.push(msgs[msgs.length - 1]!.content);
        return msgs.length === 1 ? '```sql\nSELECT region, sum(amout) FROM sales GROUP BY 1\n```' : '```sql\nSELECT region, sum(amount) AS total FROM sales GROUP BY 1\n```';
      },
    });
    expect(out.ok).toBe(true);
    expect(out.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(out.attempts[0]!.error).toMatch(/amout/);
    expect(seen[1]).toContain('Referenced column "amout" not found');
    expect(seen[1]).toContain('sum(amout)');
    expect(out.result!.rows).toEqual([['N', 17], ['S', 5]]);
    expect(out.attempts.every((a) => a.engine === 'Fake' && a.ms === 5)).toBe(true);
  });
  it('stops after three attempts and reports every one', async () => {
    let asks = 0;
    const out = await runSqlWithRepair({ sql: 'SELECT nonsense(', question: 'q', datasets: [d], dialect: 'DuckDB', run, ask: async () => { asks++; return 'SELECT bad syntax here'; } });
    expect(out.ok).toBe(false);
    expect(out.attempts).toHaveLength(3);
    expect(asks).toBe(2); // the agent's own SQL was the first attempt
    expect(out.error).toMatch(/syntax/);
  });
  it('counts a refused statement as a failed attempt', async () => {
    const out = await runSqlWithRepair({ sql: 'DELETE FROM sales', question: 'q', datasets: [d], dialect: 'DuckDB', run, ask: async () => 'SELECT region, sum(amount) FROM sales GROUP BY 1', maxTries: 2 });
    expect(out.attempts[0]).toMatchObject({ ok: false, error: 'Only SELECT queries can run here' });
    expect(out.ok).toBe(true);
  });
});

describe('charts', () => {
  it('infers bars for categories and lines for dates', () => {
    expect(inferChart({ columns: ['region', 'total'], rows: [['N', 17], ['S', 5]] })).toEqual({ kind: 'bar', x: 'region', y: ['total'] });
    expect(inferChart({ columns: ['day', 'a', 'b'], rows: [['2024-01-01', 1, 2], ['2024-01-02', 2, 3], ['2024-01-03', 4, 1]] })).toEqual({ kind: 'line', x: 'day', y: ['a', 'b'] });
    expect(inferChart({ columns: ['name'], rows: [['x']] })).toBeNull();
  });
  it('draws an SVG with one bar per row, readable ticks and a legend only for several series', () => {
    const one = chartSvg({ kind: 'bar', x: 'region', y: ['total'], title: 'Totals' }, { columns: ['region', 'total'], rows: [['N', 17], ['S', 5], ['E', -3]] });
    expect(one.match(/<path /g)).toHaveLength(3);
    expect(one).toContain('Totals');
    expect(one).not.toContain('<rect x=');
    const two = chartSvg({ kind: 'line', x: 'd', y: ['a', 'b'] }, { columns: ['d', 'a', 'b'], rows: [[1, 1, 2], [2, 2, null], [3, 3, 1]] });
    expect(two.match(/<polyline /g)!.length).toBe(3); // b has a gap, so two runs
    expect(two).toContain('>b</text>');
    expect(chartTicks(0, 17)).toEqual([0, 5, 10, 15, 20]);
    expect(chartTicks(-3, 17)[0]).toBeLessThanOrEqual(-3);
  });
});
