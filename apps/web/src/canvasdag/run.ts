import { create } from 'zustand';
import {
  STICKY_COLORS,
  describeValue,
  extractGraph,
  isLocalOp,
  newId,
  parseOp,
  runDag,
  runLocalOp,
  valueFromText,
  type DagGraph,
  type DagNode,
  type DagValue,
  type ImageItem,
  type NodeRun,
  type NoteDocument,
  type PageObject,
  type StepInput,
  type StickyObject,
} from '@inkwright/core';
import type { AppVault } from '../lib/vault.ts';
import { readText } from '../smart/read.ts';
import { aiForNote, askOnce } from '../inkactions/ai.ts';
import { chartPng, dataTableObject } from '../datasandbox/data.ts';

/**
 * Executable canvas in the app: extract the graph from the lassoed diagram (reading labels that
 * are still unread handwriting), show it for confirmation, run it — local verbs on the device,
 * everything else through the guarded AI — and, when asked, keep the results on the page as
 * sticky notes, tables and chart images in one undo step.
 */

export interface CanvasRunState {
  pageIndex: number;
  graph: DagGraph | null;
  runs: Record<string, NodeRun>;
  phase: 'idle' | 'reading' | 'confirm' | 'running' | 'done';
  error?: string;
  controller: AbortController | null;
}

export const useCanvasRun = create<CanvasRunState>(() => ({ pageIndex: 0, graph: null, runs: {}, phase: 'idle', controller: null }));

export function closeCanvasRun() {
  useCanvasRun.getState().controller?.abort();
  useCanvasRun.setState({ graph: null, runs: {}, phase: 'idle', error: undefined, controller: null });
}

/** Builds the graph from a selection; unread handwritten labels are read on the device, else by the AI. */
export async function prepareCanvasRun(vault: AppVault, doc: NoteDocument, sel: { pageIndex: number; strokeIds: string[]; textIds: string[] }): Promise<DagGraph> {
  useCanvasRun.setState({ pageIndex: sel.pageIndex, graph: null, runs: {}, phase: 'reading', error: undefined });
  const page = doc.page(sel.pageIndex);
  const ids = new Set(sel.strokeIds);
  const tids = new Set(sel.textIds);
  const g = extractGraph({ strokes: page.strokes.filter((s) => ids.has(s.id)), texts: (page.texts ?? []).filter((t) => tids.has(t.id)), lines: page.recognizedLines ?? [] });
  if (g.nodes.length < 1) {
    useCanvasRun.setState({ phase: 'idle' });
    throw new Error('No boxes found in the selection. Draw a box around each step and arrows between them.');
  }
  for (const n of g.nodes) {
    if (n.label || !n.unreadStrokeIds.length) continue;
    const strokes = page.strokes.filter((s) => n.unreadStrokeIds.includes(s.id));
    const r = await readText(vault, doc, sel.pageIndex, strokes, true).catch(() => null);
    if (r?.text.trim()) { n.label = r.text.replace(/\s+/g, ' ').trim(); n.labelFrom = 'recognized'; }
  }
  useCanvasRun.setState({ graph: g, phase: 'confirm' });
  return g;
}

/** Fetches for `fetch <url>` steps: 15 s, 2 MB, http(s) only. Sent from this device (CORS applies). */
export async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; contentType: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  signal?.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: ac.signal, credentials: 'omit', redirect: 'follow' });
    } catch (e) {
      if (ac.signal.aborted && !signal?.aborted) throw new Error('No answer within 15 s');
      throw new Error(`Couldn't reach ${new URL(url).host} from the browser (offline, or the site doesn't allow cross-origin requests).`, { cause: e });
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'error'} from ${new URL(url).host}`);
    const reader = res.body?.getReader();
    if (!reader) return { text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) { void reader.cancel(); throw new Error('The response is larger than 2 MB'); }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return { text: new TextDecoder().decode(all), contentType: res.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(timer);
  }
}

const AGENT_SYSTEM = 'You are one step of a small pipeline the user drew on a page. Do exactly what the step says, using the inputs from the steps before it. Reply with the result only: a number, a short text, or a Markdown table for tabular results. No preamble.';

/** Runs one node: a local verb on the device, otherwise the AI with the upstream outputs. */
async function execNode(doc: NoteDocument, node: DagNode, inputs: StepInput[], signal: AbortSignal): Promise<DagValue> {
  const op = parseOp(node.label);
  if (!node.label.trim()) throw new Error('This box has no label to run');
  if (isLocalOp(op)) return runLocalOp(op, inputs.map((i) => i.value), { fetchText, signal });
  const ai = await aiForNote(doc.meta, { source: 'canvas', task: 'chat' });
  const body = [`Step: ${node.label}`, ...(inputs.length ? ['', 'Inputs:', ...inputs.map((i) => `## From “${i.label}”\n${describeValue(i.value, 60)}`)] : [])].join('\n');
  const reply = await askOnce(ai, AGENT_SYSTEM, body, signal, 1200);
  return valueFromText(reply);
}

/** Runs the confirmed graph, or one node again (`only`) from the outputs already shown. */
export async function runCanvas(doc: NoteDocument, only?: string): Promise<void> {
  const s = useCanvasRun.getState();
  if (!s.graph) return;
  const controller = new AbortController();
  const cached = Object.fromEntries(Object.entries(s.runs).map(([k, r]) => [k, r.output]));
  useCanvasRun.setState({ phase: 'running', controller, error: undefined });
  try {
    await runDag(s.graph, {
      exec: (node, inputs, signal) => execNode(doc, node, inputs, signal),
      signal: controller.signal,
      ...(only ? { only, cached } : {}),
      onUpdate: (id, run) => useCanvasRun.setState((st) => ({ runs: { ...st.runs, [id]: run } })),
    });
  } catch (e) {
    useCanvasRun.setState({ error: (e as Error).message });
  } finally {
    useCanvasRun.setState((st) => (st.controller === controller ? { phase: 'done', controller: null } : st));
  }
}

export function cancelCanvasRun() {
  useCanvasRun.getState().controller?.abort();
}

/**
 * Keeps the results on the page beside their boxes: text and numbers as sticky notes, tables as
 * table objects, charts as images — one commit, so one undo removes them all. Agent results are
 * marked `origin: 'ai'`, on-device ones `solver`.
 */
export async function keepResults(vault: AppVault, doc: NoteDocument): Promise<number> {
  const { graph, runs, pageIndex } = useCanvasRun.getState();
  if (!graph) return 0;
  const objects: PageObject[] = [];
  const images: ImageItem[] = [];
  for (const n of graph.nodes) {
    const r = runs[n.id];
    if (r?.status !== 'done' || !r.output) continue;
    const origin = isLocalOp(parseOp(n.label)) ? 'solver' : 'ai';
    const x = n.rect.maxX + 16, y = n.rect.minY;
    const v = r.output;
    if (v.kind === 'chart') {
      const png = await chartPng(v.spec, { columns: v.columns, rows: v.rows }, 360, 230);
      const asset = vault.newAssetName('png');
      await vault.vault.writeAsset(doc.meta.id, asset, png.bytes);
      images.push({ id: newId(), x, y, width: 270, height: 172, asset, rotation: 0, createdAt: Date.now(), origin: origin === 'ai' ? 'ai' : 'solver' });
    } else if (v.kind === 'table') {
      objects.push(dataTableObject({ columns: v.columns, rows: v.rows, x, y, origin: 'solver', data: { asset: '', table: 'result', rowCount: v.rows.length, columns: v.columns.map((name) => ({ name, type: 'text' })) }, maxRows: 6, maxCols: 4 }));
    } else {
      const text = describeValue(v).slice(0, 400);
      const sticky: StickyObject = { id: newId(), type: 'sticky', x, y, width: 180, height: Math.min(220, 60 + Math.ceil(text.length / 24) * 16), color: STICKY_COLORS[2], text, createdAt: Date.now(), origin };
      objects.push(sticky);
    }
  }
  if (!objects.length && !images.length) return 0;
  const page = doc.page(pageIndex);
  const o0 = (page.objects ?? []).length, i0 = (page.images ?? []).length;
  doc.commit(pageIndex, {
    label: 'Diagram results',
    objects: { removed: [], added: objects.map((item, k) => ({ index: o0 + k, item })) },
    images: { removed: [], added: images.map((item, k) => ({ index: i0 + k, item })) },
  }, 'other');
  return objects.length + images.length;
}
