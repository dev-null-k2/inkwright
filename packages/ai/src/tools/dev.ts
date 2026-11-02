/**
 * Agent tools of the developer module (docs/DEVELOPERS.md): verified diagrams, the code graph,
 * drift, and lesson proposals from agent sessions. Hosts (the app, the MCP server's agent) supply
 * the data; the rules live in @inkstone/core/dev.
 *
 * `create_diagram` is a repair loop driven by the agent loop itself: the model sends the typed IR,
 * the deterministic validator answers with a receipt, and an invalid diagram comes back as a tool
 * error listing every issue with a JSON pointer and a hint — the model fixes and resends. Only a
 * valid diagram is ever placed; after `maxAttempts` invalid tries the tool stops accepting them
 * for the run, so a model that cannot converge can't loop forever or land something broken.
 */
import {
  CodeIndex, DIAGRAM_EDGE_KINDS, DIAGRAM_NODE_KINDS, describeDrift, formatReceipt, parseCodeTarget, parseDiagramInput,
  resolveCodeTarget, searchSymbols, validateDiagram,
  type CodeGraph, type CodeSymbolKind, type DiagramIR, type DriftItem, type RepairReceipt,
} from '@inkstone/core';
import type { AgentTool } from '../agent.ts';

export interface DiagramPlacement {
  noteId: string;
  title: string;
  pageIndex: number;
  objectId: string;
}

export interface DevToolHost {
  /** Places a *validated* diagram (in the open note, or the given/new note). */
  placeDiagram?(ir: DiagramIR, opts: { noteId?: string; title?: string }): Promise<DiagramPlacement>;
  /** The scanned code graphs (empty when no code source is mounted). */
  codeGraphs(): Promise<CodeGraph[]>;
  /** Drifted code links across the notes. */
  driftReport?(): Promise<DriftItem[]>;
  /** Saves lesson proposals for the user to accept into AGENTS.md; returns how many were new. */
  proposeLessons?(lessons: { text: string; why?: string }[], from?: { noteId?: string }): Promise<number>;
}

const SYMBOL_KINDS: CodeSymbolKind[] = ['function', 'method', 'class', 'interface', 'type', 'enum', 'const', 'struct', 'trait', 'route', 'module'];

/** JSON Schema of the IR (documentation, MCP `validate_diagram`). */
export const DIAGRAM_IR_SCHEMA = {
  type: 'object',
  description: 'Typed diagram IR. Node ids: a letter, then letters, digits, "_", "-" or ".".',
  properties: {
    title: { type: 'string' },
    direction: { type: 'string', enum: ['TB', 'LR'], description: 'Top-to-bottom (default) or left-to-right.' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string', enum: [...DIAGRAM_NODE_KINDS] },
          group: { type: 'string', description: 'Id of a group in "groups".' },
          code: { type: 'string', description: 'The code symbol this node stands for, "path#Symbol" exactly as code_search returns it.' },
        },
        required: ['id'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string', enum: [...DIAGRAM_EDGE_KINDS], description: 'sync call (default), async message, data flow, depends (must not cycle).' },
        },
        required: ['from', 'to'],
      },
    },
    groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id'] } },
    acyclic: { type: 'boolean', description: 'Set when no edge may close a cycle (e.g. a layered dependency diagram).' },
  },
  required: ['nodes', 'edges'],
} as const;

/** A code-ref resolver over the host's graphs (null when there are none: refs are then unchecked). */
export function codeRefResolver(graphs: readonly CodeGraph[]): ((ref: string) => boolean) | undefined {
  if (!graphs.length) return undefined;
  const ix = graphs.map((g) => new CodeIndex(g));
  return (ref) => {
    const t = parseCodeTarget(ref.startsWith('code:') ? ref : `code:${ref}`);
    if (!t) return false;
    const r = resolveCodeTarget(t, ix);
    return t.symbol ? !!r.symbol : r.fileKnown;
  };
}

/** Thrown by `create_diagram` for an invalid IR; the message is the receipt the model reads. */
export class DiagramRejected extends Error {
  constructor(readonly receipt: RepairReceipt, readonly attempt: number, readonly maxAttempts: number) {
    super(`${formatReceipt(receipt)}\n(Attempt ${attempt} of ${maxAttempts}; nothing was placed.)`);
    this.name = 'DiagramRejected';
  }
}

export function createDiagramTool(host: DevToolHost, opts: { maxAttempts?: number; onReceipt?: (r: RepairReceipt, attempt: number) => void } = {}): AgentTool {
  const max = opts.maxAttempts ?? 4;
  let failures = 0;
  return {
    name: 'create_diagram',
    description:
      'Draw an architecture or flow diagram on the note as a verified diagram. Send the typed IR: nodes (id, label, kind, optional group and code "path#Symbol"), edges (from, to, label, kind), groups. It is validated before anything is drawn; if invalid you get a numbered list of issues — fix all of them and call again with the whole corrected diagram. Look symbols up with code_search before using "code".',
    parameters: {
      type: 'object',
      properties: {
        // Deliberately loose here: the diagram validator, not the generic argument check, judges
        // the IR, so the model gets one receipt with every issue, pointers and hints.
        diagram: {
          type: ['object', 'string'],
          description: `The diagram IR: {"title"?, "direction"?: "TB"|"LR", "nodes": [{"id", "label"?, "kind"?: ${DIAGRAM_NODE_KINDS.join('|')}, "group"?, "code"?: "path#Symbol"}], "edges": [{"from", "to", "label"?, "kind"?: ${DIAGRAM_EDGE_KINDS.join('|')}}], "groups"?: [{"id", "label"?}], "acyclic"?: boolean}`,
        },
        note_id: { type: 'string', description: 'Put it in this note (default: the open note, or a new note).' },
        title: { type: 'string', description: 'Title for a new note when there is no open note.' },
      },
      required: ['diagram'],
    },
    async execute(args: { diagram: unknown; note_id?: string; title?: string }) {
      if (!host.placeDiagram) throw new Error('Diagrams cannot be placed here.');
      if (failures >= max) throw new Error(`Stopped after ${max} invalid diagrams in this conversation; nothing was placed. Tell the user what you could not get right.`);
      const parsed = parseDiagramInput(args.diagram);
      const receipt: RepairReceipt = parsed.error
        ? { ok: false, errors: [parsed.error], warnings: [], stats: { nodes: 0, edges: 0, groups: 0 } }
        : validateDiagram(parsed.ir, { resolveCode: codeRefResolver(await host.codeGraphs()) });
      opts.onReceipt?.(receipt, failures + 1);
      if (!receipt.ok) {
        failures++;
        throw new DiagramRejected(receipt, failures, max);
      }
      const where = await host.placeDiagram(parsed.ir as DiagramIR, { noteId: args.note_id, title: args.title });
      return { placed: true, note_id: where.noteId, note: where.title, page: where.pageIndex + 1, object_id: where.objectId, receipt: formatReceipt(receipt) };
    },
  };
}

export function createCodeTools(host: DevToolHost): AgentTool[] {
  return [
    {
      name: 'code_search',
      description: 'Search the user\'s scanned code (functions, classes, methods, routes…) by name or "path#name". Returns ids to use in [[code:…]] links and diagram "code" fields.',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: { type: 'string', enum: SYMBOL_KINDS },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      async execute(a: { query: string; kind?: CodeSymbolKind; limit?: number }) {
        const graphs = await host.codeGraphs();
        if (!graphs.length) return { results: [], note: 'No code source is mounted. The user can add one in Settings › Developer.' };
        return {
          results: searchSymbols(graphs, a.query, { kind: a.kind, limit: Math.min(50, a.limit ?? 12) }).map((h) => ({
            id: h.symbol.id, kind: h.symbol.kind, signature: h.symbol.signature, file: h.symbol.file, line: h.symbol.line, ...(h.symbol.doc ? { doc: h.symbol.doc } : {}), link: `[[code:${h.symbol.id}]]`,
          })),
        };
      },
    },
    {
      name: 'code_symbol',
      description: 'Read one code symbol ("path#Name"): signature, doc, source (first lines), callers and callees.',
      readOnly: true,
      parameters: { type: 'object', properties: { target: { type: 'string', description: '"path#Name" as code_search returns it.' } }, required: ['target'] },
      async execute(a: { target: string }) {
        const t = parseCodeTarget(a.target.startsWith('code:') ? a.target : `code:${a.target}`);
        if (!t?.symbol) throw new Error('Give a target like "src/auth.ts#createSession".');
        const ix = (await host.codeGraphs()).map((g) => new CodeIndex(g));
        const r = resolveCodeTarget(t, ix);
        if (!r.symbol) throw new Error(`${a.target} is not in the scanned code. Search with code_search.`);
        const i = ix.find((x) => x.graph.sourceId === r.sourceId)!;
        const s = r.symbol;
        return { id: s.id, kind: s.kind, signature: s.signature, doc: s.doc, file: s.file, line: s.line, endLine: s.endLine, source: s.source, callers: i.callers(s.id).map((c) => c.id), callees: i.callees(s.id).map((c) => c.id) };
      },
    },
    ...(host.driftReport ? [{
      name: 'drift_report',
      description: 'Code links in the user\'s notes whose code changed or disappeared since the note was written (old vs new signature).',
      readOnly: true,
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = await host.driftReport!();
        return { count: items.length, items: items.map((d) => ({ note: d.title, note_id: d.noteId, link: d.key, status: d.status, detail: describeDrift(d) })) };
      },
    } satisfies AgentTool] : []),
  ];
}

export function createLessonTool(host: DevToolHost, from?: { noteId?: string }): AgentTool {
  return {
    name: 'propose_lessons',
    description:
      'Propose durable lessons from a coding-agent session for the user\'s AGENTS.md: short, specific, reusable rules ("Run migrations with --dry-run first"), not a summary. The user accepts or dismisses each one; nothing is written until they do.',
    parameters: {
      type: 'object',
      properties: {
        lessons: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string', description: 'The lesson, one imperative sentence.' }, why: { type: 'string', description: 'What happened in the session that teaches it.' } }, required: ['text'] },
        },
      },
      required: ['lessons'],
    },
    async execute(a: { lessons: { text: string; why?: string }[] }) {
      if (!host.proposeLessons) throw new Error('Lessons cannot be saved here.');
      const list = (a.lessons ?? []).filter((l) => l && typeof l.text === 'string' && l.text.trim()).slice(0, 12);
      if (!list.length) throw new Error('Send at least one lesson with "text".');
      const n = await host.proposeLessons(list, from);
      return { proposed: n, note: n ? 'The user will review them in the app.' : 'They were all proposed before.' };
    },
  };
}

/** System-prompt lines for the developer tools. */
export const DEV_TOOLS_PROMPT = 'Developer tools: code_search/code_symbol read the user\'s scanned repositories; link code in notes as [[code:path#Symbol]]. create_diagram draws verified architecture diagrams from a typed IR — when it reports issues, fix every one and resend the whole diagram.';
