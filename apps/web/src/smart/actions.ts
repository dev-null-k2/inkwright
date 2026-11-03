import {
  autoView, boundsOfStrokes, emptyCells, fitTableToInk, newId, objectRect, pageSizeOf, relayoutStrokes, strokesByCell,
  tableFromCandidate, isInfinite, type GraphObject, type MathObject, type NoteDocument, type Rect,
  type TableCandidate, type TableEdit, type TableObject, type TextBox,
} from '@inkwright/core';
import type { AppVault } from '../lib/vault.ts';
import { recognizeLocally } from '../lib/recognition.ts';
import { findEvent, findLinks, findTasks, tasksToMarkdown } from './detect.ts';
import { solveMath, type MathSolution } from './math.ts';
import { readMath, readMathWithAI, readTableCells, readText, strongVisionAI, type MathReading } from './read.ts';
import type { ReadCard } from './store.ts';

/**
 * What the smart-ink suggestions do to a note. Every change goes through the document (one undo
 * step each, labelled), so "Undo" always puts the ink back exactly as written.
 */

export interface SmartCtx {
  doc: NoteDocument;
  vault: AppVault;
}

const GRAPH_COLORS = ['#FF2F6FB5', '#FFB8432F', '#FF3D7A3A', '#FF7A3E9D', '#FFD9822B'];

// ---- Tables ----------------------------------------------------------------------------------------

/** Replaces a drawn grid with a table object (one undo step). */
export function makeTable(doc: NoteDocument, pageIndex: number, c: TableCandidate): TableObject {
  const t = tableFromCandidate(c, newId(), Date.now());
  doc.editObjects(pageIndex, 'Make a table', { upsert: [t], removeStrokes: new Set(c.strokeIds) });
  return t;
}

export function tableById(doc: NoteDocument, pageIndex: number, id: string): TableObject | null {
  const o = doc.page(pageIndex).objects?.find((x) => x.id === id);
  return o?.type === 'table' ? o : null;
}

/** Applies a structural edit to a table, moving (or removing) the ink of its cells with it. */
export function applyTableEdit(doc: NoteDocument, pageIndex: number, before: TableObject, edit: TableEdit | null, label: string, undoable = true): void {
  if (!edit) return;
  const { moved, removed } = relayoutStrokes(before, edit, doc.page(pageIndex).strokes);
  doc.editObjects(pageIndex, label, { upsert: [edit.table], replaceStrokes: moved, removeStrokes: removed }, { undoable });
}

export function setCellText(doc: NoteDocument, pageIndex: number, t: TableObject, r: number, c: number, text: string): void {
  const cur = t.cells[r]?.[c]?.text ?? '';
  if (cur === text.trim()) return;
  const cells = t.cells.map((row, i) => row.map((cell, j) => (i === r && j === c ? { ...cell, text: text.trim() || undefined } : cell)));
  doc.editObjects(pageIndex, 'Type in table', { upsert: [{ ...t, cells }] });
}

export function deleteTable(doc: NoteDocument, pageIndex: number, t: TableObject, keepInk: boolean): void {
  const ink = keepInk ? new Set<string>() : new Set([...strokesByCell(t, doc.page(pageIndex).strokes).values()].flat().map((s) => s.id));
  doc.editObjects(pageIndex, 'Delete table', { removeObjects: new Set([t.id]), removeStrokes: ink });
}

/**
 * After writing pauses: tables grow so the ink in each cell fits (not an undo step of its own),
 * and cells whose ink changed are read on the device when a local recognizer exists.
 */
export async function tableInkPass(doc: NoteDocument, pageIndex: number, changed: ReadonlySet<string>): Promise<void> {
  for (const o of doc.page(pageIndex).objects ?? []) {
    if (o.type !== 'table') continue;
    const page = doc.page(pageIndex);
    const by = strokesByCell(o, page.strokes);
    const touched = [...by.entries()].filter(([, list]) => list.some((s) => changed.has(s.id)));
    if (!touched.length) continue;
    applyTableEdit(doc, pageIndex, o, fitTableToInk(o, page.strokes), 'Fit table', false);
    const t = tableById(doc, pageIndex, o.id);
    if (!t) continue;
    const by2 = strokesByCell(t, doc.page(pageIndex).strokes);
    const cells = t.cells.map((row) => row.map((c) => ({ ...c })));
    let any = false;
    for (const [k] of touched) {
      const list = by2.get(k);
      const [r, c] = k.split(',').map(Number) as [number, number];
      if (!list?.length || !cells[r]?.[c]) continue;
      const res = await recognizeLocally(list).catch(() => null);
      if (!res) return; // no on-device recognizer: cells are read on request ("Read cells")
      cells[r]![c]!.recognized = res.text.replace(/\s+/g, ' ').trim() || undefined;
      any = true;
    }
    const latest = tableById(doc, pageIndex, t.id);
    if (any && latest) doc.editObjects(pageIndex, 'Read table', { upsert: [{ ...latest, cells: mergeRecognized(latest, cells) }] }, { undoable: false });
  }
}

function mergeRecognized(t: TableObject, cells: TableObject['cells']): TableObject['cells'] {
  return t.cells.map((row, r) => row.map((cell, c) => ({ ...cell, recognized: cells[r]?.[c]?.recognized ?? cell.recognized })));
}

/** Reads every cell that has ink (on-device, or the AI when allowed) into the table. */
export async function readTable(ctx: SmartCtx, pageIndex: number, t: TableObject, allowAI: boolean): Promise<number> {
  const by = strokesByCell(t, ctx.doc.page(pageIndex).strokes);
  if (!by.size) return 0;
  const cells = emptyCells(t.rows.length, t.cols.length);
  let n = 0;
  const local = await recognizeLocally([...by.values()][0]!).catch(() => null);
  if (local) {
    for (const [k, list] of by) {
      const [r, c] = k.split(',').map(Number) as [number, number];
      const res = await recognizeLocally(list);
      if (res?.text.trim()) { cells[r]![c]!.recognized = res.text.replace(/\s+/g, ' ').trim(); n++; }
    }
  } else if (allowAI) {
    const read = await readTableCells(ctx.vault, ctx.doc, pageIndex, t);
    for (const [k] of by) {
      const [r, c] = k.split(',').map(Number) as [number, number];
      const v = read[r]?.[c]?.trim();
      if (v) { cells[r]![c]!.recognized = v; n++; }
    }
  } else throw new Error('Reading table cells needs on-device recognition (Android app) or an AI with vision.');
  const latest = tableById(ctx.doc, pageIndex, t.id);
  if (latest && n) ctx.doc.editObjects(pageIndex, 'Read table', { upsert: [{ ...latest, cells: mergeRecognized(latest, cells) }] }, { undoable: false });
  return n;
}

// ---- Maths -----------------------------------------------------------------------------------------

export interface SolveOutcome {
  obj: MathObject;
  solution: MathSolution | null;
  /** The AI read the handwriting (and may have given steps). */
  aiRead: boolean;
}

/**
 * Reads the handwritten problem on this device, solves it with the on-device CAS and writes the
 * result next to it as a result object. A strong vision AI is asked only when the on-device
 * reading is unsure (read.ts), or when the solver cannot do the problem — and then the result
 * says the AI was involved.
 */
export async function solveInk(ctx: SmartCtx, pageIndex: number, strokeIds: readonly string[], after: Rect): Promise<SolveOutcome> {
  const page = ctx.doc.page(pageIndex);
  const ids = new Set(strokeIds);
  const strokes = page.strokes.filter((s) => ids.has(s.id));
  if (!strokes.length) throw new Error('Nothing to solve');
  let reading: MathReading = await readMath(ctx.vault, ctx.doc, pageIndex, strokes);
  if (!reading.plain.trim()) throw new Error('No maths found in that writing');
  let solution: MathSolution | null = null;
  let result: string;
  try {
    solution = await solveMath(reading.plain);
    result = solution.result;
  } catch (e) {
    // The solver can't do it: only now, and only a strong AI, may help — read and answer it.
    if (reading.by === 'local') {
      const ai = await strongVisionAI(ctx.doc);
      const viaAI = ai ? await readMathWithAI(ctx.vault, ctx.doc, pageIndex, strokes, ai).catch(() => null) : null;
      if (viaAI?.plain) {
        reading = viaAI;
        solution = await solveMath(viaAI.plain).catch(() => null);
      }
    }
    if (solution) result = solution.result;
    else if (reading.answer) result = reading.answer.startsWith('=') || /^[a-z]\s*=/.test(reading.answer) ? reading.answer : `= ${reading.answer}`;
    else throw new Error(`${(e as Error).message}. Read as “${reading.plain}” (${reading.source}).`);
  }
  const b = boundsOfStrokes(strokes);
  const fontSize = Math.max(14, Math.min(34, (b.maxY - b.minY) * 0.8));
  const steps = solution?.steps?.length ? solution.steps : reading.steps;
  const obj: MathObject = {
    type: 'math', id: newId(), createdAt: Date.now(),
    x: after.maxX + fontSize * 0.45, y: (after.minY + after.maxY) / 2 - fontSize * 0.75,
    input: reading.plain, latex: reading.latex, result, steps, fontSize,
    color: strokes[strokes.length - 1]!.color, source: [...ids],
    // The page shows a machine-made answer either way; with AI involved it says so.
    origin: reading.by === 'ai' ? 'ai' : 'solver',
    readBy: reading.source,
    stepsBy: steps?.length ? (solution?.steps?.length ? 'solver' : 'ai') : undefined,
  };
  ctx.doc.editObjects(pageIndex, 'Solve', { upsert: [obj] });
  return { obj, solution, aiRead: reading.by === 'ai' };
}

/** Plots functions: adds them to the graph nearest `near` on the page, or makes a new graph below it. */
export function plotFunctions(doc: NoteDocument, pageIndex: number, fns: { expr: string; label: string }[], near: Rect): GraphObject {
  const page = doc.page(pageIndex);
  const graphs = (page.objects ?? []).filter((o): o is GraphObject => o.type === 'graph');
  const dist = (g: GraphObject) => { const r = objectRect(g); return Math.hypot(Math.max(0, r.minX - near.maxX, near.minX - r.maxX), Math.max(0, r.minY - near.maxY, near.minY - r.maxY)); };
  const target = graphs.filter((g) => dist(g) < 360).sort((a, b) => dist(a) - dist(b))[0];
  if (target) {
    const have = new Set(target.functions.map((f) => f.expr.replace(/\s+/g, '')));
    const add = fns.filter((f) => !have.has(f.expr.replace(/\s+/g, '')));
    const functions = [...target.functions, ...add.map((f, i) => ({ expr: f.expr, label: f.label, color: GRAPH_COLORS[(target.functions.length + i) % GRAPH_COLORS.length]! }))];
    const g = { ...target, functions };
    doc.editObjects(pageIndex, 'Add to graph', { upsert: [g] });
    return g;
  }
  const size = pageSizeOf(doc.meta, page);
  const w = 320, h = 220;
  let x = near.minX, y = near.maxY + 18;
  if (!isInfinite(size)) {
    x = Math.max(16, Math.min(size.width - w - 16, x));
    if (y + h > size.height - 16) y = Math.max(16, near.minY - h - 18);
  }
  const g: GraphObject = { type: 'graph', id: newId(), x, y, width: w, height: h, createdAt: Date.now(), origin: 'solver', view: autoView(fns.map((f) => f.expr)), functions: fns.map((f, i) => ({ expr: f.expr, label: f.label, color: GRAPH_COLORS[i % GRAPH_COLORS.length]! })) };
  doc.editObjects(pageIndex, 'Plot', { upsert: [g] });
  return g;
}

// ---- Circled / lassoed writing ----------------------------------------------------------------------

/** Reads writing and works out what it can do: calendar event, links, tasks. */
export async function readForActions(ctx: SmartCtx, pageIndex: number, strokeIds: readonly string[], allowAI: boolean): Promise<ReadCard | null> {
  const page = ctx.doc.page(pageIndex);
  const ids = new Set(strokeIds);
  const strokes = page.strokes.filter((s) => ids.has(s.id));
  if (!strokes.length) return null;
  const read = await readText(ctx.vault, ctx.doc, pageIndex, strokes, allowAI);
  if (!read) return null;
  const text = read.text.trim();
  return { kind: 'read', pageIndex, anchor: boundsOfStrokes(strokes), text, event: findEvent(text), links: findLinks(text), tasks: findTasks(text) };
}

/** A typed checklist (Markdown task list) next to the writing it came from. */
export function addChecklist(doc: NoteDocument, pageIndex: number, items: { text: string; done: boolean }[], at: Rect, color: string, replace?: Set<string>): TextBox {
  const box: TextBox = { id: newId(), x: at.minX, y: replace ? at.minY : at.maxY + 12, width: Math.max(200, at.maxX - at.minX), text: tasksToMarkdown(items), fontSize: 17, color, font: 'sans', createdAt: Date.now(), origin: 'recognized' };
  const page = doc.page(pageIndex);
  doc.commit(pageIndex, {
    label: 'Make a checklist',
    texts: { removed: [], added: [{ index: (page.texts ?? []).length, item: box }] },
    strokes: replace?.size ? { removed: page.strokes.map((s, i) => ({ index: i, item: s })).filter((x) => replace.has(x.item.id)), added: [] } : undefined,
  });
  return box;
}

/** Reads each handwritten checklist line (box + writing) into one typed checklist. */
export async function checklistFromInk(ctx: SmartCtx, pageIndex: number, items: { boxId: string; checked: boolean; textIds: string[] }[], allowAI: boolean): Promise<TextBox | null> {
  const page = ctx.doc.page(pageIndex);
  const out: { text: string; done: boolean }[] = [];
  const all = new Set<string>();
  for (const it of items) {
    const strokes = page.strokes.filter((s) => it.textIds.includes(s.id));
    const r = await readText(ctx.vault, ctx.doc, pageIndex, strokes, allowAI);
    if (!r) return null;
    out.push({ text: r.text.replace(/\s+/g, ' ').trim() || '…', done: it.checked });
    all.add(it.boxId);
    it.textIds.forEach((id) => all.add(id));
  }
  // Ticks inside boxes go too.
  const inBoxes = page.strokes.filter((s) => !all.has(s.id) && items.some((it) => { const box = page.strokes.find((x) => x.id === it.boxId); if (!box) return false; const b = boundsOfStrokes([box]), sb = boundsOfStrokes([s]); return sb.minX >= b.minX - 6 && sb.maxX <= b.maxX + 10 && sb.minY >= b.minY - 12 && sb.maxY <= b.maxY + 6; }));
  inBoxes.forEach((s) => all.add(s.id));
  const strokes = page.strokes.filter((s) => all.has(s.id));
  return addChecklist(ctx.doc, pageIndex, out, boundsOfStrokes(strokes), strokes.find((s) => !items.some((i) => i.boxId === s.id))?.color ?? '#FF1B1F24', all);
}

