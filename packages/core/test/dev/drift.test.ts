import { describe, expect, it } from 'vitest';
import {
  CodeIndex, CodeStore, MemoryFS, codeRefStates, describeDrift, driftReport, formatCodeLink, linkLabel, linkTrigger, markCodeRefReviewed,
  newNote, newPage, noteCodeLinks, parseCodeTarget, parseWikiLinks, pruneCodeBaselines, scanRepository, withCodeBaselines,
  type CodeGraph, type NoteMeta, type PageInk,
} from '../../src/index.ts';
import { nodeParser } from './parser.ts';
import { REPO, repoFiles } from './fixture-repo.ts';

const scan = (over: Record<string, string | null> = {}) => scanRepository(repoFiles(over), nodeParser(), { sourceId: 'shop', name: 'shop', now: 1 });

function noteWith(text: string, links: PageInk['links'] = [], strokes = 0): { meta: NoteMeta; pages: PageInk[] } {
  const page: PageInk = { ...newPage('p1'), texts: [{ id: 't1', x: 0, y: 0, width: 300, text, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 1 }], links };
  for (let i = 0; i < strokes; i++) page.strokes.push({ id: `s${i}`, pen: 'fountain', color: '#FF000000', size: 2, createdAt: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 5, y: 5, t: 5 }] });
  return { meta: newNote({ id: 'n1', title: 'Auth design', pageId: 'p1', now: 1 }), pages: [page] };
}

describe('code link syntax', () => {
  it('parses and formats targets, and reads as the symbol name', () => {
    expect(parseCodeTarget('code:src/a.ts#Store.put')).toEqual({ path: 'src/a.ts', symbol: 'Store.put' });
    expect(parseCodeTarget('code:./src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(parseCodeTarget('code:../etc/passwd')).toBeNull();
    expect(parseCodeTarget('Biology#Page 2')).toBeNull();
    expect(formatCodeLink({ path: 'src/server.ts', symbol: 'GET /health' })).toBe('[[code:src/server.ts#GET /health]]');
    const [l] = parseWikiLinks('See [[code:src/auth/session.ts#createSession]] for details');
    expect(l!.title).toBe('code:src/auth/session.ts');
    expect(linkLabel(l!)).toBe('createSession');
    expect(linkLabel(parseWikiLinks('[[code:src/db.ts]]')[0]!)).toBe('db.ts');
    expect(linkLabel(parseWikiLinks('[[code:src/db.ts#insert|the insert]]')[0]!)).toBe('the insert');
  });

  it('triggers code autocomplete after [[code:', () => {
    expect(linkTrigger('see [[code:src/auth#crea')).toEqual({ kind: 'code', query: 'src/auth#crea', start: 4 });
    expect(linkTrigger('see [[Bio#Pa')).toMatchObject({ kind: 'page' });
    expect(linkTrigger('see [[co')).toMatchObject({ kind: 'note', query: 'co' });
  });

  it('finds code links in typed text, recognized handwriting and ink', () => {
    const n = noteWith('[[code:src/db.ts#insert]] and [[Other note]]', [{ id: 'k1', strokeIds: ['s0'], target: 'code:src/auth/crypto.ts#hashToken', createdAt: 1 }], 1);
    n.pages[0]!.recognizedText = 'calls [[code:src/db.ts#remove]]';
    expect(noteCodeLinks(n.pages).map((o) => [o.key, o.source])).toEqual([
      ['src/db.ts#insert', 'text'], ['src/db.ts#remove', 'handwriting'], ['src/auth/crypto.ts#hashToken', 'ink'],
    ]);
  });
});

describe('drift', () => {
  it('records a baseline on first sight, then reports ok', async () => {
    const g = await scan();
    const ix = [new CodeIndex(g)];
    const n = noteWith('Sessions start in [[code:src/auth/session.ts#createSession]].');
    const s1 = codeRefStates(n.meta, n.pages, ix);
    expect(s1.map((s) => s.status)).toEqual(['new']);
    const meta = withCodeBaselines(n.meta, s1, 100);
    expect(meta.codeRefs!['src/auth/session.ts#createSession']).toMatchObject({ hash: s1[0]!.current!.hash, signature: 'function createSession(userId: string, ttlMs: number): Session', sourceId: 'shop', linkedAt: 100 });
    expect(withCodeBaselines(meta, codeRefStates(meta, n.pages, ix), 200)).toBe(meta);
    expect(codeRefStates(meta, n.pages, ix)[0]!.status).toBe('ok');
  });

  it('flags a changed signature, shows old and new, and clears when reviewed', async () => {
    const n = noteWith('[[code:src/auth/session.ts#createSession]]');
    const meta = withCodeBaselines(n.meta, codeRefStates(n.meta, n.pages, [new CodeIndex(await scan())]), 100);
    const g2 = await scan({ 'src/auth/session.ts': REPO['src/auth/session.ts']!.replace('ttlMs: number): Session', 'ttlMs: number, scope: string[]): Session') });
    const [st] = codeRefStates(meta, n.pages, [new CodeIndex(g2)]);
    expect(st!.status).toBe('changed');
    expect(st!.baseline!.signature).toContain('ttlMs: number)');
    expect(st!.current!.signature).toContain('scope: string[]');
    expect(describeDrift(st!)).toMatch(/was: .*\n {2}now: /);
    const reviewed = markCodeRefReviewed(meta, st!, 300);
    expect(reviewed.codeRefs!['src/auth/session.ts#createSession']).toMatchObject({ hash: st!.current!.hash, reviewedAt: 300, linkedAt: 100 });
    expect(codeRefStates(reviewed, n.pages, [new CodeIndex(g2)])[0]!.status).toBe('ok');
    // The note's text is never touched.
    expect(n.pages[0]!.texts![0]!.text).toBe('[[code:src/auth/session.ts#createSession]]');
  });

  it('does not flag formatting-only or body-only changes', async () => {
    const n = noteWith('[[code:src/auth/session.ts#createSession]]');
    const meta = withCodeBaselines(n.meta, codeRefStates(n.meta, n.pages, [new CodeIndex(await scan())]), 1);
    const g2 = await scan({ 'src/auth/session.ts': REPO['src/auth/session.ts']!.replace('const token = hashToken(userId);', 'const token = hashToken(userId.trim());') });
    expect(codeRefStates(meta, n.pages, [new CodeIndex(g2)])[0]!.status).toBe('ok');
  });

  it('tells missing from moved, and unresolved/unknown from drift', async () => {
    const n = noteWith('[[code:src/db.ts#insert]] [[code:src/auth/crypto.ts#hashToken]] [[code:src/nope.ts#x]]');
    const meta = withCodeBaselines(n.meta, codeRefStates(n.meta, n.pages, [new CodeIndex(await scan())]), 1);
    const g2 = await scan({ 'src/db.ts': 'export function remove(table: string, value: string) {}\n', 'src/auth/crypto.ts': null, 'src/auth/hash.ts': REPO['src/auth/crypto.ts']! });
    const st = Object.fromEntries(codeRefStates(meta, n.pages, [new CodeIndex(g2)]).map((s) => [s.key, s]));
    expect(st['src/db.ts#insert']!.status).toBe('missing');
    expect(st['src/auth/crypto.ts#hashToken']!.status).toBe('moved');
    expect(st['src/auth/crypto.ts#hashToken']!.movedTo!.map((s) => s.id)).toEqual(['src/auth/hash.ts#hashToken']);
    expect(st['src/nope.ts#x']!.status).toBe('unresolved');
    expect(codeRefStates(meta, n.pages, [])[0]!.status).toBe('unknown');
  });

  it('reports drift across notes and prunes baselines of removed links', async () => {
    const g1 = await scan();
    const a = noteWith('[[code:src/db.ts#insert]]');
    a.meta = withCodeBaselines(a.meta, codeRefStates(a.meta, a.pages, [new CodeIndex(g1)]), 1);
    const g2 = await scan({ 'src/db.ts': 'export function insert(table: string, value: Buffer) {}\n' });
    const report = driftReport([a], [g2]);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ noteId: 'n1', title: 'Auth design', key: 'src/db.ts#insert', status: 'changed' });
    expect(driftReport([{ ...a, meta: { ...a.meta, trashedAt: 5 } }], [g2])).toEqual([]);
    a.pages[0]!.texts![0]!.text = 'no more links';
    const pruned = pruneCodeBaselines(a.meta, a.pages);
    expect(pruned.codeRefs).toBeUndefined();
  });

  it('stores code sources and graphs in the vault', async () => {
    const fs = new MemoryFS();
    const store = new CodeStore(fs);
    const g = await scan();
    const rec = await store.save({ id: 'shop', name: 'shop', kind: 'zip', origin: 'shop.zip', createdAt: 1 }, g);
    expect(rec.stats.symbols).toBe(g.symbols.length);
    expect(fs.paths()).toEqual(['code/sources/shop/graph.json', 'code/sources/shop/source.json']);
    expect((await store.listSources()).map((s) => s.id)).toEqual(['shop']);
    expect((await store.readGraph('shop'))!.symbols.length).toBe(g.symbols.length);
    expect(await store.readGraph('../x')).toBeNull();
    await store.remove('shop');
    expect(await store.listSources()).toEqual([]);
    expect(((await store.readAllGraphs()) as CodeGraph[]).length).toBe(0);
  });
});
