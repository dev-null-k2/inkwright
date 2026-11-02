/**
 * Turns a repository's files into a `CodeGraph`: deterministic parsing with tree-sitter (no
 * model involved, so the same code always gives the same graph), then name resolution for call
 * and import edges.
 *
 * The parser is injected (`CodeParser`) so this file stays pure: the web app lazily loads
 * web-tree-sitter and the grammar `.wasm` files (apps/web/src/dev/treesitter.ts), the CLI and MCP
 * server load the same files from node_modules (apps/mcp-server/src/dev/treesitter.ts). Extraction
 * walks the syntax tree per language rather than using tree-sitter queries: the node types used
 * here are stable across grammar releases, and plain code is easier to test and to debug.
 */
import {
  CODE_GRAPH_VERSION, SOURCE_LIMIT, contentHash, signatureHash, symbolId,
  type CodeEdge, type CodeFile, type CodeGraph, type CodeLanguage, type CodeSymbol, type CodeSymbolKind, type EdgeConfidence,
} from './codegraph.ts';

/** The subset of web-tree-sitter's `Node` the extractor uses. */
export interface SyntaxNodeLike {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly namedChildren: readonly (SyntaxNodeLike | null)[];
  readonly parent: SyntaxNodeLike | null;
  readonly previousNamedSibling: SyntaxNodeLike | null;
  childForFieldName(name: string): SyntaxNodeLike | null;
  /** web-tree-sitter: the tree a root node belongs to; deleted after extraction to free wasm memory. */
  readonly tree?: { delete?(): void };
}

/** Parses one file. Returns null when the language's grammar is unavailable. */
export interface CodeParser {
  parse(language: CodeLanguage, text: string): Promise<SyntaxNodeLike | null> | SyntaxNodeLike | null;
}

export interface RepoFile {
  /** Repository-relative POSIX path. */
  path: string;
  bytes: Uint8Array;
}

export interface ScanLimits {
  /** Files parsed at most (default 4000); the rest count as skipped. */
  maxFiles?: number;
  /** Larger files are skipped (default 512 KB): generated bundles say nothing about the design. */
  maxFileBytes?: number;
}

const EXT: Record<string, CodeLanguage> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java',
};

export function languageOf(path: string): CodeLanguage | null {
  if (/\.d\.ts$/.test(path)) return null;
  const m = /\.([a-z]+)$/i.exec(path);
  const ext = m?.[1]!.toLowerCase();
  return ext && Object.hasOwn(EXT, ext) ? EXT[ext]! : null;
}

/** Folders that are never the design: dependencies, build output, caches, VCS internals. */
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'env',
  '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.vscode', 'Pods', '.terraform',
]);

/** Whether a repository path should be skipped before reading it. */
export function ignoredPath(path: string): boolean {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p))) return true;
  const name = parts[parts.length - 1]!;
  return /\.min\.(js|mjs|cjs)$/.test(name) || /\.(bundle|chunk)\.js$/.test(name) || name.endsWith('.map');
}

/** Archives from GitHub and friends wrap everything in one folder (`repo-main/`): drop it. */
export function stripCommonRoot<T extends { path: string }>(files: readonly T[]): T[] {
  if (!files.length) return [...files];
  const first = files[0]!.path.split('/')[0]!;
  if (!files.every((f) => f.path.startsWith(`${first}/`))) return [...files];
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

// ---- Per-file extraction -----------------------------------------------------------------------

interface RawCall {
  /** Symbol the call is made from. */
  from: string;
  /** The called name (`create`), and the receiver when it is `this`/`self` (method of the same class). */
  name: string;
  self?: boolean;
  /** `obj.name(...)`: the object's identifier, when it is a plain name (an imported module). */
  object?: string;
}

interface RawImport {
  /** Module specifier as written (`./auth`, `os`, `crate::db`, `com.x.Y`). */
  spec: string;
  /** Local name → exported name (named imports). `*` imports the module object under the local name. */
  names: Map<string, string>;
}

interface FileFacts {
  file: string;
  language: CodeLanguage;
  symbols: CodeSymbol[];
  calls: RawCall[];
  imports: RawImport[];
  /** Route symbol id → handler name (resolved after the scan). */
  handlers: { route: string; name: string }[];
  /** class symbol id → names it extends / implements. */
  heritage: { from: string; name: string; kind: 'extends' | 'implements' }[];
}

const named = (n: SyntaxNodeLike | null | undefined) => (n?.namedChildren ?? []).filter((c): c is SyntaxNodeLike => !!c);
const field = (n: SyntaxNodeLike, f: string) => n.childForFieldName(f);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const unquote = (s: string) => s.replace(/^[rbfu]*["'`]+|["'`]+$/gi, '');

class Extractor {
  readonly facts: FileFacts;
  private lines: string[];

  constructor(readonly file: string, readonly language: CodeLanguage, private text: string) {
    this.facts = { file, language, symbols: [], calls: [], imports: [], handlers: [], heritage: [] };
    this.lines = text.split('\n');
  }

  /** Text of `node` up to (not including) its body: the declaration's signature. */
  signature(node: SyntaxNodeLike, body: SyntaxNodeLike | null, prefix = ''): string {
    const end = body ? body.startIndex : node.endIndex;
    let s = this.text.slice(node.startIndex, end).trim();
    s = s.replace(/\s*(=>|:|\{)\s*$/, (m) => (m.trim() === '=>' ? ' =>' : ''));
    return clip(`${prefix}${s}`.replace(/\s+/g, ' ').trim(), 600);
  }

  /** The doc comment right above a declaration (first line), if any. */
  private doc(node: SyntaxNodeLike): string | undefined {
    let prev = node.previousNamedSibling;
    // Decorators and attributes sit between the comment and the item.
    while (prev && (prev.type === 'decorator' || prev.type === 'attribute_item')) prev = prev.previousNamedSibling;
    if (!prev || !/comment/.test(prev.type)) return undefined;
    if (node.startPosition.row - prev.endPosition.row > 1) return undefined;
    const line = prev.text.replace(/^\s*(\/\*\*?|\/\/\/?|#|--)\s?/, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).find((l) => l && !l.startsWith('@') && l !== '*/');
    return line ? clip(line.replace(/\*\/\s*$/, '').trim(), 200) : undefined;
  }

  add(node: SyntaxNodeLike, a: { name: string; qualified?: string; kind: CodeSymbolKind; signature: string; exported?: boolean; docNode?: SyntaxNodeLike; route?: CodeSymbol['route'] }): CodeSymbol {
    const qualified = a.qualified ?? a.name;
    const line = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const src = this.lines.slice(line - 1, Math.min(endLine, line - 1 + SOURCE_LIMIT));
    if (endLine - line + 1 > SOURCE_LIMIT) src.push(`… ${endLine - line + 1 - SOURCE_LIMIT} more lines`);
    const sym: CodeSymbol = {
      id: symbolId(this.file, qualified),
      name: a.name,
      qualified,
      kind: a.kind,
      file: this.file,
      line,
      endLine,
      signature: a.signature,
      hash: signatureHash(a.signature),
      bodyHash: contentHash(node.text.replace(/\s+/g, ' ')),
      source: src.join('\n'),
    };
    if (a.exported) sym.exported = true;
    const d = this.doc(a.docNode ?? node);
    if (d) sym.doc = d;
    if (a.route) sym.route = a.route;
    // Overloads and re-declarations keep the first; later ones would make ids collide.
    if (!this.facts.symbols.some((s) => s.id === sym.id)) this.facts.symbols.push(sym);
    return sym;
  }

  /** Records every call inside `body` as made from `from` (nested functions included). */
  collectCalls(body: SyntaxNodeLike | null, from: string) {
    if (!body) return;
    const stack: SyntaxNodeLike[] = [body];
    while (stack.length) {
      const n = stack.pop()!;
      const c = this.callOf(n);
      if (c) this.facts.calls.push({ from, ...c });
      for (const ch of named(n)) stack.push(ch);
    }
  }

  private callOf(n: SyntaxNodeLike): Omit<RawCall, 'from'> | null {
    switch (this.language) {
      case 'python': {
        if (n.type !== 'call') return null;
        return this.calleeName(field(n, 'function'));
      }
      case 'java': {
        if (n.type !== 'method_invocation' && n.type !== 'object_creation_expression') return null;
        if (n.type === 'object_creation_expression') { const t = field(n, 'type'); return t ? { name: t.text.replace(/<.*$/, '') } : null; }
        const name = field(n, 'name')?.text;
        if (!name) return null;
        const obj = field(n, 'object');
        return obj ? (obj.type === 'this' ? { name, self: true } : obj.type === 'identifier' ? { name, object: obj.text } : { name }) : { name, self: true };
      }
      default: {
        if (n.type === 'new_expression') { const c = field(n, 'constructor'); return c?.type === 'identifier' ? { name: c.text } : null; }
        if (n.type !== 'call_expression') return null;
        return this.calleeName(field(n, 'function'));
      }
    }
  }

  private calleeName(fn: SyntaxNodeLike | null): Omit<RawCall, 'from'> | null {
    if (!fn) return null;
    if (fn.type === 'identifier') return { name: fn.text };
    // a.b(), this.b(), self.b(), s.B(), Type::new()
    const obj = field(fn, 'object') ?? field(fn, 'operand') ?? field(fn, 'value') ?? field(fn, 'path');
    const prop = field(fn, 'property') ?? field(fn, 'attribute') ?? field(fn, 'field') ?? field(fn, 'name');
    if (!prop) return null;
    const name = prop.text;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    if (obj && (obj.type === 'this' || obj.text === 'self' || obj.text === 'this')) return { name, self: true };
    if (obj && /^(identifier|type_identifier)$/.test(obj.type)) return { name, object: obj.text };
    return { name };
  }
}

// ---- Languages ---------------------------------------------------------------------------------

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

function stringArg(args: SyntaxNodeLike | null, i = 0): string | null {
  const a = named(args).filter((x) => !/comment/.test(x.type))[i];
  if (!a || !/string|template_string|interpreted_string_literal|raw_string_literal/.test(a.type)) return null;
  const v = unquote(a.text);
  return v;
}

function extractJs(x: Extractor, root: SyntaxNodeLike) {
  const visit = (n: SyntaxNodeLike, cls: string | null, exported: boolean) => {
    switch (n.type) {
      case 'export_statement': {
        const decl = field(n, 'declaration');
        if (decl) visit(decl, cls, true);
        else for (const c of named(n)) visit(c, cls, true);
        return;
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = field(n, 'name')?.text;
        if (!name) break;
        const body = field(n, 'body');
        const s = x.add(n, { name, kind: 'function', signature: sigOf(x, n, body), exported, docNode: exportWrapper(n) });
        x.collectCalls(body, s.id);
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = field(n, 'name')?.text;
        if (!name) break;
        const body = field(n, 'body');
        const s = x.add(n, { name, kind: 'class', signature: sigOf(x, n, body), exported, docNode: exportWrapper(n) });
        for (const h of named(n).filter((c) => c.type === 'class_heritage')) {
          for (const clause of named(h)) {
            const kind = clause.type === 'implements_clause' ? 'implements' : 'extends';
            for (const t of named(clause)) {
              const tn = (t.type === 'generic_type' ? field(t, 'name') ?? t : t).text.replace(/<.*$/, '');
              if (/^[A-Za-z_$][\w$.]*$/.test(tn)) x.facts.heritage.push({ from: s.id, name: tn.split('.').pop()!, kind });
            }
          }
          // JavaScript: `class A extends B` has the expression directly under class_heritage.
          if (!named(h).some((c) => /clause/.test(c.type))) { const e = named(h)[0]; if (e?.type === 'identifier') x.facts.heritage.push({ from: s.id, name: e.text, kind: 'extends' }); }
        }
        for (const m of named(body)) visit(m, name, exported);
        return;
      }
      case 'method_definition':
      case 'abstract_method_signature': {
        if (!cls) break;
        const name = field(n, 'name')?.text;
        if (!name) break;
        const body = field(n, 'body');
        const s = x.add(n, { name, qualified: `${cls}.${name}`, kind: 'method', signature: sigOf(x, n, body), exported: exported && !name.startsWith('#') && !/^(private|protected)\b/.test(n.text) });
        x.collectCalls(body, s.id);
        return;
      }
      case 'interface_declaration': {
        const name = field(n, 'name')?.text;
        if (name) x.add(n, { name, kind: 'interface', signature: wholeText(n), exported, docNode: exportWrapper(n) });
        return;
      }
      case 'type_alias_declaration': {
        const name = field(n, 'name')?.text;
        if (name) x.add(n, { name, kind: 'type', signature: wholeText(n), exported, docNode: exportWrapper(n) });
        return;
      }
      case 'enum_declaration': {
        const name = field(n, 'name')?.text;
        if (name) x.add(n, { name, kind: 'enum', signature: wholeText(n), exported, docNode: exportWrapper(n) });
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        if (cls) break;
        const kw = /^(const|let|var)/.exec(n.text)?.[1] ?? 'const';
        for (const d of named(n).filter((c) => c.type === 'variable_declarator')) {
          const nameNode = field(d, 'name');
          if (nameNode?.type !== 'identifier') continue;
          const value = field(d, 'value');
          if (value && /^(arrow_function|function_expression|function|generator_function)$/.test(value.type)) {
            const body = field(value, 'body');
            const s = x.add(d, { name: nameNode.text, kind: 'function', signature: `${kw} ${sigOf(x, d, body)}`, exported, docNode: exportWrapper(n) });
            x.collectCalls(body, s.id);
          } else if (exported) {
            const type = field(d, 'type');
            x.add(d, { name: nameNode.text, kind: 'const', signature: `${kw} ${nameNode.text}${type ? type.text : ''}`, exported, docNode: exportWrapper(n) });
          } else if (value) {
            // Module-level code still calls things (route tables, wiring).
            routesIn(x, value);
          }
        }
        return;
      }
      case 'import_statement': {
        const source = field(n, 'source');
        if (!source) return;
        const names = new Map<string, string>();
        for (const clause of named(n).filter((c) => c.type === 'import_clause')) {
          for (const c of named(clause)) {
            if (c.type === 'identifier') names.set(c.text, 'default');
            else if (c.type === 'namespace_import') { const id = named(c).find((k) => k.type === 'identifier'); if (id) names.set(id.text, '*'); }
            else if (c.type === 'named_imports') {
              for (const sp of named(c).filter((k) => k.type === 'import_specifier')) {
                const nm = field(sp, 'name')?.text;
                const alias = field(sp, 'alias')?.text;
                if (nm) names.set(alias ?? nm, nm);
              }
            }
          }
        }
        x.facts.imports.push({ spec: unquote(source.text), names });
        return;
      }
      case 'expression_statement': {
        routesIn(x, n);
        return;
      }
    }
    for (const c of named(n)) visit(c, cls, exported);
  };
  visit(root, null, false);
}

/** Express/Koa/Fastify/Hono style `app.get('/path', handler)` anywhere inside `n`. */
function routesIn(x: Extractor, n: SyntaxNodeLike) {
  const stack = [n];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.type === 'call_expression') {
      const fn = field(c, 'function');
      const prop = fn?.type === 'member_expression' ? field(fn, 'property')?.text : null;
      const args = field(c, 'arguments');
      const path = stringArg(args);
      if (prop && HTTP_METHODS.has(prop.toLowerCase()) && path?.startsWith('/')) {
        const method = prop.toUpperCase() === 'ALL' ? 'ANY' : prop.toUpperCase();
        const route = x.add(c, { name: `${method} ${path}`, kind: 'route', signature: `${method} ${path}`, route: { method, path } });
        const handler = named(args).filter((a) => !/comment/.test(a.type)).slice(1).reverse().find((a) => a.type === 'identifier' || a.type === 'member_expression');
        if (handler) x.facts.handlers.push({ route: route.id, name: handler.text.split('.').pop()! });
        else x.collectCalls(args, route.id);
      }
    }
    for (const k of named(c)) stack.push(k);
  }
}

const exportWrapper = (n: SyntaxNodeLike) => (n.parent?.type === 'export_statement' ? n.parent : n.parent?.parent?.type === 'export_statement' ? n.parent.parent : n);
const wholeText = (n: SyntaxNodeLike) => clip(n.text.replace(/\s+/g, ' ').trim(), 600);
const sigOf = (x: Extractor, n: SyntaxNodeLike, body: SyntaxNodeLike | null) => x.signature(n, body);

function extractPython(x: Extractor, root: SyntaxNodeLike) {
  const visit = (n: SyntaxNodeLike, cls: string | null, decorators: SyntaxNodeLike[]) => {
    switch (n.type) {
      case 'decorated_definition': {
        const def = field(n, 'definition');
        if (def) visit(def, cls, named(n).filter((c) => c.type === 'decorator'));
        return;
      }
      case 'function_definition': {
        const name = field(n, 'name')?.text;
        if (!name) break;
        const body = field(n, 'body');
        const s = x.add(n, { name, qualified: cls ? `${cls}.${name}` : name, kind: cls ? 'method' : 'function', signature: sigOf(x, n, body), exported: !name.startsWith('_') || /^__\w+__$/.test(name), docNode: n.parent?.type === 'decorated_definition' ? n.parent : n });
        x.collectCalls(body, s.id);
        for (const d of decorators) pythonRoute(x, d, s);
        return;
      }
      case 'class_definition': {
        const name = field(n, 'name')?.text;
        if (!name) break;
        const body = field(n, 'body');
        const s = x.add(n, { name, kind: 'class', signature: sigOf(x, n, body), exported: !name.startsWith('_') });
        for (const sup of named(field(n, 'superclasses'))) if (/^(identifier|attribute)$/.test(sup.type)) x.facts.heritage.push({ from: s.id, name: sup.text.split('.').pop()!, kind: 'extends' });
        for (const c of named(body)) visit(c, cls ? `${cls}.${name}` : name, []);
        return;
      }
      case 'import_statement': {
        for (const c of named(n)) {
          const mod = c.type === 'aliased_import' ? field(c, 'name')?.text : c.text;
          const alias = c.type === 'aliased_import' ? field(c, 'alias')?.text : undefined;
          if (mod) x.facts.imports.push({ spec: mod, names: new Map([[alias ?? mod.split('.')[0]!, '*']]) });
        }
        return;
      }
      case 'import_from_statement': {
        const mod = field(n, 'module_name')?.text;
        if (!mod) return;
        const names = new Map<string, string>();
        for (const c of named(n).slice(1)) {
          if (c.type === 'dotted_name') names.set(c.text, c.text);
          else if (c.type === 'aliased_import') { const nm = field(c, 'name')?.text; const al = field(c, 'alias')?.text; if (nm) names.set(al ?? nm, nm); }
        }
        x.facts.imports.push({ spec: mod, names });
        return;
      }
      case 'expression_statement': {
        // Module-level assignments: exported constants (UPPER_CASE by convention).
        const a = named(n)[0];
        if (!cls && a?.type === 'assignment') {
          const left = field(a, 'left');
          if (left?.type === 'identifier' && /^[A-Z][A-Z0-9_]+$/.test(left.text)) {
            const type = field(a, 'type');
            x.add(n, { name: left.text, kind: 'const', signature: `${left.text}${type ? `: ${type.text}` : ''}`, exported: true });
          }
        }
        return;
      }
    }
    for (const c of named(n)) visit(c, cls, []);
  };
  visit(root, null, []);
}

/** Flask/FastAPI/Starlette style `@app.get("/x")`, `@bp.route("/x", methods=["POST"])`. */
function pythonRoute(x: Extractor, dec: SyntaxNodeLike, handler: CodeSymbol) {
  const call = named(dec)[0];
  if (call?.type !== 'call') return;
  const fn = field(call, 'function');
  const attr = fn?.type === 'attribute' ? field(fn, 'attribute')?.text : null;
  if (!attr) return;
  const args = field(call, 'arguments');
  const path = stringArg(args);
  if (!path?.startsWith('/')) return;
  let methods: string[] = [];
  if (HTTP_METHODS.has(attr.toLowerCase())) methods = [attr.toUpperCase()];
  else if (attr === 'route' || attr === 'api_route') {
    const kw = named(args).find((a) => a.type === 'keyword_argument' && field(a, 'name')?.text === 'methods');
    const list = kw ? field(kw, 'value') : null;
    methods = list ? named(list).map((s) => unquote(s.text).toUpperCase()).filter(Boolean) : ['GET'];
  } else return;
  for (const method of methods) {
    const r = x.add(dec, { name: `${method} ${path}`, kind: 'route', signature: `${method} ${path}`, route: { method, path } });
    x.facts.handlers.push({ route: r.id, name: handler.qualified });
  }
}

function extractGo(x: Extractor, root: SyntaxNodeLike) {
  const exportedName = (s: string) => /^[A-Z]/.test(s);
  for (const n of named(root)) {
    switch (n.type) {
      case 'function_declaration': {
        const name = field(n, 'name')?.text;
        if (!name) break;
        const body = field(n, 'body');
        const s = x.add(n, { name, kind: 'function', signature: sigOf(x, n, body), exported: exportedName(name) });
        x.collectCalls(body, s.id);
        goRoutes(x, body);
        break;
      }
      case 'method_declaration': {
        const name = field(n, 'name')?.text;
        if (!name) break;
        const recv = field(n, 'receiver');
        const type = recv?.text.match(/\*?\s*([A-Za-z_]\w*)\s*(\[.*\])?\s*\)$/)?.[1] ?? 'recv';
        const body = field(n, 'body');
        const s = x.add(n, { name, qualified: `${type}.${name}`, kind: 'method', signature: sigOf(x, n, body), exported: exportedName(name) });
        x.collectCalls(body, s.id);
        goRoutes(x, body);
        break;
      }
      case 'type_declaration': {
        for (const spec of named(n).filter((c) => c.type === 'type_spec' || c.type === 'type_alias')) {
          const name = field(spec, 'name')?.text;
          const t = field(spec, 'type');
          if (!name) continue;
          const kind: CodeSymbolKind = t?.type === 'struct_type' ? 'struct' : t?.type === 'interface_type' ? 'interface' : 'type';
          x.add(spec, { name, kind, signature: `type ${wholeText(spec)}`, exported: exportedName(name), docNode: n });
        }
        break;
      }
      case 'import_declaration': {
        const specs: SyntaxNodeLike[] = [];
        const st = [n];
        while (st.length) { const c = st.pop()!; if (c.type === 'import_spec') specs.push(c); else st.push(...named(c)); }
        for (const sp of specs) {
          const p = field(sp, 'path');
          if (!p) continue;
          const spec = unquote(p.text);
          const alias = field(sp, 'name')?.text;
          x.facts.imports.push({ spec, names: new Map([[alias ?? spec.split('/').pop()!, '*']]) });
        }
        break;
      }
      case 'const_declaration':
      case 'var_declaration': {
        for (const spec of named(n).filter((c) => /_spec$/.test(c.type))) {
          for (const id of named(spec).filter((c) => c.type === 'identifier')) {
            if (!exportedName(id.text)) continue;
            const t = field(spec, 'type');
            x.add(spec, { name: id.text, kind: 'const', signature: `${n.type === 'const_declaration' ? 'const' : 'var'} ${id.text}${t ? ` ${t.text}` : ''}`, exported: true, docNode: n });
          }
        }
        break;
      }
    }
  }
}

/** net/http, chi, gin, echo: `mux.HandleFunc("/x", h)`, `r.GET("/x", h)`, Go 1.22 `"GET /x"`. */
function goRoutes(x: Extractor, body: SyntaxNodeLike | null) {
  if (!body) return;
  const stack = [body];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.type === 'call_expression') {
      const fn = field(c, 'function');
      const f = fn?.type === 'selector_expression' ? field(fn, 'field')?.text : null;
      const args = field(c, 'arguments');
      const pat = stringArg(args);
      if (f && pat && /^(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any)$/.test(f)) {
        const m = /^([A-Z]+)\s+(\/.*)$/.exec(pat);
        const method = m ? m[1]! : /^Handle/.test(f) || f === 'Any' ? 'ANY' : f.toUpperCase();
        const path = m ? m[2]! : pat;
        if (path.startsWith('/')) {
          const r = x.add(c, { name: `${method} ${path}`, kind: 'route', signature: `${method} ${path}`, route: { method, path } });
          const h = named(args)[1];
          if (h && /identifier|selector_expression/.test(h.type)) x.facts.handlers.push({ route: r.id, name: h.text.split('.').pop()! });
        }
      }
    }
    for (const k of named(c)) stack.push(k);
  }
}

function extractRust(x: Extractor, root: SyntaxNodeLike) {
  const isPub = (n: SyntaxNodeLike) => named(n).some((c) => c.type === 'visibility_modifier');
  const attrsBefore = (n: SyntaxNodeLike) => {
    const out: SyntaxNodeLike[] = [];
    let p = n.previousNamedSibling;
    while (p && p.type === 'attribute_item') { out.push(p); p = p.previousNamedSibling; }
    return out;
  };
  const visit = (n: SyntaxNodeLike, owner: string | null) => {
    switch (n.type) {
      case 'function_item':
      case 'function_signature_item': {
        const name = field(n, 'name')?.text;
        if (!name) return;
        const body = field(n, 'body');
        const s = x.add(n, { name, qualified: owner ? `${owner}.${name}` : name, kind: owner ? 'method' : 'function', signature: sigOf(x, n, body), exported: isPub(n) });
        x.collectCalls(body, s.id);
        // actix-web: #[get("/x")]
        for (const a of attrsBefore(n)) {
          const m = /^#\[\s*(get|post|put|patch|delete|head)\s*\(\s*"([^"]+)"/.exec(a.text);
          if (m) {
            const method = m[1]!.toUpperCase();
            const r = x.add(a, { name: `${method} ${m[2]}`, kind: 'route', signature: `${method} ${m[2]}`, route: { method, path: m[2]! } });
            x.facts.handlers.push({ route: r.id, name: s.qualified });
          }
        }
        rustRoutes(x, body);
        return;
      }
      case 'struct_item':
      case 'enum_item':
      case 'trait_item':
      case 'type_item':
      case 'union_item': {
        const name = field(n, 'name')?.text;
        if (!name) return;
        const kind: CodeSymbolKind = n.type === 'struct_item' || n.type === 'union_item' ? 'struct' : n.type === 'enum_item' ? 'enum' : n.type === 'trait_item' ? 'trait' : 'type';
        const body = field(n, 'body');
        x.add(n, { name, kind, signature: n.type === 'trait_item' ? sigOf(x, n, body) : wholeText(n), exported: isPub(n) });
        if (n.type === 'trait_item') for (const c of named(body)) visit(c, name);
        return;
      }
      case 'impl_item': {
        const type = field(n, 'type')?.text.replace(/<.*$/, '');
        const trait = field(n, 'trait')?.text.replace(/<.*$/, '');
        if (!type) return;
        if (trait) {
          const target = x.facts.symbols.find((s) => s.qualified === type);
          if (target) x.facts.heritage.push({ from: target.id, name: trait.split('::').pop()!, kind: 'implements' });
        }
        for (const c of named(field(n, 'body'))) visit(c, type);
        return;
      }
      case 'mod_item': {
        for (const c of named(field(n, 'body'))) visit(c, owner);
        return;
      }
      case 'use_declaration': {
        const arg = field(n, 'argument');
        if (arg) x.facts.imports.push({ spec: arg.text.replace(/::\{.*$/s, '').replace(/::\*$/, ''), names: new Map() });
        return;
      }
      case 'const_item':
      case 'static_item': {
        const name = field(n, 'name')?.text;
        const t = field(n, 'type');
        if (name && isPub(n)) x.add(n, { name, kind: 'const', signature: `${n.type === 'const_item' ? 'const' : 'static'} ${name}: ${t?.text ?? ''}`.trim(), exported: true });
        return;
      }
    }
    for (const c of named(n)) visit(c, owner);
  };
  visit(root, null);
}

/** axum: `.route("/x", get(handler).post(other))`. */
function rustRoutes(x: Extractor, body: SyntaxNodeLike | null) {
  if (!body) return;
  const stack = [body];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.type === 'call_expression') {
      const fn = field(c, 'function');
      const f = fn?.type === 'field_expression' ? field(fn, 'field')?.text : null;
      const args = field(c, 'arguments');
      const path = stringArg(args);
      if (f === 'route' && path?.startsWith('/')) {
        const handlerExpr = named(args)[1];
        const found = handlerExpr ? [...handlerExpr.text.matchAll(/\b(get|post|put|patch|delete|any)\s*\(\s*([A-Za-z_][\w:]*)\s*\)/g)] : [];
        for (const m of found.length ? found : [null]) {
          const method = m ? (m[1] === 'any' ? 'ANY' : m[1]!.toUpperCase()) : 'ANY';
          const r = x.add(c, { name: `${method} ${path}`, kind: 'route', signature: `${method} ${path}`, route: { method, path } });
          if (m) x.facts.handlers.push({ route: r.id, name: m[2]!.split('::').pop()! });
        }
      }
    }
    for (const k of named(c)) stack.push(k);
  }
}

function extractJava(x: Extractor, root: SyntaxNodeLike) {
  const mods = (n: SyntaxNodeLike) => named(n).find((c) => c.type === 'modifiers');
  const isPublic = (n: SyntaxNodeLike) => /\bpublic\b/.test(mods(n)?.text ?? '');
  const mapping = (n: SyntaxNodeLike): { method: string; path: string }[] => {
    const out: { method: string; path: string }[] = [];
    for (const a of named(mods(n)).filter((c) => /annotation/.test(c.type))) {
      const name = field(a, 'name')?.text ?? '';
      const m = /^(Get|Post|Put|Patch|Delete|Request)Mapping$/.exec(name);
      if (!m) continue;
      const args = field(a, 'arguments');
      const text = args?.text ?? '';
      const path = /"([^"]*)"/.exec(text)?.[1] ?? '';
      const method = m[1] === 'Request' ? (/RequestMethod\.([A-Z]+)/.exec(text)?.[1] ?? 'ANY') : m[1]!.toUpperCase();
      out.push({ method, path });
    }
    return out;
  };
  const visit = (n: SyntaxNodeLike, cls: string | null, prefix: string) => {
    switch (n.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        const name = field(n, 'name')?.text;
        if (!name) break;
        const q = cls ? `${cls}.${name}` : name;
        const body = field(n, 'body');
        const kind: CodeSymbolKind = n.type === 'interface_declaration' ? 'interface' : n.type === 'enum_declaration' ? 'enum' : 'class';
        const s = x.add(n, { name, qualified: q, kind, signature: sigOf(x, n, body), exported: isPublic(n) });
        const sup = field(n, 'superclass');
        if (sup) for (const t of named(sup)) x.facts.heritage.push({ from: s.id, name: t.text.replace(/<.*$/, '').split('.').pop()!, kind: 'extends' });
        const ifs = field(n, 'interfaces');
        if (ifs) for (const t of ifs.text.replace(/^implements\s+/, '').split(',')) { const tn = t.trim().replace(/<.*$/, '').split('.').pop(); if (tn) x.facts.heritage.push({ from: s.id, name: tn, kind: 'implements' }); }
        const base = mapping(n)[0]?.path ?? '';
        for (const c of named(body)) visit(c, q, prefix + base);
        return;
      }
      case 'method_declaration':
      case 'constructor_declaration': {
        if (!cls) break;
        const name = field(n, 'name')?.text;
        if (!name) break;
        const body = field(n, 'body');
        const s = x.add(n, { name, qualified: `${cls}.${name}`, kind: 'method', signature: sigOf(x, n, body), exported: isPublic(n) });
        x.collectCalls(body, s.id);
        for (const r of mapping(n)) {
          const path = `${prefix}${r.path}`.replace(/\/{2,}/g, '/') || '/';
          const route = x.add(n, { name: `${r.method} ${path}`, kind: 'route', signature: `${r.method} ${path}`, route: { method: r.method, path } });
          x.facts.handlers.push({ route: route.id, name: s.qualified });
        }
        return;
      }
      case 'import_declaration': {
        const id = named(n).find((c) => /identifier/.test(c.type));
        if (id) x.facts.imports.push({ spec: id.text, names: new Map([[id.text.split('.').pop()!, id.text.split('.').pop()!]]) });
        return;
      }
    }
    for (const c of named(n)) visit(c, cls, prefix);
  };
  visit(root, null, '');
}

const EXTRACT: Record<CodeLanguage, (x: Extractor, root: SyntaxNodeLike) => void> = {
  typescript: extractJs, tsx: extractJs, javascript: extractJs,
  python: extractPython, go: extractGo, rust: extractRust, java: extractJava,
};

/** Symbols, calls and imports of one parsed file (exported for tests). */
export function extractFile(path: string, language: CodeLanguage, text: string, root: SyntaxNodeLike): FileFacts {
  const x = new Extractor(path, language, text);
  EXTRACT[language](x, root);
  return x.facts;
}

// ---- Resolution --------------------------------------------------------------------------------

/** Languages that can call each other's code. */
const FAMILY: Record<CodeLanguage, string> = { typescript: 'js', tsx: 'js', javascript: 'js', python: 'py', go: 'go', rust: 'rs', java: 'java' };

const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

function joinPath(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Where an import points: a repository file (or Go package folder), else `module:<spec>`. */
export function resolveImport(from: string, language: CodeLanguage, spec: string, files: ReadonlySet<string>, ctx: { goModule?: string } = {}): string {
  const has = (p: string) => files.has(p);
  switch (language) {
    case 'python': {
      const lead = /^\.+/.exec(spec)?.[0].length ?? 0;
      const rest = spec.slice(lead).replace(/\./g, '/');
      let base = lead ? dirOf(from) : '';
      for (let i = 1; i < lead; i++) base = dirOf(base);
      const roots = lead ? [base] : ['', 'src', dirOf(from)];
      for (const r of roots) {
        const p = joinPath(r, rest);
        if (has(`${p}.py`)) return `${p}.py`;
        if (has(`${p}/__init__.py`)) return `${p}/__init__.py`;
      }
      return `module:${spec}`;
    }
    case 'go': {
      if (ctx.goModule && spec.startsWith(`${ctx.goModule}/`)) {
        const dir = spec.slice(ctx.goModule.length + 1);
        if ([...files].some((f) => dirOf(f) === dir)) return dir;
      }
      return `module:${spec}`;
    }
    case 'rust': {
      const m = /^(crate|super|self)::(.+)$/.exec(spec);
      if (!m) return `module:${spec.split('::')[0]}`;
      const segs = m[2]!.split('::');
      const base = m[1] === 'crate' ? (has('src/lib.rs') || has('src/main.rs') ? 'src' : '') : m[1] === 'super' ? dirOf(dirOf(from)) : dirOf(from);
      for (let i = segs.length; i > 0; i--) {
        const p = joinPath(base, segs.slice(0, i).join('/'));
        if (has(`${p}.rs`)) return `${p}.rs`;
        if (has(`${p}/mod.rs`)) return `${p}/mod.rs`;
      }
      return `module:${spec}`;
    }
    case 'java': {
      const tail = `${spec.replace(/\./g, '/')}.java`;
      const hit = [...files].find((f) => f === tail || f.endsWith(`/${tail}`));
      return hit ?? `module:${spec}`;
    }
    default: {
      if (!spec.startsWith('.') && !spec.startsWith('/')) return `module:${spec}`;
      const p = joinPath(dirOf(from), spec);
      for (const e of JS_EXT) if (has(p + e)) return p + e;
      // `./x.js` written for ESM output while the source is `./x.ts`.
      const stem = p.replace(/\.(m|c)?js$/, '');
      for (const e of ['.ts', '.tsx', '.mts']) if (has(stem + e)) return stem + e;
      return `module:${spec}`;
    }
  }
}

function resolveEdges(all: FileFacts[], files: ReadonlySet<string>, goModule?: string): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const seen = new Set<string>();
  const push = (e: CodeEdge) => {
    const k = `${e.from}\u0000${e.to}\u0000${e.kind}`;
    if (seen.has(k) || e.from === e.to) return;
    seen.add(k);
    edges.push(e);
  };
  const byName = new Map<string, CodeSymbol[]>();
  const byFile = new Map<string, CodeSymbol[]>();
  const langOf = new Map(all.map((f) => [f.file, f.language]));
  for (const f of all) {
    byFile.set(f.file, f.symbols);
    for (const s of f.symbols) {
      if (s.kind === 'route') continue;
      for (const key of new Set([s.name, s.qualified])) (byName.get(key) ?? byName.set(key, []).get(key)!).push(s);
    }
  }
  const ownerClass = (s: CodeSymbol | undefined) => (s && s.kind === 'method' ? s.qualified.slice(0, s.qualified.lastIndexOf('.')) : null);

  for (const f of all) {
    const local = byFile.get(f.file) ?? [];
    const symById = new Map(local.map((s) => [s.id, s]));
    // Containment: classes contain their methods.
    for (const s of local) {
      const cls = ownerClass(s);
      const owner = cls ? local.find((o) => o.qualified === cls) : null;
      if (owner) push({ from: owner.id, to: s.id, kind: 'contains', confidence: 'extracted' });
    }
    // Imports: file → file / package / module, plus the names they bring in.
    const importedNames = new Map<string, { file: string; name: string }>();
    const importedFiles = new Set<string>();
    const importedModules = new Map<string, string>();
    for (const im of f.imports) {
      const to = resolveImport(f.file, f.language, im.spec, files, { goModule });
      push({ from: f.file, to, kind: 'imports', confidence: 'extracted' });
      if (to.startsWith('module:')) continue;
      importedFiles.add(to);
      for (const [local, exported] of im.names) {
        if (exported === '*') importedModules.set(local, to);
        else importedNames.set(local, { file: to, name: exported });
      }
    }
    const lookup = (name: string, fromSym: CodeSymbol | undefined, call?: RawCall, methodOk = false): { s: CodeSymbol; c: EdgeConfidence } | null => {
      if (call?.self) {
        const cls = ownerClass(fromSym);
        const m = cls ? local.find((s) => s.qualified === `${cls}.${name}`) : null;
        if (m) return { s: m, c: 'extracted' };
      }
      if (call?.object) {
        const mod = importedModules.get(call.object);
        if (mod) {
          const hit = (byFile.get(mod) ?? []).find((s) => s.name === name && s.kind !== 'method') ?? all.filter((x) => dirOf(x.file) === mod).flatMap((x) => x.symbols).find((s) => s.name === name);
          if (hit) return { s: hit, c: 'extracted' };
        }
        // `Type.method()` / `Type::new()` on a class or struct the repo defines.
        const owner = byName.get(`${call.object}.${name}`);
        if (owner?.length === 1) return { s: owner[0]!, c: 'extracted' };
      }
      const same = local.filter((s) => s.name === name && s.kind !== 'route' && (s.kind !== 'method' || !call?.object));
      if (same.length === 1) return { s: same[0]!, c: 'extracted' };
      const imp = importedNames.get(name);
      if (imp) {
        const target = (byFile.get(imp.file) ?? []).find((s) => s.name === imp.name && s.kind !== 'method');
        if (target) return { s: target, c: 'extracted' };
      }
      // Only code in the same language can be called; prefer what this file imports or sits next to.
      const family = (byName.get(name) ?? []).filter((s) => FAMILY[langOf.get(s.file)!] === FAMILY[f.language]);
      const pick = (xs: CodeSymbol[]) => {
        if (xs.length === 1) return xs[0]!;
        const near = xs.filter((s) => importedFiles.has(s.file) || importedFiles.has(dirOf(s.file)) || dirOf(s.file) === dirOf(f.file));
        return near.length === 1 ? near[0]! : null;
      };
      if (call?.object || call?.self || methodOk) {
        // A method on some object: only a unique (or uniquely near) method of that name is a fair guess.
        const m = pick(family.filter((s) => s.kind === 'method'));
        if (m) return { s: m, c: 'inferred' };
        if (!methodOk) return null;
      }
      const g = pick(family.filter((s) => s.kind !== 'method'));
      return g ? { s: g, c: 'inferred' } : null;
    };
    for (const c of f.calls) {
      const hit = lookup(c.name, symById.get(c.from), c);
      if (hit) push({ from: c.from, to: hit.s.id, kind: 'calls', confidence: hit.c });
    }
    for (const h of f.handlers) {
      const hit = local.find((s) => s.qualified === h.name) ?? lookup(h.name, undefined, undefined, true)?.s;
      if (hit) push({ from: h.route, to: hit.id, kind: 'handles', confidence: 'extracted' });
    }
    for (const h of f.heritage) {
      const hit = lookup(h.name, undefined);
      if (hit && hit.s.kind !== 'function') push({ from: h.from, to: hit.s.id, kind: h.kind, confidence: hit.c });
    }
  }
  return edges;
}

// ---- The scan ----------------------------------------------------------------------------------

export interface ScanProgress {
  done: number;
  total: number;
  file?: string;
}

/**
 * Scans a repository's files into a graph. Files are parsed in path order and everything is
 * sorted, so the same repository always produces byte-identical JSON (stable sync, clean diffs).
 */
export async function scanRepository(
  input: readonly RepoFile[],
  parser: CodeParser,
  o: { sourceId: string; name: string; now?: number; limits?: ScanLimits; onProgress?: (p: ScanProgress) => void; generator?: string } ,
): Promise<CodeGraph> {
  const maxFiles = o.limits?.maxFiles ?? 4000;
  const maxBytes = o.limits?.maxFileBytes ?? 512 * 1024;
  const dec = new TextDecoder('utf-8', { fatal: false });
  const sorted = [...input].filter((f) => !ignoredPath(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: CodeFile[] = [];
  const facts: FileFacts[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  const goMod = sorted.find((f) => f.path === 'go.mod');
  const goModule = goMod ? /^module\s+(\S+)/m.exec(dec.decode(goMod.bytes))?.[1] : undefined;
  const code = sorted.filter((f) => languageOf(f.path));
  const failed = new Set<CodeLanguage>();
  let done = 0;
  for (const f of code) {
    const language = languageOf(f.path)!;
    if (files.length >= maxFiles || f.bytes.length > maxBytes || f.bytes.includes(0)) { skipped++; continue; }
    const text = dec.decode(f.bytes);
    files.push({ path: f.path, language, hash: contentHash(f.bytes), size: f.bytes.length });
    o.onProgress?.({ done: done++, total: code.length, file: f.path });
    if (failed.has(language)) continue;
    let root: SyntaxNodeLike | null;
    try {
      root = await parser.parse(language, text);
    } catch (e) {
      root = null;
      warnings.push(`${f.path}: ${(e as Error).message}`);
    }
    if (!root) {
      failed.add(language);
      warnings.push(`No ${language} grammar available; ${language} files are listed without symbols.`);
      continue;
    }
    try {
      facts.push(extractFile(f.path, language, text, root));
    } catch (e) {
      warnings.push(`${f.path}: ${(e as Error).message}`);
    } finally {
      root.tree?.delete?.();
    }
  }
  o.onProgress?.({ done: code.length, total: code.length });
  const paths = new Set(files.map((f) => f.path));
  const edges = resolveEdges(facts, paths, goModule);
  const symbols = facts.flatMap((f) => f.symbols).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.id.localeCompare(b.id)));
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
  const graph: CodeGraph = {
    formatVersion: CODE_GRAPH_VERSION,
    sourceId: o.sourceId,
    name: o.name,
    scannedAt: o.now ?? Date.now(),
    generator: o.generator ?? 'inkstone-tree-sitter/1',
    files,
    symbols,
    edges,
  };
  if (skipped) graph.skipped = skipped;
  if (warnings.length) graph.warnings = warnings.slice(0, 50);
  return graph;
}
