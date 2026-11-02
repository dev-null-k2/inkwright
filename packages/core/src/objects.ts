import type { Rect } from './geometry.ts';
import type { ContentOrigin, InkStroke } from './model.ts';
import { boundsOfStrokes, strokeBounds, translateStroke } from './gestures.ts';
import { overlayRect, overlaysText, type StickyObject, type TapeObject } from './overlays.ts';
import { diagramText, type DiagramObject } from './dev/diagram.ts';

/**
 * Live page objects made from ink ("ink that does things"): a hand-drawn grid becomes a real
 * table, a written equation gets its solution, a function gets a graph. They live in
 * `PageInk.objects` (see docs/VAULT_FORMAT.md), are drawn under the ink, and never pretend to be
 * handwriting: solved results and graphs carry an `origin`.
 */
export type PageObject = TableObject | MathObject | GraphObject | StickyObject | TapeObject | DiagramObject;

interface ObjectBase {
  id: string;
  /** Top-left corner in page units. */
  x: number;
  y: number;
  createdAt: number;
  origin?: ContentOrigin;
}

/** One table cell: typed text, and the text recognized from the ink written into it. */
export interface TableCell {
  text?: string;
  recognized?: string;
}

/**
 * A table. The grid is the object; ink written in a cell stays an ordinary page stroke and
 * belongs to the cell its centre falls in (see `cellOfStroke`), so erasing, lasso, undo, sync and
 * export treat it like any other handwriting, and it moves with its cell when rows or columns
 * change.
 */
export interface TableObject extends ObjectBase {
  type: 'table';
  /** Column widths, left to right (page units). */
  cols: number[];
  /** Row heights, top to bottom. */
  rows: number[];
  /** `cells[row][col]`; always rows.length × cols.length. */
  cells: TableCell[][];
  /** Grid colour `#AARRGGBB` (the pen that drew it). */
  color: string;
  lineWidth: number;
  /** The first row is a header row (typed text drawn bold, a heavier rule under it). */
  header?: boolean;
}

/** A solved equation or evaluated expression, shown next to the handwriting it came from. */
export interface MathObject extends ObjectBase {
  type: 'math';
  /** What was read from the handwriting, as plain maths ("2x+3=7"). */
  input: string;
  /** The same as LaTeX, when the recognizer gave it. */
  latex?: string;
  /** The answer shown on the page ("x = 2"). */
  result: string;
  /** Worked steps, when an AI explained them. */
  steps?: string[];
  fontSize: number;
  color: string;
  /** Strokes of the handwritten problem (informational; the result does not follow them). */
  source?: string[];
  origin: 'solver' | 'ai';
}

/** A live function plot: y = f(x) for each function, over a view window. */
export interface GraphObject extends ObjectBase {
  type: 'graph';
  width: number;
  height: number;
  functions: GraphFunction[];
  view: { xMin: number; xMax: number; yMin: number; yMax: number };
  origin: 'solver';
}

export interface GraphFunction {
  /** Right-hand side in x, plain maths ("x^2 - 2x + 1"). */
  expr: string;
  /** `#AARRGGBB`. */
  color: string;
  /** Shown in the legend ("f(x)", "y"). */
  label?: string;
}

// ---- Geometry -------------------------------------------------------------------------------------

export function objectRect(o: PageObject): Rect {
  if (o.type === 'sticky' || o.type === 'tape') return overlayRect(o);
  if (o.type === 'table') return tableRect(o);
  if (o.type === 'graph' || o.type === 'diagram') return { minX: o.x, minY: o.y, maxX: o.x + o.width, maxY: o.y + o.height };
  return { minX: o.x, minY: o.y, maxX: o.x + mathWidth(o), maxY: o.y + o.fontSize * 1.5 };
}

/** Approximate width of a math result (handwriting-style font, ~0.5 em per glyph). */
export function mathWidth(o: Pick<MathObject, 'result' | 'fontSize'>): number {
  return Math.max(o.fontSize, o.result.length * o.fontSize * 0.5 + o.fontSize * 0.6);
}

const sum = (a: readonly number[]) => a.reduce((s, v) => s + v, 0);

export function tableRect(t: TableObject): Rect {
  return { minX: t.x, minY: t.y, maxX: t.x + sum(t.cols), maxY: t.y + sum(t.rows) };
}

/** x of every vertical rule (cols+1 values), left to right. */
export function colEdges(t: Pick<TableObject, 'x' | 'cols'>): number[] {
  const out = [t.x];
  for (const w of t.cols) out.push(out[out.length - 1]! + w);
  return out;
}

/** y of every horizontal rule (rows+1 values), top to bottom. */
export function rowEdges(t: Pick<TableObject, 'y' | 'rows'>): number[] {
  const out = [t.y];
  for (const h of t.rows) out.push(out[out.length - 1]! + h);
  return out;
}

export function cellRect(t: TableObject, r: number, c: number): Rect {
  const xs = colEdges(t), ys = rowEdges(t);
  return { minX: xs[c]!, minY: ys[r]!, maxX: xs[c + 1]!, maxY: ys[r + 1]! };
}

export interface CellRef { r: number; c: number }

/** The cell containing a page point, or null outside the table. */
export function cellAt(t: TableObject, x: number, y: number): CellRef | null {
  const xs = colEdges(t), ys = rowEdges(t);
  if (x < xs[0]! || x > xs[xs.length - 1]! || y < ys[0]! || y > ys[ys.length - 1]!) return null;
  let c = 0, r = 0;
  while (c < t.cols.length - 1 && x > xs[c + 1]!) c++;
  while (r < t.rows.length - 1 && y > ys[r + 1]!) r++;
  return { r, c };
}

/** The cell a stroke belongs to: where the centre of its bounds is (null when outside). */
export function cellOfStroke(t: TableObject, s: InkStroke): CellRef | null {
  if (!s.points.length) return null;
  const b = strokeBounds(s);
  return cellAt(t, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
}

/** Strokes written in the table, by cell key `"r,c"`. */
export function strokesByCell(t: TableObject, strokes: readonly InkStroke[]): Map<string, InkStroke[]> {
  const out = new Map<string, InkStroke[]>();
  for (const s of strokes) {
    if (s.origin) continue;
    const cell = cellOfStroke(t, s);
    if (!cell) continue;
    const k = `${cell.r},${cell.c}`;
    const list = out.get(k);
    if (list) list.push(s);
    else out.set(k, [s]);
  }
  return out;
}

export function emptyCells(rows: number, cols: number): TableCell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({})));
}

/** What a cell says: typed text first, else what was recognized from its ink. */
export function cellText(cell: TableCell | undefined): string {
  return (cell?.text ?? cell?.recognized ?? '').trim();
}

// ---- Editing --------------------------------------------------------------------------------------

/**
 * The result of changing a table's structure: the new table and, for every old cell, where its
 * content went (null: the cell was removed). `relayoutStrokes` applies it to the cell ink.
 */
export interface TableEdit {
  table: TableObject;
  cellMap: (r: number, c: number) => CellRef | null;
}

const MIN_CELL = 14;

export function insertRow(t: TableObject, at: number, height?: number): TableEdit {
  const i = Math.max(0, Math.min(t.rows.length, at));
  const h = height ?? t.rows[Math.min(i, t.rows.length - 1)] ?? 32;
  const rows = [...t.rows.slice(0, i), h, ...t.rows.slice(i)];
  const cells = [...t.cells.slice(0, i), t.cols.map(() => ({})), ...t.cells.slice(i)];
  return { table: { ...t, rows, cells }, cellMap: (r, c) => ({ r: r >= i ? r + 1 : r, c }) };
}

export function insertCol(t: TableObject, at: number, width?: number): TableEdit {
  const i = Math.max(0, Math.min(t.cols.length, at));
  const w = width ?? t.cols[Math.min(i, t.cols.length - 1)] ?? 80;
  const cols = [...t.cols.slice(0, i), w, ...t.cols.slice(i)];
  const cells = t.cells.map((row) => [...row.slice(0, i), {}, ...row.slice(i)]);
  return { table: { ...t, cols, cells }, cellMap: (r, c) => ({ r, c: c >= i ? c + 1 : c }) };
}

export function removeRow(t: TableObject, at: number): TableEdit | null {
  if (t.rows.length <= 1 || at < 0 || at >= t.rows.length) return null;
  const rows = t.rows.filter((_, k) => k !== at);
  const cells = t.cells.filter((_, k) => k !== at);
  return { table: { ...t, rows, cells }, cellMap: (r, c) => (r === at ? null : { r: r > at ? r - 1 : r, c }) };
}

export function removeCol(t: TableObject, at: number): TableEdit | null {
  if (t.cols.length <= 1 || at < 0 || at >= t.cols.length) return null;
  const cols = t.cols.filter((_, k) => k !== at);
  const cells = t.cells.map((row) => row.filter((_, k) => k !== at));
  return { table: { ...t, cols, cells }, cellMap: (r, c) => (c === at ? null : { r, c: c > at ? c - 1 : c }) };
}

/** Sets one column width or row height (dragging a rule); never smaller than a minimum cell. */
export function resizeTrack(t: TableObject, kind: 'row' | 'col', index: number, size: number): TableEdit {
  const s = Math.max(MIN_CELL, size);
  const table = kind === 'row' ? { ...t, rows: t.rows.map((h, k) => (k === index ? s : h)) } : { ...t, cols: t.cols.map((w, k) => (k === index ? s : w)) };
  return { table, cellMap: (r, c) => ({ r, c }) };
}

/** Moves the whole table (and, through `relayoutStrokes`, its ink). */
export function moveTable(t: TableObject, dx: number, dy: number): TableEdit {
  return { table: { ...t, x: t.x + dx, y: t.y + dy }, cellMap: (r, c) => ({ r, c }) };
}

/**
 * Grows rows and columns so the ink written in each cell fits inside it with a little margin —
 * a cell's handwriting stays inside its cell however much is written.
 */
export function fitTableToInk(t: TableObject, strokes: readonly InkStroke[], pad = 6): TableEdit | null {
  const by = strokesByCell(t, strokes);
  const rows = [...t.rows], cols = [...t.cols];
  let grew = false;
  for (const [k, list] of by) {
    const [r, c] = k.split(',').map(Number) as [number, number];
    const cr = cellRect(t, r, c);
    const b = boundsOfStrokes(list);
    const needH = b.maxY + pad - cr.minY;
    const needW = b.maxX + pad - cr.minX;
    if (needH > rows[r]! + 0.5) { rows[r] = needH; grew = true; }
    if (needW > cols[c]! + 0.5) { cols[c] = needW; grew = true; }
  }
  if (!grew) return null;
  return { table: { ...t, rows, cols }, cellMap: (r, c) => ({ r, c }) };
}

/**
 * Moves cell ink to follow a table edit: every stroke shifts by how far its cell's top-left
 * corner moved; ink of removed cells is returned in `removed`. Strokes outside the table are
 * untouched (not returned).
 */
export function relayoutStrokes(before: TableObject, edit: TableEdit, strokes: readonly InkStroke[]): { moved: Map<string, InkStroke>; removed: Set<string> } {
  const moved = new Map<string, InkStroke>();
  const removed = new Set<string>();
  for (const s of strokes) {
    if (s.origin) continue;
    const cell = cellOfStroke(before, s);
    if (!cell) continue;
    const to = edit.cellMap(cell.r, cell.c);
    if (!to) { removed.add(s.id); continue; }
    const a = cellRect(before, cell.r, cell.c);
    const b = cellRect(edit.table, to.r, to.c);
    const dx = b.minX - a.minX, dy = b.minY - a.minY;
    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) moved.set(s.id, translateStroke(s, dx, dy));
  }
  return { moved, removed };
}

// ---- Text export ---------------------------------------------------------------------------------

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

/** GitHub-flavoured Markdown table. The first row is the header (Markdown needs one). */
export function tableToMarkdown(t: TableObject, text: (r: number, c: number) => string = (r, c) => cellText(t.cells[r]?.[c])): string {
  const lines: string[] = [];
  for (let r = 0; r < t.rows.length; r++) {
    lines.push(`| ${t.cols.map((_, c) => mdCell(text(r, c)) || ' ').join(' | ')} |`);
    if (r === 0) lines.push(`| ${t.cols.map(() => '---').join(' | ')} |`);
  }
  return lines.join('\n');
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** RFC 4180 CSV (CRLF line ends). */
export function tableToCsv(t: TableObject, text: (r: number, c: number) => string = (r, c) => cellText(t.cells[r]?.[c])): string {
  const lines: string[] = [];
  for (let r = 0; r < t.rows.length; r++) lines.push(t.cols.map((_, c) => csvCell(text(r, c).trim())).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Plain text of objects for search, `note.md` and agents. */
export function objectsText(objects: readonly PageObject[] | undefined): string {
  const out: string[] = [];
  for (const o of objects ?? []) {
    if (o.type === 'table') out.push(tableToMarkdown(o));
    else if (o.type === 'math') out.push(`${o.input} → ${o.result}`);
    else if (o.type === 'graph') out.push(o.functions.map((f) => `${f.label ?? 'y'} = ${f.expr}`).join('\n'));
    else if (o.type === 'diagram') out.push(diagramText(o.ir));
  }
  const sticky = overlaysText(objects);
  if (sticky) out.push(sticky);
  return out.join('\n\n');
}

/** Shift of every object by (dx, dy) — used when a page's content moves as a whole. */
export function translateObject<T extends PageObject>(o: T, dx: number, dy: number): T {
  return { ...o, x: o.x + dx, y: o.y + dy };
}
