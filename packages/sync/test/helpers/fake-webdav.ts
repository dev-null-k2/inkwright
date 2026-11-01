/**
 * A fake WebDAV server (Nextcloud-flavoured) behind an injected fetch: PROPFIND (Depth 0/1;
 * infinity refused), GET, PUT (If-Match / If-None-Match, 409 without parent), DELETE, MKCOL.
 */

type Node = { type: 'dir' } | { type: 'file'; bytes: Uint8Array; etag: string; mtime: number };

export interface FakeDavOptions {
  /** Server-side path the user's files live under. */
  root?: string;
  username?: string;
  password?: string;
  bearer?: string;
  /** XML flavour of PROPFIND responses. */
  xmlStyle?: 'd-prefix' | 'default-ns' | 'upper';
  /** Return absolute URLs in <href> instead of absolute paths. */
  absoluteHrefs?: boolean;
  /** Omit the ETag header on PUT (forces a PROPFIND Depth: 0). */
  omitPutEtag?: boolean;
}

export class FakeDav {
  readonly nodes = new Map<string, Node>([['', { type: 'dir' }]]);
  readonly log: { method: string; path: string; headers: Record<string, string> }[] = [];
  readonly origin = 'https://cloud.example.com';
  readonly root: string;
  private seq = 0;
  private t = Date.UTC(2026, 0, 1);
  private faults: { match: (method: string, path: string) => boolean; status: number; times: number }[] = [];

  constructor(private readonly opts: FakeDavOptions = {}) {
    this.root = opts.root ?? '/remote.php/dav/files/alice';
  }

  fault(match: (method: string, path: string) => boolean, status: number, times = 1): void {
    this.faults.push({ match, status, times });
  }

  /** Writes a file directly (another client). Creates parents. */
  put(path: string, content: string | Uint8Array): string {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!this.nodes.has(d)) this.nodes.set(d, { type: 'dir' });
    }
    const etag = `"e${++this.seq}"`;
    this.t += 1000;
    this.nodes.set(path, { type: 'file', bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content, etag, mtime: this.t });
    return etag;
  }

  text(path: string): string | null {
    const n = this.nodes.get(path);
    return n?.type === 'file' ? new TextDecoder().decode(n.bytes) : null;
  }

  count(method: string): number {
    return this.log.filter((l) => l.method === method).length;
  }

  private parent(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }

  private href(path: string, dir: boolean): string {
    const enc = path
      .split('/')
      .filter(Boolean)
      .map((s) => encodeURIComponent(s).replace(/'/g, '%27'));
    const p = this.root + '/' + enc.join('/') + (dir && enc.length ? '/' : '');
    return this.opts.absoluteHrefs ? this.origin + p : p;
  }

  private propXml(path: string, n: Node): string {
    const s = this.opts.xmlStyle ?? 'd-prefix';
    const P = s === 'default-ns' ? '' : s === 'upper' ? 'D:' : 'd:';
    const props =
      n.type === 'dir'
        ? `<${P}resourcetype><${P}collection/></${P}resourcetype><${P}getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</${P}getlastmodified>`
        : `<${P}resourcetype/><${P}getetag>${n.etag.replace(/"/g, '&quot;')}</${P}getetag><${P}getcontentlength>${n.bytes.length}</${P}getcontentlength><${P}getlastmodified>${new Date(n.mtime).toUTCString()}</${P}getlastmodified>`;
    // A second propstat with 404 for an unsupported prop, as real servers send.
    return (
      `<${P}response><${P}href>${this.href(path, n.type === 'dir').replace(/&/g, '&amp;')}</${P}href>` +
      `<${P}propstat><${P}prop>${props}</${P}prop><${P}status>HTTP/1.1 200 OK</${P}status></${P}propstat>` +
      `<${P}propstat><${P}prop><oc:size xmlns:oc="http://owncloud.org/ns"/></${P}prop><${P}status>HTTP/1.1 404 Not Found</${P}status></${P}propstat>` +
      `</${P}response>`
    );
  }

  private multistatus(inner: string): string {
    const s = this.opts.xmlStyle ?? 'd-prefix';
    if (s === 'default-ns') return `<?xml version="1.0"?>\n<multistatus xmlns="DAV:">${inner}</multistatus>`;
    if (s === 'upper') return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><!-- apache -->${inner}</D:multistatus>`;
    return `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">\n${inner}\n</d:multistatus>`;
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const hobj: Record<string, string> = {};
    headers.forEach((v, k) => (hobj[k] = v));
    if (!url.pathname.startsWith(this.root + '/') && url.pathname !== this.root) return new Response('outside', { status: 403 });
    const rel = url.pathname
      .slice(this.root.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
      .join('/');
    this.log.push({ method, path: rel, headers: hobj });

    const auth = headers.get('Authorization') ?? '';
    const okAuth = this.opts.bearer
      ? auth === `Bearer ${this.opts.bearer}`
      : auth === `Basic ${btoa(`${this.opts.username ?? 'alice'}:${this.opts.password ?? 'secret'}`)}`;
    if (!okAuth) return new Response('auth', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' } });

    const fault = this.faults.find((f) => f.match(method, rel));
    if (fault) {
      if (--fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1);
      return new Response('fault', { status: fault.status });
    }

    const node = this.nodes.get(rel);
    const body = init.body == null ? new Uint8Array(0) : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body as ArrayBuffer);

    switch (method) {
      case 'PROPFIND': {
        const depth = headers.get('Depth');
        if (depth !== '0' && depth !== '1') return new Response('Depth infinity disabled', { status: 403 });
        if (!node) return new Response('not found', { status: 404 });
        let inner = this.propXml(rel, node);
        if (depth === '1' && node.type === 'dir') {
          const prefix = rel ? rel + '/' : '';
          for (const [p, n] of this.nodes) {
            if (p === rel || !p.startsWith(prefix) || p.slice(prefix.length).includes('/')) continue;
            inner += this.propXml(p, n);
          }
        }
        return new Response(this.multistatus(inner), { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
      }
      case 'GET': {
        if (!node) return new Response('not found', { status: 404 });
        if (node.type === 'dir') return new Response('dir', { status: 405 });
        return new Response(node.bytes.slice(), { status: 200, headers: { ETag: node.etag, 'Last-Modified': new Date(node.mtime).toUTCString() } });
      }
      case 'PUT': {
        const parent = this.nodes.get(this.parent(rel));
        if (!parent || parent.type !== 'dir') return new Response('parent missing', { status: 409 });
        if (node?.type === 'dir') return new Response('is dir', { status: 405 });
        const ifMatch = headers.get('If-Match');
        const ifNone = headers.get('If-None-Match');
        if (ifMatch && (!node || node.etag !== ifMatch)) return new Response('precondition', { status: 412 });
        if (ifNone === '*' && node) return new Response('precondition', { status: 412 });
        const etag = this.put(rel, body);
        return new Response(null, { status: node ? 204 : 201, headers: this.opts.omitPutEtag ? {} : { ETag: etag } });
      }
      case 'DELETE': {
        if (!node) return new Response('not found', { status: 404 });
        const ifMatch = headers.get('If-Match');
        if (ifMatch && (node.type !== 'file' || node.etag !== ifMatch)) return new Response('precondition', { status: 412 });
        for (const p of [...this.nodes.keys()]) if (p === rel || p.startsWith(rel + '/')) this.nodes.delete(p);
        return new Response(null, { status: 204 });
      }
      case 'MKCOL': {
        if (node) return new Response('exists', { status: 405 });
        if (this.nodes.get(this.parent(rel))?.type !== 'dir') return new Response('parent missing', { status: 409 });
        this.nodes.set(rel, { type: 'dir' });
        return new Response(null, { status: 201 });
      }
    }
    return new Response('unsupported', { status: 501 });
  };
}
