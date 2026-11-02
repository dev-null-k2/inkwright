import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@inkwright/core';
import {
  FolderRemote,
  HttpClient,
  MemoryRemote,
  PreconditionFailedError,
  RemoteError,
  base64Decode,
  base64Encode,
  mapLimit,
  safePath,
  sha256Hex,
  type Remote,
} from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Contract every Remote must honour (Drive and WebDAV have their own suites against fakes). */
function remoteContract(name: string, make: () => Remote) {
  describe(`Remote contract: ${name}`, () => {
    it('writes, lists, reads and deletes with consistent revs', async () => {
      const r = make();
      const w = await r.write('notes/n/note.json', enc.encode('{"a":1}'));
      await r.write('inkwright.json', enc.encode('{}'));
      const list = await r.list();
      expect(list.map((e) => e.path).sort()).toEqual(['inkwright.json', 'notes/n/note.json']);
      expect(list.find((e) => e.path === 'notes/n/note.json')!.rev).toBe(w.rev);
      const got = (await r.read('notes/n/note.json'))!;
      expect(dec.decode(got.bytes)).toBe('{"a":1}');
      expect(got.rev).toBe(w.rev);
      const w2 = await r.write('notes/n/note.json', enc.encode('{"a":2}'), w.rev);
      expect(w2.rev).not.toBe(w.rev);
      await r.delete('notes/n/note.json', w2.rev);
      expect(await r.read('notes/n/note.json')).toBeNull();
      await r.delete('notes/n/note.json');
    });

    it('enforces ifMatch guards', async () => {
      const r = make();
      const w = await r.write('a.txt', enc.encode('1'), null);
      await expect(r.write('a.txt', enc.encode('2'), null)).rejects.toBeInstanceOf(PreconditionFailedError);
      await expect(r.write('a.txt', enc.encode('2'), 'bogus-rev')).rejects.toBeInstanceOf(PreconditionFailedError);
      await expect(r.write('b.txt', enc.encode('2'), w.rev)).rejects.toBeInstanceOf(PreconditionFailedError);
      await expect(r.delete('a.txt', 'bogus-rev')).rejects.toBeInstanceOf(PreconditionFailedError);
      expect(dec.decode((await r.read('a.txt'))!.bytes)).toBe('1');
    });

    it('rejects unsafe paths', async () => {
      const r = make();
      await expect(r.write('../x', enc.encode('1'))).rejects.toThrow();
      await expect(r.read('a/../../x')).rejects.toThrow();
    });

    it('honours abort signals', async () => {
      const r = make();
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(r.list({ signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
}

remoteContract('MemoryRemote', () => new MemoryRemote());
remoteContract('FolderRemote', () => new FolderRemote(new MemoryFS()));

describe('MemoryRemote test hooks', () => {
  it('injects failures for matching ops and paths', async () => {
    const r = new MemoryRemote();
    r.failNext('write', { path: 'b.txt', times: 2 });
    await r.write('a.txt', enc.encode('a'));
    await expect(r.write('b.txt', enc.encode('b'))).rejects.toMatchObject({ status: 503, retryable: true });
    await expect(r.write('b.txt', enc.encode('b'))).rejects.toBeInstanceOf(RemoteError);
    await r.write('b.txt', enc.encode('b'));
    expect(r.paths()).toEqual(['a.txt', 'b.txt']);
  });

  it('simulates another writer and broken listings', async () => {
    const r = new MemoryRemote();
    const w = await r.write('a.txt', enc.encode('mine'));
    const other = r.put('a.txt', 'theirs');
    expect(other.rev).not.toBe(w.rev);
    await expect(r.write('a.txt', enc.encode('x'), w.rev)).rejects.toBeInstanceOf(PreconditionFailedError);
    r.listOverride = () => [];
    expect(await r.list()).toEqual([]);
    expect(r.text('a.txt')).toBe('theirs');
  });
});

describe('FolderRemote', () => {
  it('uses content hashes as revs and caches them by mtime/size', async () => {
    const fs = new MemoryFS();
    let reads = 0;
    const counting = Object.assign(Object.create(fs), {
      readBytes: (p: string) => {
        reads++;
        return fs.readBytes(p);
      },
    });
    const r = new FolderRemote(counting);
    await fs.writeText('a.txt', 'same');
    await fs.writeText('b.txt', 'same');
    const l1 = await r.list();
    expect(l1[0]!.rev).toBe(l1[1]!.rev);
    expect(l1[0]!.rev).toBe(`sha256:${await sha256Hex(enc.encode('same'))}`);
    reads = 0;
    await r.list();
    expect(reads).toBe(0);
    expect((await new FolderRemote(fs, { cacheHashes: false }).list()).length).toBe(2);
  });

  it('hides junk files from the listing', async () => {
    const fs = new MemoryFS();
    await fs.writeText('notes/.DS_Store', 'x');
    await fs.writeText('notes/n.json.1234.inkwright-tmp', 'x');
    await fs.writeText('notes/n.json', 'x');
    expect((await new FolderRemote(fs).list()).map((e) => e.path)).toEqual(['notes/n.json']);
  });
});

describe('utilities', () => {
  it('base64 round-trips all byte values and odd lengths, matching btoa', async () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 1000]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      const s = base64Encode(b);
      expect(s).toBe(btoa(String.fromCharCode(...b)));
      expect(Array.from(base64Decode(s))).toEqual(Array.from(b));
    }
    expect(Array.from(base64Decode('data:application/octet-stream;base64,AP8='))).toEqual([0, 255]);
    expect(Array.from(base64Decode('AP8'))).toEqual([0, 255]);
    expect(() => base64Decode('@@@@')).toThrow();
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(enc.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('safePath rejects escapes, backslashes and NULs', () => {
    expect(safePath('/a//b/./c')).toBe('a/b/c');
    expect(() => safePath('a/../../b')).toThrow();
    expect(() => safePath('a\\..\\b')).toThrow();
    expect(() => safePath('a\0b')).toThrow();
  });

  it('mapLimit bounds concurrency, rethrows the first error and stops on abort', async () => {
    let inflight = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapLimit(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (i) => {
        peak = Math.max(peak, ++inflight);
        await new Promise((r) => setTimeout(r, 1));
        seen.push(i);
        inflight--;
      },
    );
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5], 1, async (i) => {
        started.push(i);
        if (i === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
    const ctrl = new AbortController();
    await expect(
      mapLimit([1, 2, 3], 1, async (i) => {
        if (i === 1) ctrl.abort();
      }, ctrl.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('HttpClient', () => {
  const ok = () => new Response('ok', { status: 200 });

  it('retries network errors and retryable statuses with capped exponential backoff', async () => {
    const sleeps: number[] = [];
    const responses: (() => Response)[] = [
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('', { status: 502 }),
      () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
      ok,
    ];
    const http = new HttpClient({
      fetch: async () => responses.shift()!(),
      retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0, baseDelayMs: 100, maxDelayMs: 10_000 },
    });
    const res = await http.request({ method: 'GET', url: 'https://x.test/' });
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([50, 100, 10_000]); // jitter 0.5×; Retry-After capped
  });

  it('returns the last response after running out of retries, and does not retry 4xx', async () => {
    let calls = 0;
    const http = new HttpClient({ fetch: async () => (calls++, new Response('', { status: 503 })), retry: { retries: 2, sleep: async () => {} } });
    expect((await http.request({ method: 'GET', url: 'https://x.test/' })).status).toBe(503);
    expect(calls).toBe(3);
    calls = 0;
    const http2 = new HttpClient({ fetch: async () => (calls++, new Response('', { status: 404 })), retry: { sleep: async () => {} } });
    expect((await http2.request({ method: 'GET', url: 'https://x.test/' })).status).toBe(404);
    expect(calls).toBe(1);
  });

  it('refreshes auth once per request on 401 and sends fresh headers', async () => {
    let token = 'old';
    let refreshes = 0;
    const seen: string[] = [];
    const http = new HttpClient({
      fetch: async (_u, init) => {
        const auth = new Headers(init?.headers).get('Authorization')!;
        seen.push(auth);
        return auth === 'Bearer new' ? ok() : new Response('', { status: 401 });
      },
      headers: () => ({ Authorization: `Bearer ${token}` }),
      onUnauthorized: async () => {
        refreshes++;
        token = refreshes === 1 ? 'new' : 'newer';
        return true;
      },
    });
    expect((await http.request({ method: 'GET', url: 'https://x.test/' })).status).toBe(200);
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
    token = 'expired';
    expect((await http.request({ method: 'GET', url: 'https://x.test/' })).status).toBe(401);
    expect(refreshes).toBe(2);
  });

  it('aborts promptly, including during backoff', async () => {
    const ctrl = new AbortController();
    const http = new HttpClient({ fetch: async () => new Response('', { status: 503 }), retry: { baseDelayMs: 60_000 } });
    const p = http.request({ method: 'GET', url: 'https://x.test/', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
