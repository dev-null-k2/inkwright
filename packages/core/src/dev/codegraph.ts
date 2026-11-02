/**
 * The code graph: what Inkwright knows about a repository the user mounted as a "code source".
 * Symbols (functions, classes, methods, exported constants, HTTP routes…) with a hash of their
 * signature, plus the call / import / containment edges between them, stored as plain JSON in the
 * vault (`code/sources/<sourceId>/graph.json`, docs/VAULT_FORMAT.md › Code sources) so it syncs,
 * survives without the repository, and can be read by the MCP server, the CLI and other tools.
 *
 * Docs rot because nothing notices when the code under them changes. Notes link to symbols with
 * `[[code:path#Symbol]]` (codelinks.ts); each link remembers the signature hash it was written
 * against, and a re-scan that changes the hash flags the link as drifted (drift.ts).
 */
import type { VaultFS } from '../fs.ts';
import { fuzzyScore } from '../links.ts';
import { sha256 } from '../sha256.ts';

export const CODE_GRAPH_VERSION = 1;
export const CODE_DIR = 'code/sources';

export type CodeLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust' | 'java';

export type CodeSymbolKind =
  | 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'const'
  | 'struct' | 'trait' | 'route' | 'module';

export type CodeEdgeKind = 'calls' | 'imports' | 'contains' | 'extends' | 'implements' | 'references' | 'handles';

/** How sure the extractor is of an edge (the vocabulary graphify uses). */
export type EdgeConfidence = 'extracted' | 'inferred' | 'ambiguous';

export interface CodeSymbol {
  /** `path#qualified` — unique in a graph, and exactly what a code link names. */
  id: string;
  /** Short name (`createSession`). */
  name: string;
  /** Name within its file (`SessionStore.create` for a method; `GET /health` for a route). */
  qualified: string;
  kind: CodeSymbolKind;
  /** Repository-relative POSIX path. */
  file: string;
  /** 1-based first and last line. */
  line: number;
  endLine: number;
  /** The declaration without its body, whitespace collapsed (`function f(a: number): string`). */
  signature: string;
  /** First 16 hex digits of SHA-256 of the signature: changes when the signature does. */
  hash: string;
  /** Same over the whole declaration (body included), to tell "implementation changed". */
  bodyHash?: string;
  exported?: boolean;
  /** First line of the doc comment right above the declaration. */
  doc?: string;
  /** The declaration's source, cut to `SOURCE_LIMIT` lines, so notes can show it without the repo. */
  source?: string;
  /** HTTP routes: the method and path the handler serves. */
  route?: { method: string; path: string };
}

export interface CodeEdge {
  /** Symbol id, or a file path for file-level imports. */
  from: string;
  /** Symbol id, file path, or `module:<name>` for packages outside the repository. */
  to: string;
  kind: CodeEdgeKind;
  confidence?: EdgeConfidence;
}

export interface CodeFile {
  path: string;
  language: CodeLanguage | 'other';
  /** First 16 hex digits of SHA-256 of the file's bytes (a re-scan skips nothing; this is for tools). */
  hash: string;
  size: number;
}

export interface CodeGraph {
  formatVersion: number;
  sourceId: string;
  /** Display name of the repository. */
  name: string;
  scannedAt: number;
  /** What produced it: `inkwright-tree-sitter/1`, `graphify`, `generic-json`. */
  generator: string;
  files: CodeFile[];
  symbols: CodeSymbol[];
  edges: CodeEdge[];
  /** Files skipped because of the scan limits (too many, too large, binary). */
  skipped?: number;
  /** Parse problems worth showing ("src/x.rs: grammar failed to load"). */
  warnings?: string[];
}

export type CodeSourceKind = 'folder' | 'zip' | 'tarball' | 'cli' | 'graphify' | 'generic';

/** `code/sources/<id>/source.json`: where a code source came from and how its last scan went. */
export interface CodeSource {
  id: string;
  name: string;
  kind: CodeSourceKind;
  /** Folder name, archive file name or absolute path (CLI) — informational. */
  origin?: string;
  createdAt: number;
  scannedAt: number;
  stats: { files: number; symbols: number; edges: number; skipped?: number };
  formatVersion: number;
}

/** Lines of source kept per symbol. */
export const SOURCE_LIMIT = 80;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Whitespace-insensitive signature fingerprint (reformatting a signature is not drift). */
export function signatureHash(signature: string): string {
  return hex(sha256(normalizeSignature(signature))).slice(0, 16);
}

export function normalizeSignature(signature: string): string {
  // Formatting is not a change: spacing, line breaks and trailing commas.
  return signature.replace(/\s+/g, ' ').replace(/\s*([(),:<>[\]{}=|&;])\s*/g, '$1').replace(/,([)\]}>])/g, '$1').trim();
}

export function contentHash(text: string | Uint8Array): string {
  return hex(sha256(text)).slice(0, 16);
}

export const symbolId = (file: string, qualified: string) => `${file}#${qualified}`;

// ---- Lookup ------------------------------------------------------------------------------------

/** Fast lookups over one graph (by id, by file, callers/callees). Build once per graph. */
export class CodeIndex {
  readonly byId = new Map<string, CodeSymbol>();
  private byFile = new Map<string, CodeSymbol[]>();
  private out = new Map<string, CodeEdge[]>();
  private in = new Map<string, CodeEdge[]>();

  constructor(readonly graph: CodeGraph) {
    for (const s of graph.symbols) {
      this.byId.set(s.id, s);
      const list = this.byFile.get(s.file) ?? [];
      list.push(s);
      this.byFile.set(s.file, list);
    }
    for (const e of graph.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.in.get(e.to) ?? this.in.set(e.to, []).get(e.to)!).push(e);
    }
  }

  hasFile(path: string): boolean {
    return this.byFile.has(path) || this.graph.files.some((f) => f.path === path);
  }

  inFile(path: string): CodeSymbol[] {
    return this.byFile.get(path) ?? [];
  }

  /** `qualified` in `file`, else a unique symbol whose short name matches (`#create` → `Store.create`). */
  find(file: string, symbol: string): CodeSymbol | null {
    const exact = this.byId.get(symbolId(file, symbol));
    if (exact) return exact;
    const inFile = this.inFile(file).filter((s) => s.name === symbol || s.qualified.endsWith(`.${symbol}`));
    return inFile.length === 1 ? inFile[0]! : null;
  }

  /** Symbols with the same qualified name in other files (a moved symbol). */
  elsewhere(file: string, qualified: string): CodeSymbol[] {
    return this.graph.symbols.filter((s) => s.qualified === qualified && s.file !== file);
  }

  callers(id: string): CodeSymbol[] {
    return (this.in.get(id) ?? []).filter((e) => e.kind === 'calls').map((e) => this.byId.get(e.from)).filter((s): s is CodeSymbol => !!s);
  }

  callees(id: string): CodeSymbol[] {
    return (this.out.get(id) ?? []).filter((e) => e.kind === 'calls').map((e) => this.byId.get(e.to)).filter((s): s is CodeSymbol => !!s);
  }

  edgesFrom(id: string): CodeEdge[] { return this.out.get(id) ?? []; }
  edgesTo(id: string): CodeEdge[] { return this.in.get(id) ?? []; }
}

export interface CodeSearchHit {
  symbol: CodeSymbol;
  sourceId: string;
  score: number;
}

/**
 * Symbols matching a query: fuzzy on the qualified name (best), then the file path; `kind` and a
 * path prefix narrow it. A query like `auth.ts#create` searches that file for `create`.
 */
export function searchSymbols(graphs: readonly CodeGraph[], query: string, opts: { limit?: number; kind?: CodeSymbolKind; path?: string } = {}): CodeSearchHit[] {
  const q = query.trim();
  const hash = q.indexOf('#');
  const fileQ = hash >= 0 ? q.slice(0, hash) : '';
  const symQ = hash >= 0 ? q.slice(hash + 1) : q;
  const out: CodeSearchHit[] = [];
  for (const g of graphs) {
    for (const s of g.symbols) {
      if (opts.kind && s.kind !== opts.kind) continue;
      if (opts.path && !s.file.startsWith(opts.path)) continue;
      let score: number;
      if (fileQ) {
        const f = fuzzyScore(fileQ, s.file);
        if (f < 0) continue;
        const n = symQ ? fuzzyScore(symQ, s.qualified) : 1;
        if (n < 0) continue;
        score = n + f * 0.25;
      } else {
        const n = fuzzyScore(symQ, s.qualified);
        const f = fuzzyScore(symQ, s.file);
        if (n < 0 && f < 0) continue;
        score = Math.max(n, f * 0.5);
      }
      // Exported, top-level things are what people link to most.
      if (s.exported) score += 2;
      if (s.kind === 'method') score -= 1;
      out.push({ symbol: s, sourceId: g.sourceId, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id)).slice(0, opts.limit ?? 20);
}

// ---- Vault storage -----------------------------------------------------------------------------

export const codeSourceDir = (id: string) => `${CODE_DIR}/${id}`;
export const codeSourcePath = (id: string) => `${CODE_DIR}/${id}/source.json`;
export const codeGraphPath = (id: string) => `${CODE_DIR}/${id}/graph.json`;

const SAFE = /^[0-9A-Za-z_-]{1,64}$/;

/** Reads and writes code sources and their graphs in a vault. */
export class CodeStore {
  constructor(private fs: VaultFS) {}

  async listSources(): Promise<CodeSource[]> {
    const out: CodeSource[] = [];
    for (const e of await this.fs.list(CODE_DIR)) {
      if (e.kind !== 'dir' || !SAFE.test(e.name)) continue;
      const s = await this.readSource(e.name);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.scannedAt - a.scannedAt);
  }

  async readSource(id: string): Promise<CodeSource | null> {
    if (!SAFE.test(id)) return null;
    const raw = await this.fs.readText(codeSourcePath(id));
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as CodeSource;
      return s && typeof s.id === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  async readGraph(id: string): Promise<CodeGraph | null> {
    if (!SAFE.test(id)) return null;
    const raw = await this.fs.readText(codeGraphPath(id));
    if (!raw) return null;
    try {
      const g = JSON.parse(raw) as CodeGraph;
      return g && Array.isArray(g.symbols) && Array.isArray(g.edges) ? { ...g, files: g.files ?? [] } : null;
    } catch {
      return null;
    }
  }

  async readAllGraphs(): Promise<CodeGraph[]> {
    const out: CodeGraph[] = [];
    for (const s of await this.listSources()) {
      const g = await this.readGraph(s.id);
      if (g) out.push(g);
    }
    return out;
  }

  /** Writes a scan's graph and updates (or creates) its source record. */
  async save(source: Omit<CodeSource, 'stats' | 'formatVersion' | 'scannedAt'>, graph: CodeGraph): Promise<CodeSource> {
    if (!SAFE.test(source.id)) throw new Error(`Invalid code source id: ${source.id}`);
    const rec: CodeSource = {
      ...source,
      scannedAt: graph.scannedAt,
      stats: { files: graph.files.length, symbols: graph.symbols.length, edges: graph.edges.length, ...(graph.skipped ? { skipped: graph.skipped } : {}) },
      formatVersion: CODE_GRAPH_VERSION,
    };
    // The graph first: a source record never points at a missing graph.
    await this.fs.writeText(codeGraphPath(source.id), JSON.stringify({ ...graph, sourceId: source.id }));
    await this.fs.writeText(codeSourcePath(source.id), JSON.stringify(rec, null, 2));
    return rec;
  }

  async remove(id: string): Promise<void> {
    if (!SAFE.test(id)) return;
    await this.fs.deleteDir(codeSourceDir(id));
  }
}
