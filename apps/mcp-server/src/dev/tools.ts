/**
 * MCP tools of the developer module (docs/DEVELOPERS.md): the code graph, drift, runbooks and
 * diagram validation. All read-only: they never change the vault, so they are offered in
 * read-only mode too. Registered next to the note tools by `activeTools` (server.ts).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  CodeIndex, CodeStore, codeRefStates, describeDrift, diagramSvg, formatReceipt, noteRunbookBlocks, parseCodeTarget, parseDiagramInput,
  parseHttpBlock, resolveCodeTarget, searchSymbols, validateDiagram,
  type CodeGraph, type CodeSymbolKind, type DiagramIR,
} from '@inkwright/core';
import { codeRefResolver } from '@inkwright/ai';
import type { ServerContext } from '../context.ts';
import { IdSchema, jsonResult, type ToolDef } from '../tools.ts';
import { vaultDrift } from './repo.ts';

const KINDS = ['function', 'method', 'class', 'interface', 'type', 'enum', 'const', 'struct', 'trait', 'route', 'module'] as const;
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const NO_SOURCES = 'No code source in this vault yet. Scan one with `inkwright scan <repo> --vault <vault>`, or add one in the app (Settings › Developer).';

async function graphs(ctx: ServerContext): Promise<CodeGraph[]> {
  return new CodeStore(ctx.fs).readAllGraphs();
}

export const codeSearchShape = {
  query: z.string().min(1).max(200).describe('Name, part of a name, or "path#name" (e.g. "createSession", "auth.ts#create").'),
  kind: z.enum(KINDS).optional().describe('Only this kind of symbol.'),
  path: z.string().max(400).optional().describe('Only symbols under this path prefix.'),
  limit: z.number().int().min(1).max(50).optional().describe('Results (default 15).'),
};

async function codeSearch(ctx: ServerContext, a: z.infer<z.ZodObject<typeof codeSearchShape>>): Promise<CallToolResult> {
  const gs = await graphs(ctx);
  if (!gs.length) return jsonResult({ results: [], note: NO_SOURCES });
  const hits = searchSymbols(gs, a.query, { kind: a.kind as CodeSymbolKind | undefined, path: a.path, limit: a.limit ?? 15 });
  return jsonResult({
    query: a.query,
    results: hits.map((h) => ({ id: h.symbol.id, source: h.sourceId, kind: h.symbol.kind, signature: h.symbol.signature, file: h.symbol.file, line: h.symbol.line, ...(h.symbol.doc ? { doc: h.symbol.doc } : {}), link: `[[code:${h.symbol.id}]]` })),
  });
}

export const codeSymbolShape = {
  target: z.string().min(3).max(600).describe('"path#Name" (or "code:path#Name") as code_search returns it.'),
};

async function codeSymbol(ctx: ServerContext, a: { target: string }): Promise<CallToolResult> {
  const t = parseCodeTarget(a.target.startsWith('code:') ? a.target : `code:${a.target}`);
  if (!t?.symbol) throw new Error('Give a target like "src/auth.ts#createSession".');
  const ix = (await graphs(ctx)).map((g) => new CodeIndex(g));
  if (!ix.length) throw new Error(NO_SOURCES);
  const r = resolveCodeTarget(t, ix);
  if (!r.symbol) throw new Error(`${a.target} is not in the scanned code${r.fileKnown ? ' (the file is; the symbol is not)' : ''}. Search with code_search.`);
  const i = ix.find((x) => x.graph.sourceId === r.sourceId)!;
  const s = r.symbol;
  // Notes that link this symbol (with whether they drifted).
  const notes: { id: string; title: string; status: string }[] = [];
  for (const meta of await ctx.vault.listNotes()) {
    const pages = await ctx.vault.readPages(meta);
    const st = codeRefStates(meta, pages, ix).find((x) => x.current?.id === s.id || x.key === `${t.path}#${t.symbol}`);
    if (st) notes.push({ id: meta.id, title: meta.title, status: st.status });
  }
  return jsonResult({
    id: s.id, source: r.sourceId, kind: s.kind, signature: s.signature, hash: s.hash, file: s.file, line: s.line, endLine: s.endLine,
    ...(s.doc ? { doc: s.doc } : {}), ...(s.route ? { route: s.route } : {}),
    callers: i.callers(s.id).map((c) => c.id), callees: i.callees(s.id).map((c) => c.id),
    linkedFrom: notes,
    source_code: s.source ?? null,
  });
}

async function driftReportTool(ctx: ServerContext): Promise<CallToolResult> {
  if (!(await graphs(ctx)).length) return jsonResult({ count: 0, items: [], note: NO_SOURCES });
  const items = await vaultDrift(ctx.vault);
  return jsonResult({
    count: items.length,
    items: items.map((d) => ({
      note: d.title, noteId: d.noteId, link: `[[code:${d.key}]]`, status: d.status,
      was: d.baseline?.signature ?? null, now: d.current?.signature ?? null,
      ...(d.movedTo ? { movedTo: d.movedTo.map((s) => s.id) } : {}),
      detail: describeDrift(d),
    })),
    note: items.length ? 'Review each note against the code; the user marks links reviewed in the app (nothing is changed automatically).' : 'No drift: every code link matches the code it was written against.',
  });
}

export const getRunbookShape = {
  id: IdSchema.describe('Note id (from list_notes or search_notes).'),
};

async function getRunbook(ctx: ServerContext, a: { id: string }): Promise<CallToolResult> {
  const meta = await ctx.vault.readNote(a.id);
  if (!meta || meta.trashedAt != null) throw new Error(`Note not found: ${a.id}. Use list_notes or search_notes to find note ids.`);
  const pages = await ctx.vault.readPages(meta);
  const blocks = noteRunbookBlocks(pages).map((b, i) => {
    let request: unknown;
    if (b.lang === 'http') { try { const r = parseHttpBlock(b.code); request = { method: r.method, url: r.url, headers: r.headers.map(([k]) => k), hasBody: !!r.body }; } catch (e) { request = { error: (e as Error).message }; } }
    return { index: i + 1, page: b.pageIndex + 1, language: b.lang, ...(b.name ? { name: b.name } : {}), code: b.code, ...(request ? { request } : {}) };
  });
  return jsonResult({
    note: meta.title, noteId: meta.id, blocks,
    note_on_running: 'These blocks run in the Inkwright app, with the user approving each request. This server does not execute them.',
  });
}

export const validateDiagramShape = {
  diagram: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('The diagram IR (object or JSON text): nodes [{id,label?,kind?,group?,code?}], edges [{from,to,label?,kind?}], groups?, direction?, acyclic?.'),
  svg: z.boolean().optional().describe('Also return the laid-out diagram as SVG when it is valid.'),
};

async function validateDiagramTool(ctx: ServerContext, a: { diagram: unknown; svg?: boolean }): Promise<CallToolResult> {
  const parsed = parseDiagramInput(a.diagram);
  const receipt = parsed.error ? { ok: false, errors: [parsed.error], warnings: [], stats: { nodes: 0, edges: 0, groups: 0 } } : validateDiagram(parsed.ir, { resolveCode: codeRefResolver(await graphs(ctx)) });
  const out: CallToolResult = { content: [{ type: 'text', text: JSON.stringify({ ...receipt, summary: formatReceipt(receipt) }, null, 2) }], structuredContent: receipt as unknown as Record<string, unknown> };
  if (receipt.ok && a.svg) out.content.push({ type: 'text', text: diagramSvg(parsed.ir as DiagramIR) });
  return out;
}

export const DEV_TOOLS: ToolDef[] = [
  {
    name: 'code_search',
    title: 'Search code',
    description: 'Search the repositories scanned into this vault (functions, classes, methods, HTTP routes…) by name or "path#name". Returns ids usable as [[code:path#Name]] links in notes.',
    inputSchema: codeSearchShape,
    write: false,
    annotations: { ...READ, title: 'Search code' },
    handler: (ctx, args) => codeSearch(ctx, args as z.infer<z.ZodObject<typeof codeSearchShape>>),
  },
  {
    name: 'code_symbol',
    title: 'Code symbol',
    description: 'One code symbol by "path#Name": signature, doc, source (first lines), callers, callees, and which notes link to it (with their drift status).',
    inputSchema: codeSymbolShape,
    write: false,
    annotations: { ...READ, title: 'Code symbol' },
    handler: (ctx, args) => codeSymbol(ctx, args as { target: string }),
  },
  {
    name: 'drift_report',
    title: 'Drift report',
    description: 'Code links in notes whose code changed (signature differs), disappeared or moved since the note was written or last reviewed — with the old and new signatures. Use it to find documentation that needs updating.',
    inputSchema: {},
    write: false,
    annotations: { ...READ, title: 'Drift report' },
    handler: (ctx) => driftReportTool(ctx),
  },
  {
    name: 'get_runbook',
    title: 'Get runbook',
    description: 'The runnable blocks of a runbook or incident note (```http, ```sql, ```js) with their parsed requests. Read-only: blocks run in the app with the user’s approval.',
    inputSchema: getRunbookShape,
    write: false,
    annotations: { ...READ, title: 'Get runbook' },
    handler: (ctx, args) => getRunbook(ctx, args as { id: string }),
  },
  {
    name: 'validate_diagram',
    title: 'Validate diagram',
    description: 'Check an architecture diagram IR before drawing it: returns a repair receipt (unknown node refs, kinds and groups, cycles where not allowed, code refs that are not in the scanned code, overlapping fixed layouts) with JSON pointers and hints. Fix every issue and validate again.',
    inputSchema: validateDiagramShape,
    write: false,
    annotations: { ...READ, title: 'Validate diagram' },
    handler: (ctx, args) => validateDiagramTool(ctx, args as { diagram: unknown; svg?: boolean }),
  },
];
