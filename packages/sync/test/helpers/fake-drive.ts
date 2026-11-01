import { createHash } from 'node:crypto';
import type { DriveFile } from '../../src/gdrive.ts';

/**
 * A fake Google Drive v3 server behind an injected `fetch`. Implements the subset the remote
 * uses: files.list with `q` (and/or/parentheses, name/mimeType/parents/trashed) and paging,
 * files.get (metadata and alt=media), JSON create, multipart upload, media PATCH, metadata
 * PATCH (trash), DELETE. Checks bearer tokens and can inject faults.
 */

export const ROOT_ID = 'my-drive-root';
const FOLDER = 'application/vnd.google-apps.folder';

interface StoredFile {
  meta: DriveFile;
  content: Uint8Array;
}

interface Fault {
  match: (method: string, url: URL) => boolean;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  times: number;
}

// ---- q parser -----------------------------------------------------------------------------------

type Tok = { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string } | { t: '(' } | { t: ')' };

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "'") {
      let v = '';
      i++;
      while (i < q.length && q[i] !== "'") {
        if (q[i] === '\\') i++;
        v += q[i++];
      }
      if (q[i] !== "'") throw new Error(`Unterminated string in q: ${q}`);
      i++;
      out.push({ t: 'str', v });
    } else if (c === '(' || c === ')') {
      out.push({ t: c });
      i++;
    } else if (c === '!' && q[i + 1] === '=') {
      out.push({ t: 'op', v: '!=' });
      i += 2;
    } else if (c === '=') {
      out.push({ t: 'op', v: '=' });
      i++;
    } else {
      const m = /^[A-Za-z]+/.exec(q.slice(i));
      if (!m) throw new Error(`Bad q at ${i}: ${q}`);
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

type Pred = (f: DriveFile) => boolean;

export function parseQ(q: string): Pred {
  const toks = tokenize(q);
  let p = 0;
  const peek = () => toks[p];
  const isId = (v: string) => {
    const t = peek();
    return t?.t === 'id' && t.v === v;
  };
  const parseOr = (): Pred => {
    let left = parseAnd();
    while (isId('or')) {
      p++;
      const l = left;
      const r = parseAnd();
      left = (f) => l(f) || r(f);
    }
    return left;
  };
  const parseAnd = (): Pred => {
    let left = parseAtom();
    while (isId('and')) {
      p++;
      const l = left;
      const r = parseAtom();
      left = (f) => l(f) && r(f);
    }
    return left;
  };
  const parseAtom = (): Pred => {
    const t = toks[p++];
    if (!t) throw new Error(`Unexpected end of q: ${q}`);
    if (t.t === '(') {
      const e = parseOr();
      if (toks[p++]?.t !== ')') throw new Error(`Missing ) in q: ${q}`);
      return e;
    }
    if (t.t === 'str') {
      // '<id>' in parents
      if (!(isId('in') && toks[p + 1]?.t === 'id' && (toks[p + 1] as { v: string }).v === 'parents')) throw new Error(`Bad clause in q: ${q}`);
      p += 2;
      const id = t.v === 'root' ? ROOT_ID : t.v;
      return (f) => (f.parents ?? []).includes(id);
    }
    if (t.t === 'id') {
      const op = toks[p++];
      const val = toks[p++];
      if (op?.t !== 'op' || !val) throw new Error(`Bad comparison in q: ${q}`);
      const v = val.t === 'str' || val.t === 'id' ? val.v : '';
      const get = (f: DriveFile): string => {
        switch (t.v) {
          case 'name':
            return f.name;
          case 'mimeType':
            return f.mimeType;
          case 'trashed':
            return String(Boolean(f.trashed));
          default:
            throw new Error(`Unsupported field ${t.v}`);
        }
      };
      return op.v === '=' ? (f) => get(f) === v : (f) => get(f) !== v;
    }
    throw new Error(`Unexpected token in q: ${q}`);
  };
  const pred = parseOr();
  if (p !== toks.length) throw new Error(`Trailing tokens in q: ${q}`);
  return pred;
}

// ---- multipart ------------------------------------------------------------------------------------

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function parseMultipart(body: Uint8Array, contentType: string): { headers: Record<string, string>; body: Uint8Array }[] {
  const m = /boundary=([^;]+)/.exec(contentType);
  if (!m) throw new Error('multipart without boundary');
  const enc = new TextEncoder();
  const delim = enc.encode(`--${m[1]}`);
  const parts: { headers: Record<string, string>; body: Uint8Array }[] = [];
  let pos = indexOf(body, delim);
  if (pos < 0) throw new Error('multipart: no boundary in body');
  for (;;) {
    pos += delim.length;
    if (body[pos] === 45 && body[pos + 1] === 45) break; // closing "--"
    pos += 2; // CRLF
    const headerEnd = indexOf(body, enc.encode('\r\n\r\n'), pos);
    const headers: Record<string, string> = {};
    for (const line of new TextDecoder().decode(body.subarray(pos, headerEnd)).split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const next = indexOf(body, delim, headerEnd + 4);
    if (next < 0) throw new Error('multipart: unterminated part');
    parts.push({ headers, body: body.slice(headerEnd + 4, next - 2) }); // strip CRLF before boundary
    pos = next;
  }
  return parts;
}

// ---- server ------------------------------------------------------------------------------------

export class FakeDrive {
  readonly files = new Map<string, StoredFile>();
  readonly log: { method: string; path: string; search: string }[] = [];
  validToken = 'token-1';
  /** Max page size actually served (small to exercise paging). */
  maxPageSize = 3;
  private nextId = 1;
  private faults: Fault[] = [];
  private t = Date.UTC(2026, 0, 1);

  private now(): string {
    this.t += 1000;
    return new Date(this.t).toISOString();
  }

  private md5(b: Uint8Array): string {
    return createHash('md5').update(b).digest('hex');
  }

  /** Injects `status` for the next `times` requests matching `match`. */
  fault(match: (method: string, url: URL) => boolean, status: number, opts: { headers?: Record<string, string>; body?: unknown; times?: number } = {}): void {
    this.faults.push({ match, status, headers: opts.headers, body: opts.body, times: opts.times ?? 1 });
  }

  /** Creates a file/folder directly, as if another client did it. */
  seed(name: string, parent: string, opts: { folder?: boolean; content?: string | Uint8Array; trashed?: boolean } = {}): DriveFile {
    const id = `id${this.nextId++}`;
    const content = typeof opts.content === 'string' ? new TextEncoder().encode(opts.content) : (opts.content ?? new Uint8Array(0));
    const now = this.now();
    const meta: DriveFile = {
      id,
      name,
      mimeType: opts.folder ? FOLDER : 'application/octet-stream',
      parents: [parent === 'root' ? ROOT_ID : parent],
      createdTime: now,
      modifiedTime: now,
      version: '1',
      trashed: opts.trashed ?? false,
    };
    if (!opts.folder) {
      meta.md5Checksum = this.md5(content);
      meta.size = String(content.length);
    }
    this.files.set(id, { meta, content });
    return meta;
  }

  /** Overwrites a file's content as another client would. */
  modify(id: string, content: string | Uint8Array): void {
    const f = this.files.get(id)!;
    f.content = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    f.meta = { ...f.meta, md5Checksum: this.md5(f.content), size: String(f.content.length), version: String(Number(f.meta.version) + 1), modifiedTime: this.now() };
  }

  /** Resolves a slash path from the root (by name) to the live (non-trashed) file, if any. */
  find(path: string, root: string): StoredFile | undefined {
    let parent = root;
    let cur: StoredFile | undefined;
    for (const name of path.split('/')) {
      cur = [...this.files.values()].find((f) => !f.meta.trashed && f.meta.name === name && f.meta.parents?.includes(parent));
      if (!cur) return undefined;
      parent = cur.meta.id;
    }
    return cur;
  }

  count(filter: (method: string, path: string) => boolean): number {
    return this.log.filter((l) => filter(l.method, l.path)).length;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  private error(status: number, message: string, reason = 'error'): Response {
    return this.json(status, { error: { code: status, message, errors: [{ reason, message }] } });
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    this.log.push({ method, path: url.pathname, search: url.search });
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');

    if (url.host !== 'www.googleapis.com') return this.error(404, 'unknown host');
    if (headers.get('Authorization') !== `Bearer ${this.validToken}`) return this.error(401, 'Invalid Credentials', 'authError');

    const fault = this.faults.find((f) => f.match(method, url));
    if (fault) {
      if (--fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1);
      return this.json(fault.status, fault.body ?? { error: { code: fault.status, message: 'injected' } }, fault.headers);
    }

    const body = init.body == null ? new Uint8Array(0) : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body as ArrayBuffer);
    const path = url.pathname;
    const fileMatch = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path);

    if (path === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const pred = parseQ(q);
      if (!(url.searchParams.get('fields') ?? '').includes('nextPageToken')) return this.error(400, 'fields must request nextPageToken');
      const all = [...this.files.values()].map((f) => f.meta).filter(pred).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? 100), this.maxPageSize);
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return this.json(200, { files: page, ...(next ? { nextPageToken: next } : {}) });
    }

    if (path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(new TextDecoder().decode(body));
      return this.json(200, this.create(meta, new Uint8Array(0)));
    }

    if (path === '/upload/drive/v3/files' && method === 'POST') {
      if (url.searchParams.get('uploadType') !== 'multipart') return this.error(400, 'expected multipart');
      const parts = parseMultipart(body, headers.get('Content-Type') ?? '');
      if (parts.length !== 2 || !parts[0]!.headers['content-type']?.startsWith('application/json')) return this.error(400, 'bad multipart');
      const meta = JSON.parse(new TextDecoder().decode(parts[0]!.body));
      return this.json(200, this.create({ ...meta, mimeType: meta.mimeType ?? parts[1]!.headers['content-type'] }, parts[1]!.body));
    }

    if (fileMatch) {
      const isUpload = Boolean(fileMatch[1]);
      const f = this.files.get(decodeURIComponent(fileMatch[2]!));
      if (!f) return this.error(404, 'File not found', 'notFound');
      if (method === 'GET') {
        if (url.searchParams.get('alt') === 'media') return new Response(f.content.slice(), { status: 200 });
        return this.json(200, f.meta);
      }
      if (method === 'PATCH' && isUpload) {
        if (url.searchParams.get('uploadType') !== 'media') return this.error(400, 'expected media upload');
        this.modify(f.meta.id, body);
        return this.json(200, f.meta);
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(new TextDecoder().decode(body));
        f.meta = { ...f.meta, ...patch, version: String(Number(f.meta.version) + 1), modifiedTime: this.now() };
        return this.json(200, f.meta);
      }
      if (method === 'DELETE') {
        this.files.delete(f.meta.id);
        return new Response(null, { status: 204 });
      }
    }
    return this.error(400, `Unsupported ${method} ${path}`);
  };

  private create(meta: { name: string; mimeType?: string; parents?: string[] }, content: Uint8Array): DriveFile {
    const f = this.seed(meta.name, meta.parents?.[0] ?? ROOT_ID, { folder: meta.mimeType === FOLDER, content });
    if (meta.mimeType && meta.mimeType !== FOLDER) f.mimeType = meta.mimeType;
    return { ...f };
  }
}
