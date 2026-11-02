import { HttpClient, httpError, type RetryOptions } from './http.ts';
import { PreconditionFailedError, RemoteError, type Remote, type RemoteCallOptions, type RemoteEntry, type RemoteFile } from './remote.ts';
import { Inflight, base64Encode, isJunkName, mapLimit, mimeTypeFor, safePath, segments, utf8Encode } from './util.ts';

// ---- Tiny XML reader (enough for WebDAV multistatus; no DOMParser in workers/Node) -------------

export interface XmlNode {
  /** Local name (namespace prefix stripped). */
  name: string;
  children: XmlNode[];
  /** Concatenated character data directly inside this element. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<(\/?)([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

/** Parses XML into a namespace-agnostic element tree. Throws on unbalanced tags. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', children: [], text: '' };
  const stack: XmlNode[] = [root];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1]; // CDATA
    else if (m[3] !== undefined) {
      const local = m[3].slice(m[3].indexOf(':') + 1);
      if (m[2] === '/') {
        if (stack.length < 2 || top.name !== local) throw new Error(`Malformed XML: unexpected </${m[3]}>`);
        stack.pop();
      } else {
        const node: XmlNode = { name: local, children: [], text: '' };
        top.children.push(node);
        if (m[5] !== '/') stack.push(node);
      }
    } else if (m[6] !== undefined) top.text += decodeXmlEntities(m[6]);
  }
  if (stack.length !== 1) throw new Error('Malformed XML: unclosed elements');
  return root;
}

function child(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.find((c) => c.name === name);
}

function descendants(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else descendants(c, name, out);
  }
  return out;
}

export interface DavResource {
  href: string;
  isCollection: boolean;
  etag?: string;
  lastModified?: number;
  contentLength?: number;
}

/** Extracts resources from a 207 Multi-Status body (only props from 2xx propstats). */
export function parseMultistatus(xml: string): DavResource[] {
  const doc = parseXml(xml);
  const out: DavResource[] = [];
  for (const r of descendants(doc, 'response')) {
    const href = child(r, 'href')?.text.trim();
    if (!href) continue;
    const res: DavResource = { href, isCollection: false };
    for (const ps of r.children.filter((c) => c.name === 'propstat')) {
      const status = child(ps, 'status')?.text ?? '';
      if (!/\s2\d\d(\s|$)/.test(status)) continue;
      const prop = child(ps, 'prop');
      if (!prop) continue;
      if (child(child(prop, 'resourcetype'), 'collection')) res.isCollection = true;
      const etag = child(prop, 'getetag')?.text.trim();
      if (etag) res.etag = etag;
      const lm = child(prop, 'getlastmodified')?.text.trim();
      if (lm && Number.isFinite(Date.parse(lm))) res.lastModified = Date.parse(lm);
      const len = child(prop, 'getcontentlength')?.text.trim();
      if (len && /^\d+$/.test(len)) res.contentLength = Number(len);
    }
    out.push(res);
  }
  return out;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>';

// ---- Remote ---------------------------------------------------------------------------------

export type WebDavAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string | (() => Promise<string>) };

export interface WebDavRemoteOptions {
  /** Collection URL of the vault folder, e.g. `https://cloud.example.com/remote.php/dav/files/alice/Inkwright/`. */
  url: string;
  auth?: WebDavAuth;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  /** Parallel PROPFINDs while listing (default 4). */
  concurrency?: number;
}

function normEtag(e: string | null | undefined): string | undefined {
  if (!e) return undefined;
  const t = e.trim();
  return t.startsWith('"') || t.startsWith('W/') ? t : `"${t}"`;
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

/**
 * WebDAV remote (Nextcloud, ownCloud, Apache mod_dav, rclone serve, ...). Lists with PROPFIND
 * Depth: 1 per collection (Depth: infinity is usually disabled), writes with PUT +
 * If-Match / If-None-Match, creates collections with MKCOL.
 */
export class WebDavRemote implements Remote {
  private readonly http: HttpClient;
  private readonly base: URL;
  private readonly baseSegs: string[];
  private knownDirs = new Set<string>();
  private readonly mkcols = new Inflight<boolean>();

  constructor(private readonly opts: WebDavRemoteOptions) {
    this.base = new URL(opts.url.endsWith('/') ? opts.url : opts.url + '/');
    this.baseSegs = decodeSegments(this.base.pathname) ?? [];
    const auth = opts.auth;
    this.http = new HttpClient({
      fetch: opts.fetch,
      retry: opts.retry,
      headers: async () => {
        const h: Record<string, string> = { ...opts.headers };
        if (auth?.type === 'basic') h.Authorization = `Basic ${base64Encode(utf8Encode(`${auth.username}:${auth.password}`))}`;
        else if (auth?.type === 'bearer') h.Authorization = `Bearer ${typeof auth.token === 'string' ? auth.token : await auth.token()}`;
        return h;
      },
    });
  }

  /** Absolute URL for a vault path (each segment percent-encoded); dirs get a trailing slash. */
  urlFor(path: string, dir = false): string {
    const segs = segments(path).map(encodeURIComponent);
    return new URL(segs.join('/') + (dir && segs.length ? '/' : ''), this.base).toString();
  }

  /** Vault-relative path for an href from a multistatus, or null if outside the vault. */
  private relPath(href: string): string | null {
    let u: URL;
    try {
      u = new URL(href, this.base);
    } catch {
      return null;
    }
    const segs = decodeSegments(u.pathname);
    if (!segs || segs.length < this.baseSegs.length) return null;
    for (let i = 0; i < this.baseSegs.length; i++) if (segs[i] !== this.baseSegs[i]) return null;
    return segs.slice(this.baseSegs.length).join('/');
  }

  private async propfind(path: string, depth: '0' | '1', signal?: AbortSignal): Promise<DavResource[] | null> {
    const res = await this.http.request({
      method: 'PROPFIND',
      url: this.urlFor(path, depth === '1'),
      headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      signal,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (res.status !== 207) throw await httpError(res, `PROPFIND ${path || '/'}`);
    try {
      return parseMultistatus(await res.text());
    } catch (e) {
      throw new RemoteError(`PROPFIND ${path || '/'}: unreadable response (${(e as Error).message})`, 207, true);
    }
  }

  async list(opts: RemoteCallOptions = {}): Promise<RemoteEntry[]> {
    const out = new Map<string, RemoteEntry>();
    const dirs = new Set<string>(['']);
    let rootMissing = false;
    let level = [''];
    while (level.length) {
      const next: string[] = [];
      await mapLimit(
        level,
        this.opts.concurrency ?? 4,
        async (dir) => {
          const items = await this.propfind(dir, '1', opts.signal);
          if (!items) {
            if (dir === '') {
              rootMissing = true; // vault folder not created yet: empty remote
              return;
            }
            throw new RemoteError(`Collection vanished while listing: ${dir}`, 404, true);
          }
          for (const it of items) {
            const p = this.relPath(it.href);
            if (p === null || p === dir) continue;
            const name = p.slice(p.lastIndexOf('/') + 1);
            if (isJunkName(name)) continue;
            try {
              if (safePath(p) !== p) continue;
            } catch {
              continue;
            }
            if (it.isCollection) {
              if (!dirs.has(p)) {
                dirs.add(p);
                next.push(p);
              }
            } else {
              out.set(p, { path: p, rev: normEtag(it.etag) ?? `lm:${it.lastModified ?? ''}:${it.contentLength ?? ''}`, mtime: it.lastModified, size: it.contentLength });
            }
          }
        },
        opts.signal,
      );
      level = next;
    }
    if (rootMissing) dirs.delete('');
    this.knownDirs = dirs;
    return [...out.values()];
  }

  private async etagOf(path: string, signal?: AbortSignal): Promise<string | undefined> {
    const r = await this.propfind(path, '0', signal);
    return normEtag(r?.find((x) => !x.isCollection)?.etag);
  }

  async read(path: string, opts: RemoteCallOptions = {}): Promise<RemoteFile | null> {
    const p = safePath(path);
    const res = await this.http.request({ method: 'GET', url: this.urlFor(p), signal: opts.signal });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await httpError(res, `GET ${p}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const rev = normEtag(res.headers.get('ETag') ?? res.headers.get('OC-ETag')) ?? (await this.etagOf(p, opts.signal)) ?? '';
    const lm = res.headers.get('Last-Modified');
    return { bytes, rev, mtime: lm ? Date.parse(lm) : undefined };
  }

  /** Forgets cached collections on the path to `dir` (another client may have deleted them). */
  private forgetDirs(dir: string): void {
    for (const d of [...this.knownDirs]) if (d === '' || d === dir || dir.startsWith(d + '/') || d.startsWith(dir + '/')) this.knownDirs.delete(d);
  }

  /** MKCOL every missing ancestor of `dir` (the vault root included). */
  private async ensureDirs(dir: string, signal?: AbortSignal, retry = true): Promise<void> {
    const segs = segments(dir);
    for (let i = 0; i <= segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (this.knownDirs.has(d)) continue;
      const parentMissing = await this.mkcols.run(d, async () => {
        const res = await this.http.request({ method: 'MKCOL', url: this.urlFor(d, true), signal });
        // 201 created; 405 already exists (some servers say 301/302 for an existing collection).
        if (res.status === 201 || res.status === 405 || res.status === 301 || res.status === 302 || res.ok) {
          await res.body?.cancel().catch(() => {});
          this.knownDirs.add(d);
          return false;
        }
        if (res.status === 409) {
          await res.body?.cancel().catch(() => {});
          return true; // a cached ancestor is gone
        }
        throw await httpError(res, `MKCOL ${d || '/'}`);
      });
      if (parentMissing) {
        if (!retry) throw new RemoteError(`MKCOL ${d}: parent collection missing`, 409);
        this.forgetDirs(dir);
        return this.ensureDirs(dir, signal, false);
      }
    }
  }

  async write(path: string, bytes: Uint8Array, ifMatch?: string | null, opts: RemoteCallOptions = {}): Promise<RemoteEntry> {
    const p = safePath(path);
    if (p === '') throw new Error('Cannot write to the vault root');
    const dir = p.slice(0, Math.max(0, p.lastIndexOf('/')));
    await this.ensureDirs(dir, opts.signal);
    const headers: Record<string, string> = { 'Content-Type': mimeTypeFor(p) };
    if (ifMatch === null) headers['If-None-Match'] = '*';
    else if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    for (let attempt = 0; ; attempt++) {
      const res = await this.http.request({ method: 'PUT', url: this.urlFor(p), headers, body: bytes, signal: opts.signal });
      if (res.status === 412) {
        await res.body?.cancel().catch(() => {});
        throw new PreconditionFailedError(p);
      }
      if (res.status === 409 && attempt === 0) {
        // Parent collection missing (deleted by another client): forget the cache and recreate.
        await res.body?.cancel().catch(() => {});
        this.forgetDirs(dir);
        await this.ensureDirs(dir, opts.signal);
        continue;
      }
      if (!res.ok) throw await httpError(res, `PUT ${p}`);
      await res.body?.cancel().catch(() => {});
      const rev = normEtag(res.headers.get('ETag') ?? res.headers.get('OC-ETag')) ?? (await this.etagOf(p, opts.signal));
      if (!rev) throw new RemoteError(`PUT ${p}: server returned no ETag`, res.status);
      const lm = res.headers.get('Last-Modified');
      return { path: p, rev, size: bytes.length, mtime: lm ? Date.parse(lm) : undefined };
    }
  }

  async delete(path: string, ifMatch?: string, opts: RemoteCallOptions = {}): Promise<void> {
    const p = safePath(path);
    if (p === '') throw new Error('Refusing to delete the vault root');
    const headers: Record<string, string> = {};
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    const res = await this.http.request({ method: 'DELETE', url: this.urlFor(p), headers, signal: opts.signal });
    if (!res.ok && res.status !== 404 && res.status !== 412) throw await httpError(res, `DELETE ${p}`);
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) {
      if (ifMatch !== undefined) throw new PreconditionFailedError(p, 'missing');
      return;
    }
    if (res.status === 412) throw new PreconditionFailedError(p);
  }
}
