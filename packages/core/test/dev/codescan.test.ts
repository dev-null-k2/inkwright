import { describe, expect, it } from 'vitest';
import { CodeIndex, ignoredPath, languageOf, normalizeSignature, resolveImport, scanRepository, searchSymbols, signatureHash, stripCommonRoot, type CodeGraph } from '../../src/index.ts';
import { nodeParser } from './parser.ts';
import { repoFiles } from './fixture-repo.ts';

let cached: CodeGraph | null = null;
async function scan(): Promise<CodeGraph> {
  cached ??= await scanRepository(repoFiles(), nodeParser(), { sourceId: 'shop', name: 'shop', now: 1 });
  return cached;
}
const ids = (g: CodeGraph) => g.symbols.map((s) => s.id);
const edge = (g: CodeGraph, from: string, to: string, kind: string) => g.edges.find((e) => e.from === from && e.to === to && e.kind === kind);

describe('code scan', () => {
  it('skips dependencies, build output and non-code files', async () => {
    const g = await scan();
    expect(g.files.map((f) => f.path)).not.toContain('node_modules/leftpad/index.js');
    expect(g.files.map((f) => f.path)).not.toContain('dist/app.min.js');
    expect(g.files.map((f) => f.path)).not.toContain('README.md');
    expect(ignoredPath('a/node_modules/b.js')).toBe(true);
    expect(languageOf('types.d.ts')).toBeNull();
    expect(languageOf('x.tsx')).toBe('tsx');
  });

  it('extracts TypeScript functions, classes, methods, interfaces, constants and routes', async () => {
    const g = await scan();
    const s = ids(g);
    for (const id of ['src/auth/session.ts#createSession', 'src/auth/session.ts#Session', 'src/auth/session.ts#SessionStore', 'src/auth/session.ts#SessionStore.get',
      'src/auth/session.ts#SessionStore.put', 'src/auth/session.ts#SESSION_COOKIE', 'src/auth/session.ts#revoke', 'src/server.ts#GET /health', 'src/server.ts#POST /login']) {
      expect(s).toContain(id);
    }
    const cs = g.symbols.find((x) => x.id === 'src/auth/session.ts#createSession')!;
    expect(cs).toMatchObject({ kind: 'function', exported: true, line: 5, doc: 'Creates a session for a signed-in user.' });
    expect(cs.signature).toBe('function createSession(userId: string, ttlMs: number): Session');
    expect(cs.hash).toBe(signatureHash(cs.signature));
    expect(cs.source).toContain('hashToken(userId)');
    expect(g.symbols.find((x) => x.id === 'src/auth/session.ts#revoke')!.signature).toBe('const revoke = async (token: string): Promise<void> =>');
    expect(g.symbols.find((x) => x.id === 'src/auth/session.ts#BaseStore')!.exported).toBeUndefined();
  });

  it('resolves calls, imports, handlers, containment and heritage', async () => {
    const g = await scan();
    expect(edge(g, 'src/auth/session.ts#createSession', 'src/auth/crypto.ts#hashToken', 'calls')?.confidence).toBe('extracted');
    expect(edge(g, 'src/auth/session.ts#createSession', 'src/db.ts#insert', 'calls')).toBeTruthy();
    expect(edge(g, 'src/auth/session.ts#SessionStore.put', 'src/auth/session.ts#SessionStore.touch', 'calls')).toBeTruthy();
    expect(edge(g, 'src/auth/session.ts', 'src/auth/crypto.ts', 'imports')).toBeTruthy();
    expect(edge(g, 'src/auth/session.ts', 'src/db.ts', 'imports')).toBeTruthy();
    expect(edge(g, 'src/server.ts', 'module:express', 'imports')).toBeTruthy();
    expect(edge(g, 'src/server.ts#GET /health', 'src/server.ts#health', 'handles')).toBeTruthy();
    expect(edge(g, 'src/server.ts#POST /login', 'src/auth/session.ts#createSession', 'calls')).toBeTruthy();
    expect(edge(g, 'src/auth/session.ts#SessionStore', 'src/auth/session.ts#SessionStore.get', 'contains')).toBeTruthy();
    expect(edge(g, 'src/auth/session.ts#SessionStore', 'src/auth/session.ts#BaseStore', 'extends')).toBeTruthy();
  });

  it('extracts Python, with Flask routes', async () => {
    const g = await scan();
    expect(ids(g)).toEqual(expect.arrayContaining(['api/app.py#user', 'api/app.py#Repo', 'api/app.py#Repo.find', 'api/app.py#MAX_USERS', 'api/app.py#GET /users/<id>', 'api/app.py#DELETE /users/<id>']));
    expect(g.symbols.find((s) => s.id === 'api/app.py#Repo.find')!.signature).toBe('def find(self, id: str) -> User');
    expect(g.symbols.find((s) => s.id === 'api/app.py#Repo._lookup')!.exported).toBeUndefined();
    expect(edge(g, 'api/app.py#GET /users/<id>', 'api/app.py#user', 'handles')).toBeTruthy();
    expect(edge(g, 'api/app.py#user', 'api/models.py#load_user', 'calls')?.confidence).toBe('extracted');
    expect(edge(g, 'api/app.py#Repo.find', 'api/app.py#Repo._lookup', 'calls')).toBeTruthy();
    expect(edge(g, 'api/app.py', 'api/models.py', 'imports')).toBeTruthy();
  });

  it('extracts Go, with net/http routes and module-local imports', async () => {
    const g = await scan();
    expect(ids(g)).toEqual(expect.arrayContaining(['cmd/main.go#main', 'store/store.go#Store', 'store/store.go#Reader', 'store/store.go#MaxItems', 'store/store.go#Store.ListItems', 'cmd/main.go#ANY /items', 'cmd/main.go#POST /items']));
    expect(g.symbols.find((s) => s.id === 'store/store.go#Store')!.kind).toBe('struct');
    expect(g.symbols.find((s) => s.id === 'store/store.go#Store.count')!.exported).toBeUndefined();
    expect(edge(g, 'cmd/main.go', 'store', 'imports')).toBeTruthy();
    expect(edge(g, 'cmd/main.go#main', 'store/store.go#New', 'calls')).toBeTruthy();
    expect(edge(g, 'cmd/main.go#ANY /items', 'store/store.go#Store.ListItems', 'handles')).toBeTruthy();
    expect(edge(g, 'store/store.go#Store.ListItems', 'store/store.go#Store.count', 'calls')).toBeTruthy();
  });

  it('extracts Rust, with impls and axum routes', async () => {
    const g = await scan();
    expect(ids(g)).toEqual(expect.arrayContaining(['src/lib.rs#Entry', 'src/lib.rs#Ledger', 'src/lib.rs#Entry.total', 'src/lib.rs#LIMIT', 'src/routes.rs#router', 'src/routes.rs#GET /entries', 'src/routes.rs#POST /entries']));
    expect(edge(g, 'src/lib.rs#Entry.total', 'src/lib.rs#helper', 'calls')).toBeTruthy();
    expect(edge(g, 'src/lib.rs#Entry', 'src/lib.rs#Ledger', 'implements')).toBeTruthy();
    expect(edge(g, 'src/routes.rs#GET /entries', 'src/routes.rs#list_entries', 'handles')).toBeTruthy();
    expect(edge(g, 'src/routes.rs', 'src/lib.rs', 'imports')).toBeUndefined(); // crate::Entry has no file of its own…
  });

  it('extracts Java, with Spring mappings', async () => {
    const g = await scan();
    expect(ids(g)).toEqual(expect.arrayContaining(['java/com/acme/OrderController.java#OrderController.get', 'java/com/acme/OrderController.java#GET /orders/{id}', 'java/com/acme/OrderController.java#POST /orders']));
    expect(edge(g, 'java/com/acme/OrderController.java#OrderController.get', 'java/com/acme/OrderService.java#OrderService.find', 'calls')).toBeTruthy();
    expect(edge(g, 'java/com/acme/OrderController.java', 'java/com/acme/OrderService.java', 'imports')).toBeTruthy();
  });

  it('is deterministic and order-independent', async () => {
    const a = await scan();
    const b = await scanRepository(repoFiles().reverse(), nodeParser(), { sourceId: 'shop', name: 'shop', now: 1 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('changes the hash only when the signature changes', async () => {
    const g2 = await scanRepository(repoFiles({
      'src/auth/session.ts': (await import('./fixture-repo.ts')).REPO['src/auth/session.ts']!
        .replace('export function createSession(userId: string, ttlMs: number): Session {', 'export function createSession(\n  userId: string,\n  ttlMs: number,\n): Session {')
        .replace('db.insert(', 'db.insert(  '),
    }), nodeParser(), { sourceId: 'shop', name: 'shop' });
    const before = (await scan()).symbols.find((s) => s.id === 'src/auth/session.ts#createSession')!;
    const after = g2.symbols.find((s) => s.id === 'src/auth/session.ts#createSession')!;
    expect(after.hash).toBe(before.hash);
    expect(normalizeSignature('f( a ,b )')).toBe('f(a,b)');
  });

  it('lists files of languages whose grammar is missing, without symbols', async () => {
    const g = await scanRepository(repoFiles(), { parse: (l) => (l === 'go' ? null : nodeParser().parse(l, '')) && null }, { sourceId: 's', name: 's' });
    expect(g.files.length).toBeGreaterThan(5);
    expect(g.symbols).toEqual([]);
    expect(g.warnings?.some((w) => w.includes('No go grammar'))).toBe(true);
  });

  it('respects the scan limits', async () => {
    const g = await scanRepository(repoFiles(), nodeParser(), { sourceId: 's', name: 's', limits: { maxFiles: 2 } });
    expect(g.files).toHaveLength(2);
    expect(g.skipped).toBeGreaterThan(5);
  });
});

describe('lookups', () => {
  it('finds symbols by id, short name, and fuzzy search', async () => {
    const g = await scan();
    const ix = new CodeIndex(g);
    expect(ix.find('src/auth/session.ts', 'createSession')?.kind).toBe('function');
    expect(ix.find('src/auth/session.ts', 'put')?.qualified).toBe('SessionStore.put');
    expect(ix.callers('src/auth/crypto.ts#hashToken').map((s) => s.id)).toEqual(['src/auth/session.ts#createSession']);
    expect(ix.callees('src/auth/session.ts#createSession').map((s) => s.name).sort()).toEqual(['hashToken', 'insert']);
    expect(searchSymbols([g], 'createSes')[0]!.symbol.id).toBe('src/auth/session.ts#createSession');
    expect(searchSymbols([g], 'session.ts#put')[0]!.symbol.id).toBe('src/auth/session.ts#SessionStore.put');
    expect(searchSymbols([g], 'items', { kind: 'route' }).map((h) => h.symbol.qualified)).toEqual(expect.arrayContaining(['ANY /items', 'POST /items']));
  });

  it('resolves imports per language', () => {
    const files = new Set(['src/a.ts', 'src/b/index.ts', 'pkg/mod.py', 'src/x/mod.rs', 'src/lib.rs', 'src/c.ts']);
    expect(resolveImport('src/a.ts', 'typescript', './b', files)).toBe('src/b/index.ts');
    expect(resolveImport('src/a.ts', 'typescript', './c.js', files)).toBe('src/c.ts');
    expect(resolveImport('src/a.ts', 'typescript', 'react', files)).toBe('module:react');
    expect(resolveImport('pkg/x.py', 'python', '.mod', files)).toBe('pkg/mod.py');
    expect(resolveImport('main.py', 'python', 'pkg.mod', files)).toBe('pkg/mod.py');
    expect(resolveImport('src/lib.rs', 'rust', 'crate::x', files)).toBe('src/x/mod.rs');
    expect(stripCommonRoot([{ path: 'repo-main/a.ts' }, { path: 'repo-main/b/c.ts' }]).map((f) => f.path)).toEqual(['a.ts', 'b/c.ts']);
    expect(stripCommonRoot([{ path: 'a.ts' }, { path: 'b/c.ts' }]).map((f) => f.path)).toEqual(['a.ts', 'b/c.ts']);
  });
});
