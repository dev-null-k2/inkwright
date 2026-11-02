/**
 * Verified diagrams. An architecture diagram is a small typed JSON IR (nodes with kinds, edges,
 * groups) — never free-form drawing instructions — so it can be checked before it lands on a
 * page. `validateDiagram` is deterministic and returns a structured *repair receipt*: what is
 * wrong, where (a JSON pointer), and a hint. An AI that emits a diagram gets the receipt back and
 * tries again (packages/ai/src/tools/diagram.ts); invalid IR is never placed.
 *
 * `layoutDiagram` places a valid IR with a layered (Sugiyama-style) layout: cycle breaking,
 * longest-path layers, dummy points for long edges, barycentre ordering with groups kept
 * together. The result is a list of drawing primitives (SVG path data and text), so the canvas,
 * SVG and PDF renderers draw exactly the same picture.
 */
import { argbToHexOpacity } from '../ids.ts';

export const DIAGRAM_NODE_KINDS = ['service', 'database', 'queue', 'cache', 'storage', 'client', 'user', 'gateway', 'function', 'job', 'external'] as const;
export const DIAGRAM_EDGE_KINDS = ['sync', 'async', 'data', 'depends'] as const;
export type DiagramNodeKind = (typeof DIAGRAM_NODE_KINDS)[number];
export type DiagramEdgeKind = (typeof DIAGRAM_EDGE_KINDS)[number];

export interface DiagramNode {
  id: string;
  label?: string;
  kind?: DiagramNodeKind;
  /** Group id this node belongs to. */
  group?: string;
  /** A code symbol this node stands for: `path#Symbol` (or `code:path#Symbol`). Must resolve. */
  code?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  /** `sync` call (solid), `async` message (dashed), `data` flow, `depends` (must not cycle). */
  kind?: DiagramEdgeKind;
}

export interface DiagramGroup {
  id: string;
  label?: string;
}

export interface DiagramIR {
  title?: string;
  /** Layers flow top-to-bottom (default) or left-to-right. */
  direction?: 'TB' | 'LR';
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
  /** Every edge must point "downstream": no cycles at all. `depends` edges never cycle regardless. */
  acyclic?: boolean;
  /** Fixed positions (diagram units) instead of the automatic layout; they must not overlap. */
  layout?: Record<string, { x: number; y: number; w?: number; h?: number }>;
}

export type DiagramIssueCode =
  | 'schema' | 'empty' | 'too_large' | 'duplicate_id' | 'unknown_node_ref' | 'unknown_group' | 'unknown_kind'
  | 'self_loop' | 'duplicate_edge' | 'cycle' | 'unbound_code_ref' | 'unchecked_code_ref' | 'overlap' | 'isolated_node';

export interface DiagramIssue {
  code: DiagramIssueCode;
  message: string;
  /** JSON pointer into the IR (`/edges/3/to`). */
  path: string;
  hint?: string;
}

/** The validator's answer: what to fix, or that the diagram may be placed. */
export interface RepairReceipt {
  ok: boolean;
  errors: DiagramIssue[];
  warnings: DiagramIssue[];
  stats: { nodes: number; edges: number; groups: number };
}

export const DIAGRAM_LIMITS = { nodes: 60, edges: 200, groups: 20, label: 60 };
const ID_RE = /^[A-Za-z][\w.-]{0,63}$/;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]!;
}

function closest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const dist = editDistance(word, o);
    if (dist < bestD) { bestD = dist; best = o; }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Cycles among `edges` (each as a node path ending where it started), found deterministically. */
export function findCycles(nodeIds: readonly string[], edges: readonly { from: string; to: string }[], max = 5): string[][] {
  const adj = new Map<string, string[]>(nodeIds.map((n) => [n, []]));
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const out: string[][] = [];
  const seen = new Set<string>();
  const dfs = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (out.length >= max) break;
      if (state.get(m) === 1) {
        const cyc = [...stack.slice(stack.indexOf(m)), m];
        const key = [...cyc.slice(0, -1)].sort().join('\u0000');
        if (!seen.has(key)) { seen.add(key); out.push(cyc); }
      } else if (!state.get(m)) dfs(m);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of nodeIds) if (!state.get(n)) dfs(n);
  return out;
}

export interface ValidateOptions {
  /** Says whether a node's `code` reference resolves in the user's code graph. Absent: refs are not checked (a warning). */
  resolveCode?: (ref: string) => boolean;
}

/** Checks an IR (any JSON value) and returns the repair receipt. Deterministic: same input, same receipt. */
export function validateDiagram(input: unknown, opts: ValidateOptions = {}): RepairReceipt {
  const errors: DiagramIssue[] = [];
  const warnings: DiagramIssue[] = [];
  const err = (code: DiagramIssueCode, path: string, message: string, hint?: string) => errors.push({ code, path, message, ...(hint ? { hint } : {}) });
  const warn = (code: DiagramIssueCode, path: string, message: string, hint?: string) => warnings.push({ code, path, message, ...(hint ? { hint } : {}) });
  const stats = { nodes: 0, edges: 0, groups: 0 };
  if (!isObj(input)) {
    err('schema', '', 'The diagram must be a JSON object with "nodes" and "edges" arrays.', 'Send {"nodes":[{"id":"api","kind":"service"}],"edges":[]}.');
    return { ok: false, errors, warnings, stats };
  }
  const ir = input;
  if (ir.title !== undefined && typeof ir.title !== 'string') err('schema', '/title', '"title" must be a string.');
  if (ir.direction !== undefined && ir.direction !== 'TB' && ir.direction !== 'LR') err('schema', '/direction', '"direction" must be "TB" or "LR".');
  if (ir.acyclic !== undefined && typeof ir.acyclic !== 'boolean') err('schema', '/acyclic', '"acyclic" must be true or false.');
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : null;
  const edges = ir.edges === undefined ? [] : Array.isArray(ir.edges) ? ir.edges : null;
  const groups = ir.groups === undefined ? [] : Array.isArray(ir.groups) ? ir.groups : null;
  if (!nodes) err('schema', '/nodes', '"nodes" must be an array of nodes.');
  if (!edges) err('schema', '/edges', '"edges" must be an array of edges.');
  if (!groups) err('schema', '/groups', '"groups" must be an array of groups.');
  if (!nodes || !edges || !groups) return { ok: false, errors, warnings, stats };
  stats.nodes = nodes.length; stats.edges = edges.length; stats.groups = groups.length;
  if (!nodes.length) err('empty', '/nodes', 'The diagram has no nodes.', 'Add at least one node.');
  if (nodes.length > DIAGRAM_LIMITS.nodes) err('too_large', '/nodes', `Too many nodes (${nodes.length}; at most ${DIAGRAM_LIMITS.nodes}).`, 'Merge detail into groups or split the diagram.');
  if (edges.length > DIAGRAM_LIMITS.edges) err('too_large', '/edges', `Too many edges (${edges.length}; at most ${DIAGRAM_LIMITS.edges}).`);
  if (groups.length > DIAGRAM_LIMITS.groups) err('too_large', '/groups', `Too many groups (${groups.length}; at most ${DIAGRAM_LIMITS.groups}).`);

  const groupIds: string[] = [];
  groups.forEach((g, i) => {
    if (!isObj(g) || typeof g.id !== 'string' || !ID_RE.test(g.id)) { err('schema', `/groups/${i}`, 'Each group needs an "id" (a letter, then letters, digits, "_", "-" or ".").'); return; }
    if (g.label !== undefined && typeof g.label !== 'string') err('schema', `/groups/${i}/label`, '"label" must be a string.');
    if (groupIds.includes(g.id)) err('duplicate_id', `/groups/${i}/id`, `Group id "${g.id}" is used twice.`, 'Give every group its own id.');
    groupIds.push(g.id);
  });

  const nodeIds: string[] = [];
  nodes.forEach((n, i) => {
    const p = `/nodes/${i}`;
    if (!isObj(n)) { err('schema', p, 'Each node must be an object like {"id":"db","kind":"database"}.'); return; }
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) { err('schema', `${p}/id`, `Node ${i} needs an "id": a letter, then letters, digits, "_", "-" or ".".`); return; }
    if (nodeIds.includes(n.id) || groupIds.includes(n.id)) err('duplicate_id', `${p}/id`, `Id "${n.id}" is used twice.`, 'Node and group ids must all be different.');
    nodeIds.push(n.id);
    if (n.label !== undefined && (typeof n.label !== 'string' || n.label.length > DIAGRAM_LIMITS.label)) err('schema', `${p}/label`, `"label" must be a string of at most ${DIAGRAM_LIMITS.label} characters.`);
    if (n.kind !== undefined && !(DIAGRAM_NODE_KINDS as readonly unknown[]).includes(n.kind)) {
      const c = typeof n.kind === 'string' ? closest(n.kind, DIAGRAM_NODE_KINDS) : undefined;
      err('unknown_kind', `${p}/kind`, `Unknown node kind ${JSON.stringify(n.kind)}.`, c ? `Did you mean "${c}"? Kinds: ${DIAGRAM_NODE_KINDS.join(', ')}.` : `Use one of: ${DIAGRAM_NODE_KINDS.join(', ')}.`);
    }
    if (n.group !== undefined && (typeof n.group !== 'string' || !groupIds.includes(n.group))) {
      const c = typeof n.group === 'string' ? closest(n.group, groupIds) : undefined;
      err('unknown_group', `${p}/group`, `Node "${n.id}" is in group ${JSON.stringify(n.group)}, which is not in "groups".`, c ? `Did you mean "${c}"?` : 'Add the group to "groups" or remove "group".');
    }
    if (n.code !== undefined) {
      if (typeof n.code !== 'string' || !n.code.trim()) err('schema', `${p}/code`, '"code" must be a "path#Symbol" string.');
      else if (opts.resolveCode) {
        if (!opts.resolveCode(n.code)) err('unbound_code_ref', `${p}/code`, `Node "${n.id}" refers to ${n.code}, which is not in the scanned code.`, 'Look the symbol up with code_search and use its exact "path#Symbol", or drop "code".');
      } else warn('unchecked_code_ref', `${p}/code`, `No code source is mounted, so ${n.code} could not be checked.`);
    }
  });

  const kinds = (DIAGRAM_EDGE_KINDS as readonly unknown[]);
  const seenEdges = new Set<string>();
  const valid: DiagramEdge[] = [];
  edges.forEach((e, i) => {
    const p = `/edges/${i}`;
    if (!isObj(e)) { err('schema', p, 'Each edge must be an object like {"from":"api","to":"db"}.'); return; }
    let ok = true;
    for (const end of ['from', 'to'] as const) {
      const v = e[end];
      if (typeof v !== 'string') { err('schema', `${p}/${end}`, `Edge ${i} needs "${end}" (a node id).`); ok = false; continue; }
      if (!nodeIds.includes(v)) {
        const c = closest(v, nodeIds);
        err('unknown_node_ref', `${p}/${end}`, `Edge ${i} ${end === 'from' ? 'starts at' : 'points to'} "${v}", which is not a node.`, c ? `Did you mean "${c}"?` : `Add a node with id "${v}", or use one of: ${nodeIds.slice(0, 12).join(', ')}.`);
        ok = false;
      }
    }
    if (e.label !== undefined && (typeof e.label !== 'string' || e.label.length > DIAGRAM_LIMITS.label)) err('schema', `${p}/label`, `"label" must be a string of at most ${DIAGRAM_LIMITS.label} characters.`);
    if (e.kind !== undefined && !kinds.includes(e.kind)) {
      err('unknown_kind', `${p}/kind`, `Unknown edge kind ${JSON.stringify(e.kind)}.`, `Use one of: ${DIAGRAM_EDGE_KINDS.join(', ')}.`);
      ok = false;
    }
    if (!ok) return;
    if (e.from === e.to) { err('self_loop', p, `Edge ${i} goes from "${e.from}" to itself.`, 'Remove it, or describe the retry/recursion in the node label.'); return; }
    const key = `${e.from}\u0000${e.to}\u0000${e.kind ?? 'sync'}`;
    if (seenEdges.has(key)) warn('duplicate_edge', p, `Edge ${i} repeats ${e.from} → ${e.to}.`);
    seenEdges.add(key);
    valid.push(e as unknown as DiagramEdge);
  });

  // Cycles: everything when the diagram says it is acyclic; `depends` edges always.
  const cycleEdges = ir.acyclic === true ? valid : valid.filter((e) => e.kind === 'depends');
  for (const c of findCycles(nodeIds, cycleEdges)) {
    const i = valid.findIndex((e) => e.from === c[c.length - 2] && e.to === c[c.length - 1]);
    err('cycle', `/edges/${Math.max(0, edges.indexOf(valid[i] as unknown))}`, `Cycle: ${c.join(' → ')}.`, ir.acyclic === true ? 'This diagram is marked acyclic: remove or reverse one edge in the cycle.' : '"depends" edges must not form a cycle: reverse one or make it "sync".');
  }

  if (ir.layout !== undefined) {
    if (!isObj(ir.layout)) err('schema', '/layout', '"layout" must map node ids to {"x","y"}.');
    else {
      const boxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
      for (const [id, v] of Object.entries(ir.layout).sort(([a], [b]) => a.localeCompare(b))) {
        const p = `/layout/${id}`;
        if (!nodeIds.includes(id)) { err('unknown_node_ref', p, `"layout" places "${id}", which is not a node.`, closest(id, nodeIds) ? `Did you mean "${closest(id, nodeIds)}"?` : undefined); continue; }
        if (!isObj(v) || typeof v.x !== 'number' || typeof v.y !== 'number' || !Number.isFinite(v.x) || !Number.isFinite(v.y)) { err('schema', p, `"layout.${id}" needs numeric "x" and "y".`); continue; }
        const n = nodes.find((x) => isObj(x) && x.id === id) as DiagramNode;
        const size = nodeSize(n);
        boxes.push({ id, x: v.x, y: v.y, w: typeof v.w === 'number' ? v.w : size.w, h: typeof v.h === 'number' ? v.h : size.h });
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!, b = boxes[j]!;
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
            err('overlap', `/layout/${b.id}`, `"${a.id}" and "${b.id}" overlap in "layout".`, `Move "${b.id}" to x ≥ ${Math.ceil(a.x + a.w + GAP)} or y ≥ ${Math.ceil(a.y + a.h + GAP)}, or drop "layout" for automatic placement.`);
          }
        }
      }
      if (boxes.length && boxes.length < nodeIds.length) err('schema', '/layout', `"layout" places ${boxes.length} of ${nodeIds.length} nodes.`, 'Place every node, or drop "layout" for automatic placement.');
    }
  }

  if (nodeIds.length > 1) {
    const linked = new Set(valid.flatMap((e) => [e.from, e.to]));
    nodeIds.forEach((id, i) => { if (!linked.has(id)) warn('isolated_node', `/nodes/${i}`, `"${id}" has no edges.`); });
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}

/** The receipt as plain text for a model to act on. */
export function formatReceipt(r: RepairReceipt): string {
  if (r.ok) return `Valid diagram (${r.stats.nodes} nodes, ${r.stats.edges} edges${r.warnings.length ? `; ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}: ${r.warnings.map((w) => w.message).join(' ')}` : ''}).`;
  const lines = r.errors.map((e, i) => `${i + 1}. [${e.code}] ${e.path || '/'}: ${e.message}${e.hint ? ` ${e.hint}` : ''}`);
  return `The diagram is not valid. Fix every issue and send the whole corrected diagram again:\n${lines.join('\n')}`;
}

/** Parses JSON text or passes an object through; JSON errors become a schema receipt. */
export function parseDiagramInput(input: unknown): { ir: unknown; error?: DiagramIssue } {
  if (typeof input !== 'string') return { ir: input };
  try {
    return { ir: JSON.parse(input) };
  } catch (e) {
    return { ir: null, error: { code: 'schema', path: '', message: `Not valid JSON: ${(e as Error).message}` } };
  }
}

// ---- Layout ------------------------------------------------------------------------------------

const NODE_H = 46;
const GAP = 28;
const LAYER_GAP = 64;
const PAD = 16;
const GROUP_PAD = 14;
const GROUP_LABEL = 16;
const CHAR_W = 7.1;

function nodeSize(n: Pick<DiagramNode, 'label' | 'id'>): { w: number; h: number } {
  const text = n.label ?? n.id;
  return { w: Math.round(Math.min(220, Math.max(92, text.length * CHAR_W + 28))), h: NODE_H };
}

export type DiagramPrim =
  | { t: 'path'; d: string; fill?: 'paper' | 'ink' | 'wash'; stroke?: boolean; dash?: boolean; width?: number; muted?: boolean }
  | { t: 'text'; text: string; x: number; y: number; size: number; weight?: number; anchor?: 'start' | 'middle'; muted?: boolean };

export interface DiagramScene {
  width: number;
  height: number;
  prims: DiagramPrim[];
  /** Node boxes (diagram units), for hit testing and overlap checks. */
  boxes: { id: string; x: number; y: number; w: number; h: number }[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2);
  return `M${r1(x + r)} ${r1(y)}H${r1(x + w - r)}A${r} ${r} 0 0 1 ${r1(x + w)} ${r1(y + r)}V${r1(y + h - r)}A${r} ${r} 0 0 1 ${r1(x + w - r)} ${r1(y + h)}H${r1(x + r)}A${r} ${r} 0 0 1 ${r1(x)} ${r1(y + h - r)}V${r1(y + r)}A${r} ${r} 0 0 1 ${r1(x + r)} ${r1(y)}Z`;
}

/** A node's outline (and inner detail) by kind: the shape carries the meaning, not colour. */
function nodeShape(kind: DiagramNodeKind | undefined, x: number, y: number, w: number, h: number): DiagramPrim[] {
  switch (kind) {
    case 'database':
    case 'storage': {
      const ry = 6;
      const body = `M${r1(x)} ${r1(y + ry)}A${w / 2} ${ry} 0 0 1 ${r1(x + w)} ${r1(y + ry)}V${r1(y + h - ry)}A${w / 2} ${ry} 0 0 1 ${r1(x)} ${r1(y + h - ry)}Z`;
      const lip = `M${r1(x)} ${r1(y + ry)}A${w / 2} ${ry} 0 0 0 ${r1(x + w)} ${r1(y + ry)}`;
      return [{ t: 'path', d: body, fill: 'paper', stroke: true }, { t: 'path', d: lip, stroke: true }];
    }
    case 'queue':
      return [{ t: 'path', d: roundRect(x, y, w, h, h / 2), fill: 'paper', stroke: true }];
    case 'cache':
      return [{ t: 'path', d: roundRect(x, y, w, h, 4), fill: 'paper', stroke: true }, { t: 'path', d: roundRect(x + 3, y + 3, w - 6, h - 6, 2), stroke: true, width: 0.6 }];
    case 'external':
      return [{ t: 'path', d: roundRect(x, y, w, h, 4), fill: 'paper', stroke: true, dash: true }];
    case 'client':
    case 'user':
      return [{ t: 'path', d: roundRect(x, y, w, h, 14), fill: 'paper', stroke: true }];
    case 'gateway': {
      const k = 10;
      return [{ t: 'path', d: `M${r1(x + k)} ${r1(y)}H${r1(x + w - k)}L${r1(x + w)} ${r1(y + h / 2)}L${r1(x + w - k)} ${r1(y + h)}H${r1(x + k)}L${r1(x)} ${r1(y + h / 2)}Z`, fill: 'paper', stroke: true }];
    }
    case 'function':
    case 'job': {
      const k = 8;
      return [{ t: 'path', d: `M${r1(x + k)} ${r1(y)}H${r1(x + w)}V${r1(y + h - k)}L${r1(x + w - k)} ${r1(y + h)}H${r1(x)}V${r1(y + k)}Z`, fill: 'paper', stroke: true }];
    }
    default:
      return [{ t: 'path', d: roundRect(x, y, w, h, 6), fill: 'paper', stroke: true }];
  }
}

/** Where the segment from the box centre towards (tx, ty) leaves the box. */
function clipToBox(b: { x: number; y: number; w: number; h: number }, tx: number, ty: number): [number, number] {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const sx = dx ? (b.w / 2 + 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (b.h / 2 + 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return [cx + dx * s, cy + dy * s];
}

/**
 * Places a *valid* IR and draws it. Deterministic: ties break by declaration order, so the same
 * IR always gives the same picture.
 */
export function layoutDiagram(ir: DiagramIR): DiagramScene {
  const lr = ir.direction === 'LR';
  const nodes = ir.nodes;
  const ids = nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const edges = ir.edges.filter((e) => index.has(e.from) && index.has(e.to) && e.from !== e.to);
  const size = new Map(nodes.map((n) => [n.id, nodeSize(n)]));

  let boxes: DiagramScene['boxes'];
  const routes = new Map<DiagramEdge, [number, number][]>();
  if (ir.layout && ids.every((id) => ir.layout![id])) {
    boxes = nodes.map((n) => { const l = ir.layout![n.id]!; const s = size.get(n.id)!; return { id: n.id, x: l.x, y: l.y, w: l.w ?? s.w, h: l.h ?? s.h }; });
  } else {
    // 1. Break cycles: edges that close a DFS cycle are laid out reversed.
    const reversed = new Set<DiagramEdge>();
    const adj = new Map<string, DiagramEdge[]>(ids.map((id) => [id, []]));
    for (const e of edges) adj.get(e.from)!.push(e);
    const st = new Map<string, number>();
    const dfs = (n: string) => {
      st.set(n, 1);
      for (const e of adj.get(n)!) {
        if (st.get(e.to) === 1) reversed.add(e);
        else if (!st.get(e.to)) dfs(e.to);
      }
      st.set(n, 2);
    };
    for (const id of ids) if (!st.get(id)) dfs(id);
    const dag = edges.map((e) => (reversed.has(e) ? { e, from: e.to, to: e.from } : { e, from: e.from, to: e.to }));

    // 2. Longest-path layering.
    const layer = new Map<string, number>(ids.map((id) => [id, 0]));
    for (let pass = 0; pass < ids.length; pass++) {
      let changed = false;
      for (const d of dag) {
        const want = layer.get(d.from)! + 1;
        if (layer.get(d.to)! < want) { layer.set(d.to, want); changed = true; }
      }
      if (!changed) break;
    }

    // 3. Dummy points so long edges bend around the layers they cross.
    type Slot = { id: string; dummy: boolean; group?: string };
    const layers: Slot[][] = [];
    const put = (l: number, s: Slot) => (layers[l] ??= []).push(s);
    nodes.forEach((n) => put(layer.get(n.id)!, { id: n.id, dummy: false, group: n.group }));
    const chains = new Map<DiagramEdge, string[]>();
    const links: [string, string][] = [];
    dag.forEach((d, k) => {
      const a = layer.get(d.from)!, b = layer.get(d.to)!;
      const chain = [d.from];
      for (let l = a + 1; l < b; l++) {
        const id = `\u0000${k}:${l}`;
        put(l, { id, dummy: true });
        chain.push(id);
      }
      chain.push(d.to);
      for (let i = 0; i + 1 < chain.length; i++) links.push([chain[i]!, chain[i + 1]!]);
      chains.set(d.e, reversed.has(d.e) ? [...chain].reverse() : chain);
    });
    for (let l = 0; l < layers.length; l++) layers[l] ??= [];

    // 4. Ordering: barycentre sweeps, then groups gathered (in their mean position).
    const pos = new Map<string, number>();
    const renumber = () => layers.forEach((L) => L.forEach((s, i) => pos.set(s.id, i)));
    renumber();
    const up = new Map<string, string[]>(), down = new Map<string, string[]>();
    for (const [a, b] of links) { (down.get(a) ?? down.set(a, []).get(a)!).push(b); (up.get(b) ?? up.set(b, []).get(b)!).push(a); }
    const bary = (id: string, nb: Map<string, string[]>) => {
      const xs = (nb.get(id) ?? []).map((n) => pos.get(n)!);
      return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : pos.get(id)!;
    };
    const order = (L: Slot[], nb: Map<string, string[]>) => {
      const keyed = L.map((s, i) => ({ s, k: bary(s.id, nb), i }));
      const gk = new Map<string, number>();
      for (const g of new Set(keyed.map((x) => x.s.group).filter(Boolean))) {
        const m = keyed.filter((x) => x.s.group === g);
        gk.set(g!, m.reduce((s, v) => s + v.k, 0) / m.length);
      }
      keyed.sort((a, b) => (a.s.group ? gk.get(a.s.group)! : a.k) - (b.s.group ? gk.get(b.s.group)! : b.k) || (a.s.group ?? '').localeCompare(b.s.group ?? '') || a.k - b.k || a.i - b.i);
      return keyed.map((x) => x.s);
    };
    for (let it = 0; it < 6; it++) {
      for (let l = 1; l < layers.length; l++) { layers[l] = order(layers[l]!, up); renumber(); }
      for (let l = layers.length - 2; l >= 0; l--) { layers[l] = order(layers[l]!, down); renumber(); }
    }

    // 5. Coordinates: each layer centred; groups get room for their frame.
    const along = (s: Slot) => (s.dummy ? 8 : lr ? size.get(s.id)!.h : size.get(s.id)!.w);
    const across = (s: Slot) => (s.dummy ? 0 : lr ? size.get(s.id)!.w : size.get(s.id)!.h);
    const spanOf = (L: Slot[]) => L.reduce((t, s, i) => t + along(s) + (i ? gapBetween(L[i - 1]!, s) : 0), 0);
    const gapBetween = (a: Slot, b: Slot) => (a.group !== b.group && (a.group || b.group) ? GAP + GROUP_PAD * 2 : a.dummy || b.dummy ? GAP / 2 : GAP);
    const widest = Math.max(...layers.map(spanOf));
    const depth = layers.map((L) => Math.max(0, ...L.map(across)));
    const hasGroups = (ir.groups?.length ?? 0) > 0;
    const offset = PAD + (hasGroups ? GROUP_PAD + GROUP_LABEL : 0);
    const titleH = ir.title ? 26 : 0;
    // Along-axis start of every slot: each layer centred on the widest.
    const start = new Map<string, number>();
    layers.forEach((L) => {
      let at = offset + (widest - spanOf(L)) / 2;
      L.forEach((s, i) => {
        if (i) at += gapBetween(L[i - 1]!, s);
        start.set(s.id, at);
        at += along(s);
      });
    });
    // A group's frame spans every layer it has members in: push other nodes in those layers out
    // of it (to the side they are already on), so nothing sits inside a group it is not part of.
    for (const g of ir.groups ?? []) {
      const member = (s: Slot) => !s.dummy && s.group === g.id;
      const ls = layers.map((L, l) => (L.some(member) ? l : -1)).filter((l) => l >= 0);
      if (!ls.length) continue;
      const inGroup = layers.flatMap((L) => L.filter(member));
      const g0 = Math.min(...inGroup.map((s) => start.get(s.id)!)) - GROUP_PAD;
      const g1 = Math.max(...inGroup.map((s) => start.get(s.id)! + along(s))) + GROUP_PAD;
      const mid = (g0 + g1) / 2;
      for (let l = ls[0]!; l <= ls[ls.length - 1]!; l++) {
        const L = layers[l]!;
        L.forEach((s, i) => {
          if (member(s) || s.dummy) return;
          const a = start.get(s.id)!, b = a + along(s);
          if (b <= g0 - GAP / 2 || a >= g1 + GAP / 2) return;
          if (a + along(s) / 2 < mid) {
            const shift = b - (g0 - GAP / 2);
            for (let k = 0; k <= i; k++) start.set(L[k]!.id, start.get(L[k]!.id)! - shift);
          } else {
            const shift = g1 + GAP / 2 - a;
            for (let k = i; k < L.length; k++) start.set(L[k]!.id, start.get(L[k]!.id)! + shift);
          }
        });
      }
    }
    const minStart = Math.min(...[...start.values()]);
    const lead = minStart < offset ? offset - minStart : 0;
    // A long edge runs straight through each layer it crosses (in at the top, out at the bottom).
    const point = new Map<string, [number, number][]>();
    boxes = [];
    let crossAt = offset + titleH;
    layers.forEach((L, l) => {
      L.forEach((s) => {
        const at = start.get(s.id)! + lead;
        const a = along(s), c = across(s);
        const mid = crossAt + depth[l]! / 2;
        if (s.dummy) {
          const c0 = crossAt, c1 = crossAt + depth[l]!;
          point.set(s.id, lr ? [[c0, at + a / 2], [c1, at + a / 2]] : [[at + a / 2, c0], [at + a / 2, c1]]);
        } else {
          const sz = size.get(s.id)!;
          const x = lr ? mid - c / 2 : at, y = lr ? at : mid - c / 2;
          boxes.push({ id: s.id, x: r1(x), y: r1(y), w: sz.w, h: sz.h });
        }
      });
      crossAt += depth[l]! + LAYER_GAP + (hasGroups ? GROUP_PAD : 0);
    });
    boxes.sort((a, b) => index.get(a.id)! - index.get(b.id)!);
    const boxOf = new Map(boxes.map((b) => [b.id, b]));
    for (const [e, chain] of chains) {
      const through = (id: string) => { const p = point.get(id)!; return reversed.has(e) ? [...p].reverse() : p; };
      const pts = chain.flatMap((id) => (point.has(id) ? through(id) : [[boxOf.get(id)!.x + boxOf.get(id)!.w / 2, boxOf.get(id)!.y + boxOf.get(id)!.h / 2] as [number, number]]));
      routes.set(e, pts);
    }
  }

  // ---- Draw ----
  const prims: DiagramPrim[] = [];
  const boxOf = new Map(boxes.map((b) => [b.id, b]));
  const groupBoxes: { id: string; label: string; x: number; y: number; w: number; h: number }[] = [];
  for (const g of ir.groups ?? []) {
    const members = boxes.filter((b) => nodes[index.get(b.id)!]!.group === g.id);
    if (!members.length) continue;
    const x0 = Math.min(...members.map((b) => b.x)) - GROUP_PAD, y0 = Math.min(...members.map((b) => b.y)) - GROUP_PAD - GROUP_LABEL;
    const x1 = Math.max(...members.map((b) => b.x + b.w)) + GROUP_PAD, y1 = Math.max(...members.map((b) => b.y + b.h)) + GROUP_PAD;
    groupBoxes.push({ id: g.id, label: g.label ?? g.id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  for (const g of groupBoxes) {
    prims.push({ t: 'path', d: roundRect(g.x, g.y, g.w, g.h, 10), fill: 'wash', stroke: true, dash: true, width: 0.8, muted: true });
    prims.push({ t: 'text', text: g.label, x: r1(g.x + 10), y: r1(g.y + 13), size: 11, weight: 600, muted: true });
  }
  for (const e of edges) {
    const a = boxOf.get(e.from)!, b = boxOf.get(e.to)!;
    let pts = routes.get(e) ?? [[a.x + a.w / 2, a.y + a.h / 2], [b.x + b.w / 2, b.y + b.h / 2]];
    pts = pts.map((p) => [r1(p[0]), r1(p[1])] as [number, number]);
    const start = clipToBox(a, ...(pts[1] ?? [b.x + b.w / 2, b.y + b.h / 2]));
    const end = clipToBox(b, ...(pts[pts.length - 2] ?? [a.x + a.w / 2, a.y + a.h / 2]));
    const line = [start, ...pts.slice(1, -1), end].map((p) => [r1(p[0]), r1(p[1])] as [number, number]);
    prims.push({ t: 'path', d: `M${line.map((p) => `${p[0]} ${p[1]}`).join('L')}`, stroke: true, dash: e.kind === 'async', width: e.kind === 'data' ? 1.8 : 1.1 });
    // Arrowhead at the target (an open chevron for `depends`).
    const [px, py] = line[line.length - 2]!;
    const [qx, qy] = line[line.length - 1]!;
    const ang = Math.atan2(qy - py, qx - px);
    const hx = (k: number) => r1(qx - 8 * Math.cos(ang + k));
    const hy = (k: number) => r1(qy - 8 * Math.sin(ang + k));
    prims.push(e.kind === 'depends'
      ? { t: 'path', d: `M${hx(0.45)} ${hy(0.45)}L${qx} ${qy}L${hx(-0.45)} ${hy(-0.45)}`, stroke: true, width: 1.1 }
      : { t: 'path', d: `M${hx(0.42)} ${hy(0.42)}L${qx} ${qy}L${hx(-0.42)} ${hy(-0.42)}Z`, fill: 'ink' });
    if (e.label) {
      const mid = line[Math.floor((line.length - 1) / 2)]!, nxt = line[Math.floor((line.length - 1) / 2) + 1]!;
      prims.push({ t: 'text', text: e.label, x: r1((mid[0] + nxt[0]) / 2 + (lr ? 0 : 6)), y: r1((mid[1] + nxt[1]) / 2 - (lr ? 5 : -4)), size: 10, anchor: lr ? 'middle' : 'start', muted: true });
    }
  }
  for (const n of nodes) {
    const b = boxOf.get(n.id)!;
    prims.push(...nodeShape(n.kind, b.x, b.y, b.w, b.h));
    const label = n.label ?? n.id;
    prims.push({ t: 'text', text: label, x: r1(b.x + b.w / 2), y: r1(b.y + b.h / 2 + (n.kind ? 0 : 4)), size: 13, weight: 560, anchor: 'middle' });
    if (n.kind) prims.push({ t: 'text', text: n.code ? `${n.kind} · code` : n.kind, x: r1(b.x + b.w / 2), y: r1(b.y + b.h / 2 + 14), size: 9.5, anchor: 'middle', muted: true });
  }
  if (ir.title) prims.unshift({ t: 'text', text: ir.title, x: PAD, y: PAD + 12, size: 15, weight: 650 });
  const all = [...boxes, ...groupBoxes];
  const width = r1(Math.max(...all.map((b) => b.x + b.w)) + PAD);
  const height = r1(Math.max(...all.map((b) => b.y + b.h)) + PAD);
  return { width: Math.max(width, ir.title ? ir.title.length * 8 + PAD * 2 : 0), height, prims, boxes };
}

/** Node boxes that overlap in a scene (a valid layout has none). */
export function sceneOverlaps(scene: DiagramScene): [string, string][] {
  const out: [string, string][] = [];
  const b = scene.boxes;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    const p = b[i]!, q = b[j]!;
    if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) out.push([p.id, q.id]);
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DiagramColors {
  /** Lines and text (`#RRGGBB` or `#AARRGGBB`). */
  ink: string;
  /** Node fill: the paper. */
  paper: string;
}

const css = (c: string) => (/^#[0-9a-f]{8}$/i.test(c) ? argbToHexOpacity(c) : { rgb: c, opacity: 1 });

/** The scene as SVG elements (a `<g>`), scaled by `scale` and placed at (x, y). */
export function diagramSvgGroup(scene: DiagramScene, o: { x?: number; y?: number; scale?: number; colors: DiagramColors; font?: string }): string {
  const ink = css(o.colors.ink);
  const paper = css(o.colors.paper);
  const font = o.font ?? "Inter, 'Helvetica Neue', Arial, sans-serif";
  const out: string[] = [`<g class="diagram" transform="translate(${o.x ?? 0} ${o.y ?? 0}) scale(${o.scale ?? 1})" font-family="${esc(font)}">`];
  for (const p of scene.prims) {
    const op = (p.muted ? 0.62 : 1) * ink.opacity;
    if (p.t === 'path') {
      const fill = p.fill === 'paper' ? `fill="${paper.rgb}"` : p.fill === 'ink' ? `fill="${ink.rgb}" fill-opacity="${op}"` : p.fill === 'wash' ? `fill="${ink.rgb}" fill-opacity="0.035"` : 'fill="none"';
      const stroke = p.stroke ? ` stroke="${ink.rgb}" stroke-opacity="${op}" stroke-width="${p.width ?? 1.2}" stroke-linejoin="round" stroke-linecap="round"${p.dash ? ' stroke-dasharray="5 4"' : ''}` : '';
      out.push(`<path d="${p.d}" ${fill}${stroke}/>`);
    } else {
      out.push(`<text x="${p.x}" y="${p.y}" font-size="${p.size}"${p.weight ? ` font-weight="${p.weight}"` : ''}${p.anchor === 'middle' ? ' text-anchor="middle"' : ''} fill="${ink.rgb}" fill-opacity="${op}">${esc(p.text)}</text>`);
    }
  }
  out.push('</g>');
  return out.join('');
}

/** A standalone SVG document of the diagram (MCP `validate_diagram`, exports). */
export function diagramSvg(ir: DiagramIR, colors: DiagramColors = { ink: '#1B1F24', paper: '#FFFFFF' }): string {
  const scene = layoutDiagram(ir);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">${diagramSvgGroup(scene, { colors })}</svg>`;
}

/** The diagram as Markdown-friendly text (search, note.md, agents). */
export function diagramText(ir: DiagramIR): string {
  const name = (id: string) => ir.nodes.find((n) => n.id === id)?.label ?? id;
  const lines = [`Diagram${ir.title ? `: ${ir.title}` : ''}`];
  for (const e of ir.edges) lines.push(`- ${name(e.from)} → ${name(e.to)}${e.label ? ` (${e.label})` : ''}`);
  return lines.join('\n');
}

// ---- As a page object --------------------------------------------------------------------------

/**
 * A verified diagram placed on a page (`PageInk.objects`, type `diagram`). The IR is the source
 * of truth; the picture is laid out from it by every renderer, scaled to `width` x `height`.
 */
export interface DiagramObject {
  type: 'diagram';
  id: string;
  x: number;
  y: number;
  createdAt: number;
  origin?: 'ai' | 'import';
  width: number;
  height: number;
  ir: DiagramIR;
  /** Line and text colour `#AARRGGBB`. */
  color: string;
}

/** A diagram object for a valid IR, about `width` wide (page units) at (x, y). */
export function makeDiagramObject(ir: DiagramIR, o: { id: string; x: number; y: number; width?: number; now: number; origin?: DiagramObject['origin']; color?: string }): DiagramObject {
  const scene = layoutDiagram(ir);
  const width = Math.min(o.width ?? scene.width, scene.width * 1.4);
  const k = width / scene.width;
  return { type: 'diagram', id: o.id, x: o.x, y: o.y, createdAt: o.now, ...(o.origin ? { origin: o.origin } : {}), width: Math.round(width), height: Math.round(scene.height * k), ir, color: o.color ?? '#FF1B1F24' };
}

/** SVG of a placed diagram (page SVG export, the vault's derived `pages/*.svg`). */
export function diagramObjectSvg(d: DiagramObject, paper = '#FFFFFF'): string {
  const scene = layoutDiagram(d.ir);
  return diagramSvgGroup(scene, { x: d.x, y: d.y, scale: d.width / scene.width, colors: { ink: d.color, paper } });
}
