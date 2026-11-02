import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  dataTableFrom, detectGraphFormat, importCodeGraph, maskHeader, newPage, noteRunbookBlocks, parseCsv, parseHttpBlock, parseRunbookBlocks,
  readTarball, resultToMarkdown, shapeBody, sqlIdent, stripCommonRoot,
} from '../../src/index.ts';

describe('runbook blocks', () => {
  it('finds runnable fences with their position, language aliases and names', () => {
    const text = 'Check health:\n```http health\nGET https://api.test/health\n```\nthen\n~~~sql\nselect 1\n~~~\n```python\nprint(1)\n```\n```js\n1+1';
    const b = parseRunbookBlocks(text);
    expect(b.map((x) => [x.lang, x.line, x.name ?? null])).toEqual([['http', 1, 'health'], ['sql', 5, null], ['js', 11, null]]);
    expect(b[0]!.code).toBe('GET https://api.test/health');
    expect(text.slice(b[0]!.start, b[0]!.end)).toBe('```http health\nGET https://api.test/health\n```');
    expect(b[2]!.code).toBe('1+1'); // unclosed: runs to the end
    expect(parseRunbookBlocks('```constructor\nx\n```')).toEqual([]);
    const page = { ...newPage('p'), texts: [{ id: 't', x: 0, y: 0, width: 1, text, fontSize: 1, color: '', font: 'sans' as const, createdAt: 0 }] };
    expect(noteRunbookBlocks([page]).map((x) => [x.pageIndex, x.textId, x.lang])).toEqual([[0, 't', 'http'], [0, 't', 'sql'], [0, 't', 'js']]);
  });

  it('parses .http requests: method, headers, body and variables', () => {
    expect(parseHttpBlock('# probe\nhttps://api.test/health')).toEqual({ method: 'GET', url: 'https://api.test/health', headers: [] });
    const r = parseHttpBlock('POST https://api.test/items HTTP/1.1\nContent-Type: application/json\nAuthorization: Bearer {{token}}\n\n{"name": "{{name}}"}', { token: 't0k', name: 'pen' });
    expect(r).toEqual({ method: 'POST', url: 'https://api.test/items', headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer t0k']], body: '{"name": "pen"}' });
    expect(() => parseHttpBlock('')).toThrow(/no request line/);
    expect(() => parseHttpBlock('GET /relative')).toThrow(/not a full URL/);
    expect(() => parseHttpBlock('GET file:///etc/passwd')).toThrow(/Only http and https/);
    expect(() => parseHttpBlock('GET https://a.test\nnot a header')).toThrow(/Line 2 is not a header/);
  });

  it('masks secrets and shapes bodies', () => {
    expect(maskHeader('Authorization', 'Bearer abc')).toBe('Bearer ••••');
    expect(maskHeader('X-Api-Key', 'abc')).toBe('••••');
    expect(maskHeader('Accept', 'text/plain')).toBe('text/plain');
    expect(shapeBody('{"a":1}', 'application/json').body).toBe('{\n  "a": 1\n}');
    expect(shapeBody('x'.repeat(10), 'text/plain', 4)).toEqual({ body: 'xxxx', truncated: 6 });
  });
});

describe('data for SQL', () => {
  it('reads CSV: quotes, doubled quotes, CRLF, semicolons', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n1,2\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('turns CSV and JSON into typed tables with safe names', () => {
    const t = dataTableFrom('Incidents 2026.csv', 'Sev,Service,Started at\n1,api,2026-11-01\n2,db,\n');
    expect(t).toEqual({ name: 'incidents_2026', columns: ['sev', 'service', 'started_at'], rows: [[1, 'api', '2026-11-01'], [2, 'db', null]] });
    const j = dataTableFrom('deploys.json', JSON.stringify({ items: [{ id: 1, tags: ['a'] }, { id: 2, ok: true }] }));
    expect(j).toEqual({ name: 'deploys', columns: ['id', 'tags', 'ok'], rows: [[1, '["a"]', null], [2, null, 'true']] });
    expect(sqlIdent('9lives.csv')).toBe('t_9lives');
    expect(resultToMarkdown({ columns: ['a'], rows: [[1], ['x|y']], more: 3 })).toBe('| a |\n| --- |\n| 1 |\n| x\\|y |\n\n…and 3 more rows');
  });
});

describe('repository archives', () => {
  function tar(files: Record<string, string>): Uint8Array {
    const blocks: Uint8Array[] = [];
    const header = (name: string, size: number, type = '0') => {
      const h = new Uint8Array(512);
      const put = (s: string, at: number) => h.set(new TextEncoder().encode(s), at);
      put(name.slice(0, 100), 0);
      put('0000644\0', 100);
      put(size.toString(8).padStart(11, '0') + '\0', 124);
      put(type, 156);
      put('ustar\0', 257);
      return h;
    };
    // GitHub style: a pax global header, then everything under one folder.
    const pax = '52 comment=0123456789abcdef0123456789abcdef01234567\n';
    blocks.push(header('pax_global_header', pax.length, 'g'));
    const pb = new Uint8Array(512); pb.set(new TextEncoder().encode(pax)); blocks.push(pb);
    for (const [name, text] of Object.entries(files)) {
      const body = new TextEncoder().encode(text);
      if (name.length > 100) {
        const ln = new TextEncoder().encode(name);
        blocks.push(header('././@LongLink', ln.length, 'L'));
        const lb = new Uint8Array(Math.ceil(ln.length / 512) * 512); lb.set(ln); blocks.push(lb);
      }
      blocks.push(header(name, body.length));
      const b = new Uint8Array(Math.ceil(body.length / 512) * 512); b.set(body); blocks.push(b);
    }
    blocks.push(new Uint8Array(1024));
    const out = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0));
    let at = 0;
    for (const b of blocks) { out.set(b, at); at += b.length; }
    return out;
  }

  it('reads a GitHub tarball (.tar.gz, pax header, long names) and drops the top folder', async () => {
    const long = `acme-shop-1a2b3c/${'deep/'.repeat(20)}x.ts`;
    const files = await readTarball(gzipSync(tar({ 'acme-shop-1a2b3c/src/a.ts': 'export const a = 1;', [long]: 'export function x() {}' })));
    expect(files.map((f) => f.path)).toEqual(['acme-shop-1a2b3c/src/a.ts', long]);
    expect(stripCommonRoot(files).map((f) => f.path)[0]).toBe('src/a.ts');
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('export const a = 1;');
    expect(await readTarball(tar({ 'a/b.ts': 'b' }), (p) => p.endsWith('.py'))).toEqual([]);
  });
});

describe('graph import', () => {
  it('imports graphify graph.json (node-link, _src/_tgt, confidence)', () => {
    const doc = {
      directed: false, multigraph: false, graph: { schema_version: 2, graphify_version: '0.9.1' },
      nodes: [
        { id: 'auth_create', label: 'createSession', source_file: 'src/auth.ts', source_location: 'L12', file_type: 'code' },
        { id: 'auth_hash', label: 'hashToken', source_file: 'src/crypto.ts', source_location: 'L3' },
        { id: 'concept_sessions', label: 'Sessions (concept)' },
      ],
      links: [
        { source: 'auth_hash', target: 'auth_create', _src: 'auth_create', _tgt: 'auth_hash', relation: 'calls', confidence: 'EXTRACTED' },
        { source: 'auth_create', target: 'concept_sessions', relation: 'uses', confidence: 'INFERRED' },
      ],
    };
    expect(detectGraphFormat(doc)).toBe('graphify');
    const g = importCodeGraph(doc, { sourceId: 'gx', name: 'shop', now: 5 });
    expect(g.generator).toBe('graphify/0.9.1');
    expect(g.symbols.map((s) => [s.id, s.line])).toEqual([['src/auth.ts#createSession', 12], ['src/crypto.ts#hashToken', 3]]);
    expect(g.edges).toEqual([{ from: 'src/auth.ts#createSession', to: 'src/crypto.ts#hashToken', kind: 'calls', confidence: 'extracted' }]);
    expect(g.warnings?.[0]).toMatch(/1 nodes without a source file/);
  });

  it('imports generic nodes/edges JSON (GitNexus-style rows)', () => {
    const doc = {
      nodes: [
        { id: 1, name: 'OrderService', label: 'Class', filePath: 'java/OrderService.java', startLine: 3, endLine: 9 },
        { id: 2, name: 'find', label: 'Method', filePath: 'java/OrderService.java', startLine: 4, signature: 'public Order find(String id)' },
        { id: 3, name: 'constructor', label: 'Function', filePath: 'a.js', startLine: 1 },
      ],
      relationships: [{ startNode: 1, endNode: 2, type: 'DEFINES' }, { source: 2, target: 3, kind: 'CALLS' }],
    };
    expect(detectGraphFormat(doc)).toBe('generic');
    const g = importCodeGraph(doc, { sourceId: 'gn', name: 'orders' });
    expect(g.symbols.map((s) => [s.qualified, s.kind])).toEqual([['constructor', 'function'], ['OrderService', 'class'], ['find', 'method']]);
    expect(g.symbols.find((s) => s.name === 'find')!.signature).toBe('public Order find(String id)');
    expect(g.edges.map((e) => e.kind).sort()).toEqual(['calls', 'contains']);
    expect(() => importCodeGraph({ hello: 1 }, { sourceId: 'x', name: 'x' })).toThrow(/Not a code graph/);
  });
});
