/**
 * Importing code graphs made by other tools, so notes can link to them and drift works the same.
 *
 * - **graphify** (`graphify-out/graph.json`): NetworkX node-link JSON — `{directed, multigraph,
 *   graph: {schema_version?, graphify_version?}, nodes: [{id, label, source_file, source_location:
 *   "L42", …}], links: [{source, target, relation, confidence: EXTRACTED|INFERRED|AMBIGUOUS}]}`.
 *   graph.json is written undirected but every link is directed by its order; older files carry
 *   `_src`/`_tgt`, which win (graphify's ARCHITECTURE.md).
 * - **Generic nodes/edges JSON** — for GitNexus (which documents its graph schema but no export
 *   file: export a Cypher query's rows) and anything else:
 *   `{nodes: [{id, name|label, kind|type|label, file|filePath|path|source_file, line|startLine,
 *   endLine?, signature?}], edges|links|relationships: [{from|source, to|target, kind|type|relation}]}`.
 *
 * Imported symbols have no source text; their hash is over the signature when given, else over
 * `kind name file` — so drift reports a symbol that disappeared or changed kind, not edits inside it.
 */
import { CODE_GRAPH_VERSION, signatureHash, symbolId, type CodeEdge, type CodeEdgeKind, type CodeGraph, type CodeSymbol, type CodeSymbolKind, type EdgeConfidence } from './codegraph.ts';
import { languageOf } from './codescan.ts';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** A node id as written: string or number (Neo4j/Kùzu rows use numbers). */
const ref = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : s(v));
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

// Maps, not object literals: names like "constructor" must not hit Object.prototype.
const KIND_ALIASES = new Map<string, CodeSymbolKind>([
  ['function', 'function'], ['func', 'function'], ['fn', 'function'], ['method', 'method'], ['constructor', 'method'],
  ['class', 'class'], ['interface', 'interface'], ['type', 'type'], ['typealias', 'type'], ['typedef', 'type'],
  ['enum', 'enum'], ['const', 'const'], ['constant', 'const'], ['variable', 'const'], ['var', 'const'],
  ['struct', 'struct'], ['trait', 'trait'], ['impl', 'class'], ['route', 'route'], ['endpoint', 'route'], ['module', 'module'], ['package', 'module'], ['namespace', 'module'],
]);
const EDGE_ALIASES = new Map<string, CodeEdgeKind>([
  ['calls', 'calls'], ['call', 'calls'], ['imports', 'imports'], ['import', 'imports'], ['uses', 'references'], ['references', 'references'],
  ['contains', 'contains'], ['defines', 'contains'], ['member_of', 'contains'], ['method', 'contains'], ['has_method', 'contains'],
  ['extends', 'extends'], ['inherits', 'extends'], ['implements', 'implements'], ['handles', 'handles'],
]);

export type GraphImportFormat = 'graphify' | 'generic';

/** Which format a JSON document is (null: neither). */
export function detectGraphFormat(doc: unknown): GraphImportFormat | null {
  if (!isObj(doc) || !Array.isArray(doc.nodes)) return null;
  if (Array.isArray(doc.links) && (isObj(doc.graph) || 'directed' in doc || 'multigraph' in doc)) return 'graphify';
  if (Array.isArray(doc.edges) || Array.isArray(doc.links) || Array.isArray(doc.relationships)) return 'generic';
  return 'generic';
}

/** Turns a graphify or generic nodes/edges document into a `CodeGraph`. Throws with a plain message on anything else. */
export function importCodeGraph(doc: unknown, o: { sourceId: string; name: string; now?: number }): CodeGraph {
  const format = detectGraphFormat(doc);
  if (!format || !isObj(doc)) throw new Error('Not a code graph: expected a JSON object with a "nodes" array (graphify graph.json or {nodes, edges}).');
  const rawNodes = (doc.nodes as unknown[]).filter(isObj);
  const rawEdges = ((format === 'graphify' ? doc.links : doc.edges ?? doc.links ?? doc.relationships) as unknown[] | undefined ?? []).filter(isObj);

  // Node → symbol. Nodes without a file are concepts/communities, not code: kept out of symbols.
  const idMap = new Map<string, string>();
  const symbols: CodeSymbol[] = [];
  const files = new Map<string, number>();
  const taken = new Set<string>();
  for (const nd of rawNodes) {
    const rawId = ref(nd.id);
    const props = isObj(nd.properties) ? { ...nd.properties, ...nd } : nd;
    const file = s(props.source_file) ?? s(props.file) ?? s(props.filePath) ?? s(props.path);
    if (!rawId || !file) continue;
    const path = file.replace(/\\/g, '/').replace(/^\.?\//, '');
    const labelKind = Array.isArray(props.labels) ? s(props.labels[0]) : undefined;
    const kindRaw = (s(props.kind) ?? s(props.type) ?? s(props.file_type) ?? labelKind ?? (format === 'graphify' ? undefined : s(props.label)) ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const kind: CodeSymbolKind = KIND_ALIASES.get(kindRaw) ?? (kindRaw === 'file' ? 'module' : 'function');
    const name = s(props.name) ?? s(props.label) ?? rawId.split(/[.:#/]/).pop() ?? rawId;
    const line = n(props.line) ?? n(props.startLine) ?? n(props.start_line) ?? n(/^L(\d+)/.exec(s(props.source_location) ?? '')?.[1]) ?? 1;
    const endLine = n(props.endLine) ?? n(props.end_line) ?? line;
    files.set(path, (files.get(path) ?? 0) + 1);
    if (kind === 'module' && name.replace(/\\/g, '/') === path.split('/').pop()) { idMap.set(rawId, path); continue; }
    let qualified = s(props.qualified) ?? s(props.qualifiedName) ?? name;
    let id = symbolId(path, qualified);
    for (let k = 2; taken.has(id); k++) { qualified = `${name}~${k}`; id = symbolId(path, qualified); }
    taken.add(id);
    idMap.set(rawId, id);
    const signature = s(props.signature) ?? `${kind} ${name}`;
    const sym: CodeSymbol = { id, name, qualified, kind, file: path, line, endLine, signature, hash: signatureHash(s(props.signature) ?? `${kind} ${name} ${path}`) };
    const doc = s(props.docstring) ?? s(props.doc) ?? s(props.description);
    if (doc) sym.doc = doc.split('\n')[0]!.slice(0, 200);
    if (props.exported === true || props.isExported === true) sym.exported = true;
    symbols.push(sym);
  }

  const edges: CodeEdge[] = [];
  const seen = new Set<string>();
  for (const e of rawEdges) {
    const a = ref(e._src) ?? ref(e.source) ?? ref(e.from) ?? ref(e.startNode);
    const b = ref(e._tgt) ?? ref(e.target) ?? ref(e.to) ?? ref(e.endNode);
    const from = a ? idMap.get(a) : undefined;
    const to = b ? idMap.get(b) : undefined;
    if (!from || !to || from === to) continue;
    const props = isObj(e.properties) ? { ...e.properties, ...e } : e;
    const kind = EDGE_ALIASES.get((s(props.relation) ?? s(props.kind) ?? s(props.type) ?? s(props.label) ?? 'references').toLowerCase()) ?? 'references';
    const c = (s(props.confidence) ?? '').toLowerCase();
    const confidence: EdgeConfidence | undefined = c === 'extracted' || c === 'inferred' || c === 'ambiguous' ? c : undefined;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, kind, ...(confidence ? { confidence } : {}) });
  }

  symbols.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line || x.id.localeCompare(y.id));
  edges.sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to) || x.kind.localeCompare(y.kind));
  const graph: CodeGraph = {
    formatVersion: CODE_GRAPH_VERSION,
    sourceId: o.sourceId,
    name: o.name,
    scannedAt: o.now ?? Date.now(),
    generator: format === 'graphify' ? `graphify${isObj(doc.graph) && s(doc.graph.graphify_version) ? `/${s(doc.graph.graphify_version)}` : ''}` : 'generic-json',
    files: [...files.keys()].sort().map((path) => ({ path, language: languageOf(path) ?? 'other', hash: '', size: 0 })),
    symbols,
    edges,
  };
  const skipped = rawNodes.length - symbols.length - [...idMap.values()].filter((v) => !v.includes('#')).length;
  if (skipped > 0) graph.warnings = [`${skipped} nodes without a source file (concepts, communities) were left out.`];
  return graph;
}
