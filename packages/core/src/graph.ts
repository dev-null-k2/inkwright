/**
 * The knowledge graph: notes as nodes; links, shared tags, notebook membership and (optionally)
 * "related" notes as edges; notebooks as clusters. Pure data — the 3D and 2D views draw it, the
 * force layout (forcelayout.ts) places it, tests check it.
 */
import type { KnowledgeIndex } from './knowledge.ts';
import type { NotebookMeta } from './model.ts';

export type GraphNodeKind = 'note' | 'tag' | 'notebook';
export type GraphEdgeKind = 'link' | 'tag' | 'notebook' | 'related';

export interface GraphNode {
  /** Note id, `tag:<name>` or `nb:<notebook id>`. */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Notebook of a note (or the notebook itself for notebook nodes). */
  notebookId?: string;
  /** `#AARRGGBB` from the notebook cover; undefined for unfiled notes and tags. */
  color?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** Number of edges touching the node (after filtering). */
  degree: number;
  pageCount: number;
  daily?: boolean;
  /** Top-level notebook the node belongs to (its cluster). */
  cluster?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** Link count, or similarity score for related edges. */
  weight: number;
}

export interface GraphCluster {
  /** Notebook id. */
  id: string;
  name: string;
  color: string;
  /** Note node ids in this notebook or its sub-notebooks. */
  nodeIds: string[];
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
}

export interface GraphOptions {
  /** Draw tags as nodes joined to their notes (default true). */
  tags?: boolean;
  /** Join notes to a node for their notebook (default true). */
  notebooks?: boolean;
  /** Related-note lists per note id (from a RelatedNotesProvider). */
  related?: ReadonlyMap<string, readonly { id: string; score: number }[]>;
  /** Minimum related score to draw an edge (default 0.18). */
  relatedMin?: number;
  /** At most this many related edges per note (default 3). */
  relatedPerNote?: number;
  /** Only notes in these notebooks (and their sub-notebooks). */
  notebookIds?: readonly string[];
  /** Only notes carrying this tag. */
  tag?: string;
  /** Only notes created at or before this time. */
  until?: number;
}

export const tagNodeId = (tag: string) => `tag:${tag.toLowerCase()}`;
export const notebookNodeId = (id: string) => `nb:${id}`;

function descendantsOf(notebooks: readonly NotebookMeta[], ids: readonly string[]): Set<string> {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of notebooks) if (n.parentId && out.has(n.parentId) && !out.has(n.id)) { out.add(n.id); grew = true; }
  }
  return out;
}

/** The notebook at the top of a notebook's parent chain. */
function rootOf(notebooks: readonly NotebookMeta[], id: string): NotebookMeta | undefined {
  let cur = notebooks.find((n) => n.id === id);
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = notebooks.find((n) => n.id === cur!.parentId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

export function buildGraph(index: KnowledgeIndex, notebooks: readonly NotebookMeta[], opts: GraphOptions = {}): GraphData {
  const showTags = opts.tags ?? true;
  const showNotebooks = opts.notebooks ?? true;
  const nbFilter = opts.notebookIds?.length ? descendantsOf(notebooks, opts.notebookIds) : null;
  const tagFilter = opts.tag?.toLowerCase();
  const nbById = new Map(notebooks.map((n) => [n.id, n]));

  const nodes = new Map<string, GraphNode>();
  for (const n of index.notes()) {
    if (nbFilter && !(n.notebookId && nbFilter.has(n.notebookId))) continue;
    const tags = index.tagsOf(n.id);
    if (tagFilter && !tags.some((t) => t.toLowerCase() === tagFilter)) continue;
    if (opts.until != null && n.createdAt > opts.until) continue;
    const nb = n.notebookId ? nbById.get(n.notebookId) : undefined;
    nodes.set(n.id, {
      id: n.id, kind: 'note', label: n.title || 'Untitled', notebookId: nb?.id, color: nb?.color, tags,
      createdAt: n.createdAt, updatedAt: n.updatedAt, degree: 0, pageCount: n.pageIds.length, daily: n.daily ? true : undefined,
    });
  }

  const edges: GraphEdge[] = [];
  const seenPair = new Map<string, GraphEdge>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // Links (undirected on screen; A→B and B→A become one thicker thread).
  for (const l of index.linkPairs(notebooks)) {
    if (!nodes.has(l.source) || !nodes.has(l.target)) continue;
    const k = pairKey(l.source, l.target);
    const cur = seenPair.get(k);
    if (cur) { cur.weight += l.count; continue; }
    const e: GraphEdge = { source: l.source, target: l.target, kind: 'link', weight: l.count };
    seenPair.set(k, e);
    edges.push(e);
  }

  if (showTags) {
    const noteNodes = [...nodes.values()];
    for (const n of noteNodes) {
      for (const t of n.tags) {
        const id = tagNodeId(t);
        let tn = nodes.get(id);
        if (!tn) {
          tn = { id, kind: 'tag', label: `#${t}`, tags: [t], createdAt: n.createdAt, updatedAt: n.updatedAt, degree: 0, pageCount: 0 };
          nodes.set(id, tn);
        }
        tn.createdAt = Math.min(tn.createdAt, n.createdAt);
        tn.updatedAt = Math.max(tn.updatedAt, n.updatedAt);
        edges.push({ source: n.id, target: id, kind: 'tag', weight: 1 });
      }
    }
  }

  if (showNotebooks) {
    const used = new Set<string>();
    for (const n of [...nodes.values()]) {
      if (n.kind !== 'note' || !n.notebookId) continue;
      used.add(n.notebookId);
      edges.push({ source: n.id, target: notebookNodeId(n.notebookId), kind: 'notebook', weight: 1 });
    }
    // Sub-notebooks hang off their parents so a nested notebook sits inside its parent's cloud.
    for (const id of [...used]) {
      let cur = nbById.get(id);
      while (cur?.parentId && nbById.has(cur.parentId)) {
        const parent = nbById.get(cur.parentId)!;
        if (!used.has(parent.id)) used.add(parent.id);
        cur = parent;
      }
    }
    for (const id of used) {
      const nb = nbById.get(id)!;
      const members = [...nodes.values()].filter((n) => n.kind === 'note' && n.notebookId === id);
      nodes.set(notebookNodeId(id), {
        id: notebookNodeId(id), kind: 'notebook', label: nb.name, notebookId: id, color: nb.color, tags: [],
        createdAt: Math.min(nb.createdAt, ...members.map((m) => m.createdAt)), updatedAt: Math.max(nb.createdAt, ...members.map((m) => m.updatedAt)), degree: 0, pageCount: 0,
      });
      if (nb.parentId && used.has(nb.parentId)) edges.push({ source: notebookNodeId(id), target: notebookNodeId(nb.parentId), kind: 'notebook', weight: 1 });
    }
  }

  if (opts.related) {
    const min = opts.relatedMin ?? 0.18;
    const per = opts.relatedPerNote ?? 3;
    for (const [id, list] of opts.related) {
      if (!nodes.has(id)) continue;
      let added = 0;
      for (const r of list) {
        if (added >= per) break;
        if (r.score < min || r.id === id || !nodes.has(r.id)) continue;
        const k = pairKey(id, r.id);
        if (seenPair.has(k)) continue;
        const e: GraphEdge = { source: id, target: r.id, kind: 'related', weight: r.score };
        seenPair.set(k, e);
        edges.push(e);
        added++;
      }
    }
  }

  for (const e of edges) {
    nodes.get(e.source)!.degree++;
    nodes.get(e.target)!.degree++;
  }

  // Clusters: one per top-level notebook, holding the notes of it and its sub-notebooks.
  const clusters = new Map<string, GraphCluster>();
  for (const n of nodes.values()) {
    if (n.kind === 'tag' || !n.notebookId) continue;
    const root = rootOf(notebooks, n.notebookId);
    if (!root) continue;
    n.cluster = root.id;
    if (n.kind !== 'note') continue;
    let c = clusters.get(root.id);
    if (!c) clusters.set(root.id, (c = { id: root.id, name: root.name, color: root.color, nodeIds: [] }));
    c.nodeIds.push(n.id);
  }

  return { nodes: [...nodes.values()], edges, clusters: [...clusters.values()] };
}
