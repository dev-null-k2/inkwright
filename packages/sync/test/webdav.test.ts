import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@inkwright/core';
import { MemoryStateStore, PreconditionFailedError, SyncEngine, WebDavRemote, parseMultistatus, parseXml, type WebDavRemoteOptions } from '../src/index.ts';
import { FakeDav, type FakeDavOptions } from './helpers/fake-webdav.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function setup(dav: FakeDavOptions = {}, opts: Partial<WebDavRemoteOptions> = {}) {
  const server = new FakeDav(dav);
  const remote = new WebDavRemote({
    url: `${server.origin}${server.root}/Inkwright`,
    auth: { type: 'basic', username: 'alice', password: 'secret' },
    fetch: server.fetch,
    retry: { sleep: async () => {} },
    ...opts,
  });
  return { server, remote };
}

describe('XML parsing', () => {
  it('parses namespaced, default-namespace and entity-laden documents', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><!-- c --><a:root xmlns:a="DAV:"><a:x attr="1>2">t&amp;u &#x41;&#66;</a:x><y/><![CDATA[<raw>]]></a:root>',
    );
    const root = doc.children[0]!;
    expect(root.name).toBe('root');
    expect(root.children.map((c) => c.name)).toEqual(['x', 'y']);
    expect(root.children[0]!.text).toBe('t&u AB');
    expect(root.text).toBe('<raw>');
  });

  it('rejects malformed XML', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/Malformed/);
    expect(() => parseXml('<a>')).toThrow(/unclosed/);
  });

  it('extracts resources from a multistatus, ignoring non-2xx propstats', () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/dav/Inkwright/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
        <d:response><d:href>/dav/Inkwright/a%20b.json</d:href>
          <d:propstat><d:prop><d:getetag>&quot;abc&quot;</d:getetag><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Wed, 01 Jan 2025 10:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
    expect(parseMultistatus(xml)).toEqual([
      { href: '/dav/Inkwright/', isCollection: true },
      { href: '/dav/Inkwright/a%20b.json', isCollection: false, etag: '"abc"', contentLength: 12, lastModified: Date.UTC(2025, 0, 1, 10) },
    ]);
  });
});

describe('WebDavRemote', () => {
  for (const xmlStyle of ['d-prefix', 'default-ns', 'upper'] as const) {
    it(`lists recursively with Depth: 1 PROPFINDs (${xmlStyle} XML)`, async () => {
      const { server, remote } = setup({ xmlStyle, absoluteHrefs: xmlStyle === 'upper' });
      server.put('Inkwright/inkwright.json', '{}');
      server.put('Inkwright/notes/n1/note.json', 'n1');
      server.put('Inkwright/notes/n1/pages/p1.ink.json', 'p1');
      server.put('Inkwright/notes/n1/assets/my photo #1.png', 'img');
      server.put('Inkwright/notes/n2/note.json', 'n2');
      server.put('Inkwright/.DS_Store', 'junk');
      server.put('Other/secret.txt', 'outside the vault');
      const list = await remote.list();
      expect(list.map((e) => e.path).sort()).toEqual([
        'inkwright.json',
        'notes/n1/assets/my photo #1.png',
        'notes/n1/note.json',
        'notes/n1/pages/p1.ink.json',
        'notes/n2/note.json',
      ]);
      const e = list.find((x) => x.path === 'notes/n1/note.json')!;
      expect(e.rev).toMatch(/^"e\d+"$/);
      expect(e.size).toBe(2);
      expect(e.mtime).toBeGreaterThan(0);
      expect(server.log.filter((l) => l.method === 'PROPFIND').every((l) => l.headers.depth === '1')).toBe(true);
    });
  }

  it('treats a missing vault folder as an empty remote', async () => {
    const { remote } = setup();
    expect(await remote.list()).toEqual([]);
  });

  it('creates collections with MKCOL and files with If-None-Match: *', async () => {
    const { server, remote } = setup();
    const w = await remote.write('notes/n1/pages/p1.ink.json', enc.encode('{"id":"p1"}'), null);
    expect(server.text('Inkwright/notes/n1/pages/p1.ink.json')).toBe('{"id":"p1"}');
    expect(w.rev).toMatch(/^"e\d+"$/);
    expect(server.count('MKCOL')).toBe(4); // Inkwright, notes, n1, pages
    const put = server.log.find((l) => l.method === 'PUT')!;
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers['content-type']).toBe('application/json');
    await remote.write('notes/n1/pages/p2.ink.json', enc.encode('{}'));
    expect(server.count('MKCOL')).toBe(4); // cached
  });

  it('enforces If-Match and reports conflicts as PreconditionFailedError', async () => {
    const { server, remote } = setup();
    const v1 = await remote.write('a.json', enc.encode('one'));
    await expect(remote.write('a.json', enc.encode('dup'), null)).rejects.toBeInstanceOf(PreconditionFailedError);
    server.put('Inkwright/a.json', 'theirs');
    await expect(remote.write('a.json', enc.encode('mine'), v1.rev)).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(remote.delete('a.json', v1.rev)).rejects.toBeInstanceOf(PreconditionFailedError);
    const cur = (await remote.read('a.json'))!;
    expect(dec.decode(cur.bytes)).toBe('theirs');
    const v3 = await remote.write('a.json', enc.encode('merged'), cur.rev);
    expect(server.log.filter((l) => l.method === 'PUT').at(-1)!.headers['if-match']).toBe(cur.rev);
    await remote.delete('a.json', v3.rev);
    expect(server.text('Inkwright/a.json')).toBeNull();
    await remote.delete('a.json'); // missing: no-op
    expect(await remote.read('a.json')).toBeNull();
  });

  it('falls back to PROPFIND Depth: 0 when PUT returns no ETag', async () => {
    const { server, remote } = setup({ omitPutEtag: true });
    const w = await remote.write('x/y.json', enc.encode('1'));
    expect(w.rev).toBe((await remote.list())[0]!.rev);
    expect(server.log.some((l) => l.method === 'PROPFIND' && l.headers.depth === '0')).toBe(true);
  });

  it('recreates collections deleted by another client (409 on PUT)', async () => {
    const { server, remote } = setup();
    await remote.write('notes/n1/note.json', enc.encode('a'));
    for (const k of [...server.nodes.keys()]) if (k.startsWith('Inkwright/notes')) server.nodes.delete(k);
    await remote.write('notes/n1/pages/p.ink.json', enc.encode('b'));
    expect(server.text('Inkwright/notes/n1/pages/p.ink.json')).toBe('b');
  });

  it('percent-encodes names and round-trips unusual characters', async () => {
    const { server, remote } = setup();
    const name = 'notes/n1/assets/Résumé (final) #2 & more%.pdf';
    await remote.write(name, enc.encode('pdf'));
    expect(server.text(`Inkwright/${name}`)).toBe('pdf');
    expect((await remote.list()).map((e) => e.path)).toEqual([name]);
    expect(dec.decode((await remote.read(name))!.bytes)).toBe('pdf');
  });

  it('supports bearer tokens and surfaces auth failures', async () => {
    const ok = setup({ bearer: 'tkn' }, { auth: { type: 'bearer', token: async () => 'tkn' } });
    await ok.remote.write('a.txt', enc.encode('x'));
    const bad = setup({}, { auth: { type: 'basic', username: 'alice', password: 'wrong' } });
    await expect(bad.remote.list()).rejects.toMatchObject({ status: 401 });
  });

  it('retries 503s and fails the whole listing if a folder cannot be read', async () => {
    const { server, remote } = setup({}, { retry: { retries: 2, sleep: async () => {} } });
    server.put('Inkwright/notes/n1/note.json', 'x');
    server.fault((m, p) => m === 'PROPFIND' && p === 'Inkwright/notes', 503, 2);
    expect((await remote.list()).map((e) => e.path)).toEqual(['notes/n1/note.json']);
    server.fault((m, p) => m === 'PROPFIND' && p === 'Inkwright/notes/n1', 500, 5);
    await expect(remote.list()).rejects.toMatchObject({ status: 500 });
  });

  it('syncs two devices through WebDAV end to end, merging a concurrent note edit', async () => {
    const server = new FakeDav();
    const mk = () => new WebDavRemote({ url: `${server.origin}${server.root}/Inkwright/`, auth: { type: 'basic', username: 'alice', password: 'secret' }, fetch: server.fetch });
    const a = new MemoryFS();
    const b = new MemoryFS();
    const note = (title: string, tags: string[], updatedAt: number) => JSON.stringify({ id: 'n', title, kind: 'paged', pageIds: ['p'], tags, createdAt: 1, updatedAt, pinned: false, formatVersion: 2 });
    await a.writeText('notes/n/note.json', note('T', ['x'], 10));
    const ea = new SyncEngine({ local: a, remote: mk(), state: new MemoryStateStore(), regenerateDerived: false });
    const eb = new SyncEngine({ local: b, remote: mk(), state: new MemoryStateStore(), regenerateDerived: false });
    await ea.sync();
    await eb.sync();
    await a.writeText('notes/n/note.json', note('T', ['x', 'from-a'], 20));
    await b.writeText('notes/n/note.json', note('Renamed on B', ['x', 'from-b'], 30));
    await ea.sync();
    const r = await eb.sync();
    expect(r.merged).toEqual(['notes/n/note.json']);
    await ea.sync();
    const merged = JSON.parse((await a.readText('notes/n/note.json'))!);
    expect(merged.title).toBe('Renamed on B');
    expect(merged.tags).toEqual(['x', 'from-b', 'from-a']);
    expect(await b.readText('notes/n/note.json')).toBe(await a.readText('notes/n/note.json'));
    expect(server.text('Inkwright/notes/n/note.json')).toBe(await a.readText('notes/n/note.json'));
  });
});
