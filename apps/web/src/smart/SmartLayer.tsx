import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CalendarPlus, ChartSpline, Check, Copy, Columns3, Download, ExternalLink, Heading, ListChecks, Mail, Minus, Phone, Plus, Rows3,
  ScanText, Sigma, Table2, Trash2, X, ZoomIn, ZoomOut, Maximize, Link as LinkIcon,
} from 'lucide-react';
import {
  asFunctionOfX, autoView, boundsOfStrokes, cellRect, colEdges, detectChecklist, detectEnclosure, detectTable, detectTrailingEquals,
  insertCol, insertRow, moveTable, panView, removeCol, removeRow, resizeTrack, rowEdges, tableToCsv, tableToMarkdown,
  zoomView, type ChecklistItemCue, type GraphObject, type MathObject, type NoteDocument, type Rect, type TableCandidate, type TableObject,
} from '@inkstone/core';
import type { InkEngine, Tool } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { InkstoneNative, hasNativePlugin } from '../platform/native.ts';
import { saveFile } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { Dialog, Menu, Popover, cx } from '../ui/primitives.tsx';
import { askText } from '../ui/prompts.tsx';
import { applyTableEdit, checklistFromInk, deleteTable, makeTable, plotFunctions, readForActions, readTable, setCellText, solveInk, tableById, tableInkPass, addChecklist, type SmartCtx } from './actions.ts';
import { describeWhen } from './detect.ts';
import { buildIcs, googleCalendarUrl, icsFileName } from './ics.ts';
import { canRead, canReadAutomatically } from './read.ts';
import { useSmart, type ReadCard } from './store.ts';

/**
 * Smart ink: the calm layer that notices what fresh ink could become and offers it once.
 *  - After the pen rests (~1 s), the newest writing is checked for a drawn grid ("Make a table"),
 *    an "=" at the end of a line ("Solve"), a loop around writing (dates → calendar, phone
 *    numbers, emails, links) and handwritten checkboxes ("Make a checklist"). At most one quiet
 *    chip appears beside the ink; writing on or tapping × dismisses it. Settings › Pen & touch ›
 *    "Smart ink suggestions" turns this off.
 *  - Tables, solved results and graphs on the page get small handles here; the canvas draws them.
 */

export interface SmartApi {
  /** The text tool tapped at a page point: type into the table cell there instead (true if handled). */
  editCellAt(pageIndex: number, x: number, y: number): boolean;
  solveSelection(): void;
  readSelection(): void;
  tableFromSelection(): void;
}

type Chip = { key: string; pageIndex: number; anchor: Rect; label: string; icon: 'table' | 'solve' | 'read' | 'checklist'; run: () => Promise<void> | void };

const PAUSE_MS = 1000;
const RECENT_MS = 90_000;
const strokeEnd = (s: { createdAt: number; points: { t: number }[] }) => s.createdAt + (s.points[s.points.length - 1]?.t ?? 0);

export interface SmartLayerProps {
  doc: NoteDocument;
  engine: InkEngine;
  vault: AppVault;
  host: HTMLElement;
  tool: Tool;
  /** Re-render trigger: the editor's viewport state. */
  view: unknown;
  apiRef: { current: SmartApi | null };
}

export function SmartLayer({ doc, engine, vault, host, tool, apiRef }: SmartLayerProps) {
  const { toast } = useApp();
  const suggestions = useSettings((s) => s.smartInk.suggestions);
  const { card, setCard, busy, setBusy } = useSmart();
  const [chip, setChip] = useState<Chip | null>(null);
  const [activeTable, setActiveTable] = useState<{ pageIndex: number; id: string; r: number; c: number } | null>(null);
  const [cellEdit, setCellEdit] = useState<{ pageIndex: number; id: string; r: number; c: number; value: string } | null>(null);
  const [mathMenu, setMathMenu] = useState<{ pageIndex: number; id: string; el: HTMLElement } | null>(null);
  const [steps, setSteps] = useState<{ pageIndex: number; id: string } | null>(null);
  const [activeGraph, setActiveGraph] = useState<{ pageIndex: number; id: string } | null>(null);
  const [copyMenu, setCopyMenu] = useState<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{ kind: 'move' | 'col' | 'row' | 'size'; index: number; dx: number; dy: number } | null>(null);
  const dismissed = useRef(new Set<string>());
  const ctx: SmartCtx = useMemo(() => ({ doc, vault }), [doc, vault]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast({ text: (e as Error).message, tone: 'error' }); } finally { setBusy(null); }
  };

  // ---- Noticing fresh ink ----------------------------------------------------------------------------
  const analyzeRef = useRef<(pageIndex: number, fresh: Set<string>) => void>(() => {});
  analyzeRef.current = (pageIndex, fresh) => {
    void tableInkPass(doc, pageIndex, fresh);
    if (!useSettings.getState().smartInk.suggestions) return;
    const page = doc.page(pageIndex);
    if (!page) return;
    const now = Date.now();
    const hand = page.strokes.filter((s) => s.input && !s.origin);
    const recent = hand.filter((s) => now - strokeEnd(s) < RECENT_MS);
    if (!recent.length) return;
    const offer = (c: Chip) => { if (!dismissed.current.has(c.key)) setChip(c); };

    const grid: TableCandidate | null = detectTable(recent, page.strokes);
    if (grid) {
      return offer({ key: `table:${grid.strokeIds.join(',')}`, pageIndex, anchor: grid.rect, label: 'Make a table', icon: 'table', run: () => {
        const t = makeTable(doc, pageIndex, grid);
        toast({ text: `Made a ${t.rows.length} × ${t.cols.length} table — write in its cells`, action: { label: 'Undo', run: () => engine.undo() } });
      } });
    }
    const eq = detectTrailingEquals(hand);
    if (eq && fresh.has(eq.equalsIds[1]) ) {
      return offer({ key: `solve:${eq.equalsIds.join(',')}`, pageIndex, anchor: eq.equalsRect, label: 'Solve', icon: 'solve', run: () => run('Solving…', async () => {
        const out = await solveInk(ctx, pageIndex, eq.problemIds, eq.equalsRect);
        announceSolved(out.obj);
      }) });
    }
    const enc = detectEnclosure(hand);
    if (enc && fresh.has(enc.loopId)) {
      const key = `read:${enc.loopId}`;
      if (dismissed.current.has(key)) return;
      void (async () => {
        const auto = await canReadAutomatically();
        if (auto) {
          const c = await readForActions(ctx, pageIndex, enc.enclosedIds, auto === 'ai').catch(() => null);
          if (c && (c.event || c.links.length || c.tasks)) setCard(c);
        } else if (await canRead()) {
          offer({ key, pageIndex, anchor: enc.rect, label: 'Read circled writing', icon: 'read', run: () => run('Reading…', async () => {
            const c = await readForActions(ctx, pageIndex, enc.enclosedIds, true);
            if (c) setCard(c);
          }) });
        }
      })();
      return;
    }
    const list: ChecklistItemCue[] = detectChecklist(hand);
    if (list.length && list.some((it) => fresh.has(it.boxId) || it.textIds.some((id) => fresh.has(id)))) {
      const all = list.flatMap((it) => [it.boxId, ...it.textIds]);
      const anchor = boundsOfStrokes(page.strokes.filter((s) => all.includes(s.id)));
      offer({ key: `list:${all.join(',')}`, pageIndex, anchor, label: 'Make a checklist', icon: 'checklist', run: () => run('Reading…', async () => {
        const box = await checklistFromInk(ctx, pageIndex, list, true);
        if (!box) throw new Error('Reading handwriting needs the Android app (on-device) or an AI with vision.');
        toast({ text: 'Made a checklist', action: { label: 'Undo', run: () => engine.undo() } });
      }) });
    }
  };

  useEffect(() => {
    const known = new Set(doc.pages.flatMap((p) => p.strokes.map((s) => s.id)));
    let timer = 0;
    let fresh = new Set<string>();
    let freshPage = -1;
    const unsub = doc.subscribe(() => {
      doc.pages.forEach((p, i) => {
        for (const s of p.strokes) {
          if (known.has(s.id)) continue;
          known.add(s.id);
          if (!s.input || s.origin) continue;
          if (freshPage !== i) { fresh = new Set(); freshPage = i; }
          fresh.add(s.id);
          clearTimeout(timer);
          timer = window.setTimeout(() => { const f = fresh; fresh = new Set(); analyzeRef.current(freshPage, f); }, PAUSE_MS);
        }
      });
    });
    // The pen going down again means "not now": the chip steps back (it is offered again after the next pause).
    const onDown = () => { clearTimeout(timer); setChip(null); };
    host.addEventListener('pointerdown', onDown);
    return () => { unsub(); clearTimeout(timer); host.removeEventListener('pointerdown', onDown); };
  }, [doc, host]);

  useEffect(() => { if (!suggestions) setChip(null); }, [suggestions]);

  const announceSolved = (obj: MathObject) => {
    toast({ text: `${obj.result}`, action: { label: 'Undo', run: () => engine.undo() } });
  };

  // ---- Selection actions and the text tool --------------------------------------------------------------
  apiRef.current = {
    editCellAt(pageIndex, x, y) {
      const t = (doc.page(pageIndex).objects ?? []).find((o): o is TableObject => o.type === 'table' && x >= o.x && y >= o.y && x <= colEdges(o).at(-1)! && y <= rowEdges(o).at(-1)!);
      if (!t) return false;
      const xs = colEdges(t), ys = rowEdges(t);
      let c = 0, r = 0;
      while (c < t.cols.length - 1 && x > xs[c + 1]!) c++;
      while (r < t.rows.length - 1 && y > ys[r + 1]!) r++;
      setActiveTable({ pageIndex, id: t.id, r, c });
      setCellEdit({ pageIndex, id: t.id, r, c, value: t.cells[r]?.[c]?.text ?? t.cells[r]?.[c]?.recognized ?? '' });
      return true;
    },
    solveSelection() {
      const items = engine.getSelectionItems();
      if (!items?.strokes.length) return;
      const b = boundsOfStrokes(items.strokes);
      engine.clearSelection();
      void run('Solving…', async () => announceSolved((await solveInk(ctx, items.pageIndex, items.strokes.map((s) => s.id), b)).obj));
    },
    readSelection() {
      const items = engine.getSelectionItems();
      if (!items?.strokes.length) return;
      engine.clearSelection();
      void run('Reading…', async () => {
        const c = await readForActions(ctx, items.pageIndex, items.strokes.map((s) => s.id), true);
        if (!c) throw new Error('Reading handwriting needs the Android app (on-device) or an AI with vision in Settings › AI.');
        setCard(c);
      });
    },
    tableFromSelection() {
      const items = engine.getSelectionItems();
      if (!items) return;
      const grid = detectTable(items.strokes, doc.page(items.pageIndex).strokes);
      if (!grid) return toast({ text: 'That doesn’t look like a grid — draw a box with lines across it', tone: 'error' });
      engine.clearSelection();
      makeTable(doc, items.pageIndex, grid);
      toast({ text: 'Made a table', action: { label: 'Undo', run: () => engine.undo() } });
    },
  };

  // ---- Geometry helpers -----------------------------------------------------------------------------------
  const W = host.clientWidth, H = host.clientHeight;
  const scr = (pageIndex: number, r: Rect) => engine.pageRectToScreen(pageIndex, r);
  const onScreen = (s: { x: number; y: number; w: number; h: number }) => s.x + s.w > -80 && s.y + s.h > -80 && s.x < W + 80 && s.y < H + 80;
  const zoom = engine.zoom;
  const clampX = (x: number, w: number) => Math.max(8, Math.min(W - w - 8, x));
  const clampY = (y: number, h: number) => Math.max(8, Math.min(H - h - 8, y));

  const objects = doc.pages.flatMap((p, pageIndex) => (p.objects ?? []).map((o) => ({ o, pageIndex })));
  const tables = objects.filter((x): x is { o: TableObject; pageIndex: number } => x.o.type === 'table');
  const maths = objects.filter((x): x is { o: MathObject; pageIndex: number } => x.o.type === 'math');
  const graphs = objects.filter((x): x is { o: GraphObject; pageIndex: number } => x.o.type === 'graph');

  const active = activeTable ? tableById(doc, activeTable.pageIndex, activeTable.id) : null;
  useEffect(() => { if (activeTable && !active) { setActiveTable(null); setCellEdit(null); } }, [activeTable, active]);
  // Writing again (pen tool) closes the table's handles.
  useEffect(() => { if (tool !== 'pen' && tool !== 'text') setActiveTable(null); }, [tool]);

  // ---- Table drags (move, rule, stretch) ---------------------------------------------------------------------
  const startDrag = (e: ReactPointerEvent, kind: 'move' | 'col' | 'row' | 'size', index = 0) => {
    if (!activeTable || !active) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    const t0 = active, pageIndex = activeTable.pageIndex;
    let last = { dx: 0, dy: 0 };
    setDrag({ kind, index, dx: 0, dy: 0 });
    const move = (ev: PointerEvent) => { last = { dx: (ev.clientX - x0) / zoom, dy: (ev.clientY - y0) / zoom }; setDrag({ kind, index, ...last }); };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(null);
      const { dx, dy } = last;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      if (kind === 'move') applyTableEdit(doc, pageIndex, t0, moveTable(t0, dx, dy), 'Move table');
      else if (kind === 'col') applyTableEdit(doc, pageIndex, t0, resizeTrack(t0, 'col', index, t0.cols[index]! + dx), 'Resize column');
      else if (kind === 'row') applyTableEdit(doc, pageIndex, t0, resizeTrack(t0, 'row', index, t0.rows[index]! + dy), 'Resize row');
      else {
        const w = t0.cols.reduce((a, b) => a + b, 0), h = t0.rows.reduce((a, b) => a + b, 0);
        const sx = Math.max(0.3, (w + dx) / w), sy = Math.max(0.3, (h + dy) / h);
        applyTableEdit(doc, pageIndex, t0, { table: { ...t0, cols: t0.cols.map((c) => Math.max(14, c * sx)), rows: t0.rows.map((r) => Math.max(14, r * sy)) }, cellMap: (r, c) => ({ r, c }) }, 'Resize table');
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const tableOp = (label: string, fn: (t: TableObject) => ReturnType<typeof insertRow> | null) => {
    if (!activeTable || !active) return;
    const edit = fn(active);
    if (!edit) return toast({ text: 'A table needs at least one row and one column' });
    applyTableEdit(doc, activeTable.pageIndex, active, edit, label);
  };

  const commitCell = (move?: 'down' | 'right') => {
    if (!cellEdit) return;
    const t = tableById(doc, cellEdit.pageIndex, cellEdit.id);
    if (t) setCellText(doc, cellEdit.pageIndex, t, cellEdit.r, cellEdit.c, cellEdit.value);
    const t2 = tableById(doc, cellEdit.pageIndex, cellEdit.id);
    if (move && t2) {
      let { r, c } = cellEdit;
      if (move === 'right') { c++; if (c >= t2.cols.length) { c = 0; r++; } } else r++;
      if (r < t2.rows.length) {
        setActiveTable({ pageIndex: cellEdit.pageIndex, id: t2.id, r, c });
        setCellEdit({ ...cellEdit, r, c, value: t2.cells[r]?.[c]?.text ?? t2.cells[r]?.[c]?.recognized ?? '' });
        return;
      }
    }
    setCellEdit(null);
  };

  const copyTable = async (format: 'md' | 'csv') => {
    if (!active) return;
    const text = format === 'md' ? tableToMarkdown(active) : tableToCsv(active);
    try { await navigator.clipboard.writeText(text); toast({ text: format === 'md' ? 'Copied as Markdown' : 'Copied as CSV' }); }
    catch { await saveFile(`Table.${format === 'md' ? 'md' : 'csv'}`, new TextEncoder().encode(text), format === 'md' ? 'text/markdown' : 'text/csv'); }
  };

  // ---- Graph pan / zoom ---------------------------------------------------------------------------------------
  const graphPointers = useRef(new Map<number, { x: number; y: number }>());
  const graphGesture = useRef<{ view: GraphObject['view']; dist: number; cx: number; cy: number } | null>(null);
  const setView = (pageIndex: number, g: GraphObject, view: GraphObject['view']) => doc.editObjects(pageIndex, 'Move graph', { upsert: [{ ...g, view }] }, { undoable: false });
  const graphDown = (e: ReactPointerEvent, pageIndex: number, g: GraphObject) => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setActiveGraph({ pageIndex, id: g.id });
    graphPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...graphPointers.current.values()];
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    graphGesture.current = { view: g.view, dist: pts.length > 1 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0, cx, cy };
  };
  const graphMove = (e: ReactPointerEvent, pageIndex: number, g: GraphObject) => {
    const gs = graphGesture.current;
    if (!gs || !graphPointers.current.has(e.pointerId)) return;
    graphPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...graphPointers.current.values()];
    const s = scr(pageIndex, { minX: g.x, minY: g.y, maxX: g.x + g.width, maxY: g.y + g.height });
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const v0 = gs.view;
    const ux = (v0.xMax - v0.xMin) / s.w, uy = (v0.yMax - v0.yMin) / s.h;
    let view = panView(v0, -(cx - gs.cx) * ux, (cy - gs.cy) * uy);
    if (pts.length > 1 && gs.dist > 0) {
      const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      view = zoomView(view, gs.dist / Math.max(1, d));
    }
    setView(pageIndex, g, view);
  };
  const graphUp = (e: ReactPointerEvent, g: GraphObject) => {
    graphPointers.current.delete(e.pointerId);
    const pts = [...graphPointers.current.values()];
    const latest = activeGraph ? (doc.page(activeGraph.pageIndex).objects?.find((o) => o.id === g.id) as GraphObject | undefined) : undefined;
    graphGesture.current = pts.length && latest ? { view: latest.view, dist: pts.length > 1 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0, cx: pts.reduce((a, p) => a + p.x, 0) / pts.length, cy: pts.reduce((a, p) => a + p.y, 0) / pts.length } : null;
  };
  const graphWheel = (e: React.WheelEvent, pageIndex: number, g: GraphObject) => {
    e.stopPropagation();
    const s = scr(pageIndex, { minX: g.x, minY: g.y, maxX: g.x + g.width, maxY: g.y + g.height });
    const hr = host.getBoundingClientRect();
    const fx = (e.clientX - hr.left - s.x) / s.w, fy = (e.clientY - hr.top - s.y) / s.h;
    const v = g.view;
    setView(pageIndex, g, zoomView(v, Math.exp(e.deltaY * 0.002), v.xMin + fx * (v.xMax - v.xMin), v.yMax - fy * (v.yMax - v.yMin)));
  };
  // Wheel listeners must be non-passive to keep the page from scrolling under the graph.
  const graphEls = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    const stop = (e: WheelEvent) => e.preventDefault();
    const els = [...graphEls.current.values()];
    els.forEach((el) => el.addEventListener('wheel', stop, { passive: false }));
    return () => els.forEach((el) => el.removeEventListener('wheel', stop));
  });

  // ---- Render ------------------------------------------------------------------------------------------------------
  const chipBox = chip ? scr(chip.pageIndex, chip.anchor) : null;
  const cardBox = card ? scr(card.pageIndex, card.anchor) : null;
  const stepsObj = steps ? (doc.page(steps.pageIndex).objects?.find((o) => o.id === steps.id) as MathObject | undefined) : undefined;
  const menuObj = mathMenu ? (doc.page(mathMenu.pageIndex).objects?.find((o) => o.id === mathMenu.id) as MathObject | undefined) : undefined;

  return (
    <div className="smart-layer" aria-label="Smart ink">
      {/* Tables: a grip beside each; tapping it opens the table's handles. */}
      {tables.map(({ o: t, pageIndex }) => {
        const s = scr(pageIndex, { minX: t.x, minY: t.y, maxX: colEdges(t).at(-1)!, maxY: rowEdges(t).at(-1)! });
        if (!onScreen(s)) return null;
        const isActive = activeTable?.id === t.id;
        return (
          <button key={t.id} type="button" className={cx('smart-grip', isActive && 'is-on')} style={{ left: s.x - 30, top: s.y - 2 }}
            aria-label={isActive ? 'Done editing table' : 'Edit table'} title={isActive ? 'Drag to move · tap when done' : 'Table: type, add rows and columns, copy'}
            onPointerDown={isActive ? (e) => startDrag(e, 'move') : undefined}
            onClick={() => { if (drag) return; if (isActive) { setActiveTable(null); setCellEdit(null); } else setActiveTable({ pageIndex, id: t.id, r: t.rows.length - 1, c: t.cols.length - 1 }); }}>
            <Table2 size={15} />
          </button>
        );
      })}

      {active && activeTable && (() => {
        const t = active;
        const pageIndex = activeTable.pageIndex;
        const xs = colEdges(t), ys = rowEdges(t);
        const s = scr(pageIndex, { minX: xs[0]!, minY: ys[0]!, maxX: xs.at(-1)!, maxY: ys.at(-1)! });
        const barTop = s.y > 60 ? s.y - 50 : s.y + s.h + 10;
        const { r: fr, c: fc } = activeTable;
        return (
          <>
            <div className="smart-table-frame" style={{ left: s.x - 3, top: s.y - 3, width: s.w + 6, height: s.h + 6, transform: drag?.kind === 'move' ? `translate(${drag.dx * zoom}px, ${drag.dy * zoom}px)` : undefined }} aria-hidden />
            {t.rows.map((_, r) => t.cols.map((__, c) => {
              const cs = scr(pageIndex, cellRect(t, r, c));
              return <button key={`${r},${c}`} type="button" className={cx('smart-cell', fr === r && fc === c && 'is-focus')} style={{ left: cs.x, top: cs.y, width: cs.w, height: cs.h }}
                aria-label={`Cell row ${r + 1}, column ${c + 1}`} onClick={() => apiRef.current?.editCellAt(pageIndex, (cellRect(t, r, c).minX + cellRect(t, r, c).maxX) / 2, (cellRect(t, r, c).minY + cellRect(t, r, c).maxY) / 2)} />;
            }))}
            {xs.slice(1).map((x, i) => {
              const p = scr(pageIndex, { minX: x, minY: ys[0]!, maxX: x, maxY: ys.at(-1)! });
              const dx = drag?.kind === 'col' && drag.index === i ? drag.dx * zoom : 0;
              return <div key={`c${i}`} className={cx('smart-rule is-col', dx !== 0 && 'is-drag')} style={{ left: p.x - 5 + dx, top: p.y, height: p.h }} onPointerDown={(e) => startDrag(e, 'col', i)} role="separator" aria-orientation="vertical" aria-label={`Resize column ${i + 1}`} />;
            })}
            {ys.slice(1).map((y, i) => {
              const p = scr(pageIndex, { minX: xs[0]!, minY: y, maxX: xs.at(-1)!, maxY: y });
              const dy = drag?.kind === 'row' && drag.index === i ? drag.dy * zoom : 0;
              return <div key={`r${i}`} className={cx('smart-rule is-row', dy !== 0 && 'is-drag')} style={{ left: p.x, top: p.y - 5 + dy, width: p.w }} onPointerDown={(e) => startDrag(e, 'row', i)} role="separator" aria-orientation="horizontal" aria-label={`Resize row ${i + 1}`} />;
            })}
            <div className="smart-size" style={{ left: s.x + s.w - 9 + (drag?.kind === 'size' ? drag.dx * zoom : 0), top: s.y + s.h - 9 + (drag?.kind === 'size' ? drag.dy * zoom : 0) }} onPointerDown={(e) => startDrag(e, 'size')} aria-label="Resize table" role="button" />
            <div className="smart-bar" role="toolbar" aria-label="Table" style={{ left: clampX(s.x + s.w / 2 - 210, 420), top: clampY(barTop, 44) }}>
              <button type="button" className="smart-tool" onClick={() => tableOp('Add row', (x) => insertRow(x, fr + 1))} title="Add a row below"><Plus size={15} /><Rows3 size={15} /><span>Row</span></button>
              <button type="button" className="smart-tool" onClick={() => tableOp('Add column', (x) => insertCol(x, fc + 1))} title="Add a column to the right"><Plus size={15} /><Columns3 size={15} /><span>Column</span></button>
              <button type="button" className="smart-tool" onClick={() => tableOp('Remove row', (x) => removeRow(x, fr))} title="Remove this row" aria-label="Remove row"><Minus size={15} /><Rows3 size={15} /></button>
              <button type="button" className="smart-tool" onClick={() => tableOp('Remove column', (x) => removeCol(x, fc))} title="Remove this column" aria-label="Remove column"><Minus size={15} /><Columns3 size={15} /></button>
              <span className="smart-sep" />
              <button type="button" className={cx('smart-tool', t.header && 'is-on')} aria-pressed={!!t.header} onClick={() => doc.editObjects(pageIndex, 'Header row', { upsert: [{ ...t, header: !t.header }] })} title="First row is a header" aria-label="Header row"><Heading size={15} /></button>
              <button type="button" className="smart-tool" onClick={() => void run('Reading…', async () => { const n = await readTable(ctx, pageIndex, t, true); toast({ text: n ? `Read ${n} ${n === 1 ? 'cell' : 'cells'}` : 'No handwriting in the cells yet' }); })} title="Read the handwriting in the cells" aria-label="Read cells"><ScanText size={15} /></button>
              <button type="button" className="smart-tool" onClick={(e) => setCopyMenu(e.currentTarget)} aria-label="Copy table" title="Copy as Markdown or CSV"><Copy size={15} /></button>
              <button type="button" className="smart-tool is-danger" onClick={() => { deleteTable(doc, pageIndex, t, true); setActiveTable(null); toast({ text: 'Table removed (its ink stays)', action: { label: 'Undo', run: () => engine.undo() } }); }} aria-label="Delete table" title="Remove the table, keep the writing"><Trash2 size={15} /></button>
              <span className="smart-sep" />
              <button type="button" className="smart-tool is-done" onClick={() => { commitCell(); setActiveTable(null); }}><Check size={15} /><span>Done</span></button>
            </div>
            <Popover anchor={copyMenu} open={!!copyMenu} onClose={() => setCopyMenu(null)} title="Copy table" placement="below">
              <Menu onClose={() => setCopyMenu(null)} items={[
                { label: 'Copy as Markdown', onClick: () => void copyTable('md') },
                { label: 'Copy as CSV', onClick: () => void copyTable('csv') },
              ]} />
            </Popover>
          </>
        );
      })()}

      {cellEdit && (() => {
        const t = tableById(doc, cellEdit.pageIndex, cellEdit.id);
        if (!t || !t.rows[cellEdit.r] || !t.cols[cellEdit.c]) return null;
        const cs = scr(cellEdit.pageIndex, cellRect(t, cellEdit.r, cellEdit.c));
        return (
          <input key={`${cellEdit.id}:${cellEdit.r},${cellEdit.c}`} className="smart-cell-input" autoFocus value={cellEdit.value} aria-label={`Row ${cellEdit.r + 1}, column ${cellEdit.c + 1}`}
            style={{ left: cs.x + 1, top: cs.y + 1, width: Math.max(40, cs.w - 2), height: Math.max(22, cs.h - 2), fontSize: Math.max(12, Math.min(16, t.rows[cellEdit.r]! * 0.5) * zoom) }}
            onChange={(e) => setCellEdit({ ...cellEdit, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitCell('down'); }
              else if (e.key === 'Tab') { e.preventDefault(); commitCell('right'); }
              else if (e.key === 'Escape') { e.preventDefault(); setCellEdit(null); }
            }}
            onBlur={() => commitCell()} />
        );
      })()}

      {/* Solved results: tap for steps, plot, copy, delete. */}
      {maths.map(({ o: m, pageIndex }) => {
        const s = scr(pageIndex, { minX: m.x - 4, minY: m.y, maxX: m.x + Math.max(m.fontSize, m.result.length * m.fontSize * 0.5 + m.fontSize * 0.6) + 4, maxY: m.y + m.fontSize * 1.5 });
        if (!onScreen(s)) return null;
        return <button key={m.id} type="button" className="smart-math" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
          aria-label={`Result ${m.result}${m.origin === 'ai' ? ' (read by AI)' : ''}`} title={m.origin === 'ai' ? 'Read by AI, solved on this device' : 'Solved on this device'}
          onClick={(e) => setMathMenu({ pageIndex, id: m.id, el: e.currentTarget })} />;
      })}
      <Popover anchor={mathMenu?.el ?? null} open={!!mathMenu && !!menuObj} onClose={() => setMathMenu(null)} title="Result" placement="below">
        {menuObj && mathMenu && (
          <Menu onClose={() => setMathMenu(null)} items={[
            ...(menuObj.steps?.length ? [{ label: 'Show steps', icon: <ListChecks size={16} />, onClick: () => setSteps({ pageIndex: mathMenu.pageIndex, id: menuObj.id }) }] : []),
            ...(plottable(menuObj) ? [{ label: 'Plot', icon: <ChartSpline size={16} />, onClick: () => { plotFunctions(doc, mathMenu.pageIndex, plottable(menuObj)!, { minX: menuObj.x, minY: menuObj.y, maxX: menuObj.x, maxY: menuObj.y + menuObj.fontSize * 1.5 }); } }] : []),
            { label: 'Copy answer', icon: <Copy size={16} />, onClick: () => void navigator.clipboard?.writeText(menuObj.result).then(() => toast({ text: 'Copied' }), () => undefined) },
            { label: 'Remove', icon: <Trash2 size={16} />, danger: true, onClick: () => doc.editObjects(mathMenu.pageIndex, 'Remove result', { removeObjects: new Set([menuObj.id]) }) },
          ]} />
        )}
      </Popover>
      <Dialog open={!!stepsObj} title="Steps" onClose={() => setSteps(null)} actions={<button type="button" className="btn btn-primary" onClick={() => setSteps(null)}>Done</button>}>
        {stepsObj && (
          <div className="smart-steps">
            <p className="smart-steps-problem">{stepsObj.input} <span aria-hidden>→</span> <strong>{stepsObj.result}</strong></p>
            <ol>{stepsObj.steps?.map((st, i) => <li key={i}>{st}</li>)}</ol>
            <p className="set-note">Steps written by your AI; the answer was checked on this device.</p>
          </div>
        )}
      </Dialog>

      {/* Graphs: drag to pan, wheel or pinch to zoom; a small toolbar while active. */}
      {graphs.map(({ o: g, pageIndex }) => {
        const s = scr(pageIndex, { minX: g.x, minY: g.y, maxX: g.x + g.width, maxY: g.y + g.height });
        if (!onScreen(s)) return null;
        const isActive = activeGraph?.id === g.id;
        return (
          <div key={g.id} ref={(el) => { if (el) graphEls.current.set(g.id, el); else graphEls.current.delete(g.id); }}
            className={cx('smart-graph', isActive && 'is-on')} style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
            role="img" aria-label={`Graph of ${g.functions.map((f) => `${f.label ?? 'y'} = ${f.expr}`).join(', ')}`}
            onPointerDown={(e) => graphDown(e, pageIndex, g)} onPointerMove={(e) => graphMove(e, pageIndex, g)} onPointerUp={(e) => graphUp(e, g)} onPointerCancel={(e) => graphUp(e, g)}
            onWheel={(e) => graphWheel(e, pageIndex, g)}>
            {isActive && (
              <div className="smart-graph-bar" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" className="smart-tool" aria-label="Zoom in" onClick={() => setView(pageIndex, g, zoomView(g.view, 0.7))}><ZoomIn size={15} /></button>
                <button type="button" className="smart-tool" aria-label="Zoom out" onClick={() => setView(pageIndex, g, zoomView(g.view, 1 / 0.7))}><ZoomOut size={15} /></button>
                <button type="button" className="smart-tool" aria-label="Fit" onClick={() => setView(pageIndex, g, autoView(g.functions.map((f) => f.expr)))}><Maximize size={15} /></button>
                <button type="button" className="smart-tool" aria-label="Add a function" onClick={async () => {
                  const t = await askText('Add a function', 'y =', '', 'Plot');
                  if (!t?.trim()) return;
                  const fn = asFunctionOfX(t.includes('=') ? t : `y = ${t}`);
                  if (!fn) return toast({ text: 'Write a function of x, like x^2 - 3', tone: 'error' });
                  plotFunctions(doc, pageIndex, [fn], { minX: g.x, minY: g.y, maxX: g.x + g.width, maxY: g.y + g.height });
                }}><Plus size={15} /></button>
                <button type="button" className="smart-tool is-danger" aria-label="Remove graph" onClick={() => { doc.editObjects(pageIndex, 'Remove graph', { removeObjects: new Set([g.id]) }); setActiveGraph(null); }}><Trash2 size={15} /></button>
                <button type="button" className="smart-tool" aria-label="Done" onClick={() => setActiveGraph(null)}><X size={15} /></button>
              </div>
            )}
          </div>
        );
      })}

      {/* The one suggestion chip. */}
      {chip && chipBox && (
        <div className="smart-chip" role="status" style={{ left: clampX(chipBox.x + chipBox.w + 10, 220), top: clampY(chipBox.y + chipBox.h / 2 - 18, 36) }}>
          <button type="button" className="smart-chip-go" onClick={() => { const c = chip; setChip(null); dismissed.current.add(c.key); void c.run(); }}>
            {chip.icon === 'table' ? <Table2 size={15} /> : chip.icon === 'solve' ? <Sigma size={15} /> : chip.icon === 'checklist' ? <ListChecks size={15} /> : <ScanText size={15} />}
            <span>{chip.label}</span>
          </button>
          <button type="button" className="smart-chip-x" aria-label="Dismiss suggestion" onClick={() => { dismissed.current.add(chip.key); setChip(null); }}><X size={14} /></button>
        </div>
      )}

      {card && cardBox && <ActionsCard card={card} box={cardBox} W={W} H={H} noteTitle={doc.meta.title} onClose={() => setCard(null)}
        onChecklist={(items) => { addChecklist(doc, card.pageIndex, items, card.anchor, '#FF1B1F24'); setCard(null); toast({ text: 'Made a checklist', action: { label: 'Undo', run: () => engine.undo() } }); }} />}

      {busy && <div className="smart-busy" role="status" aria-live="polite">{busy}</div>}
    </div>
  );
}

/** Functions a result object can plot: y = f(x), or the input when it is an expression in x. */
function plottable(m: MathObject): { expr: string; label: string }[] | null {
  const fn = asFunctionOfX(m.input.replace(/\s*=\s*$/, ''));
  return fn ? [fn] : null;
}

function ActionsCard({ card, box, W, H, noteTitle, onClose, onChecklist }: { card: ReadCard; box: { x: number; y: number; w: number; h: number }; W: number; H: number; noteTitle: string; onClose: () => void; onChecklist: (items: { text: string; done: boolean }[]) => void }) {
  const { toast } = useApp();
  const width = Math.min(340, W - 16);
  const left = Math.max(8, Math.min(W - width - 8, box.x + box.w + 12 > W - width ? box.x : box.x + box.w + 12));
  const top = Math.max(8, Math.min(H - 220, box.x + box.w + 12 > W - width ? box.y + box.h + 10 : box.y));
  const e = card.event;
  const event = e ? { title: e.title, start: e.start, end: e.end, allDay: e.allDay, description: `From the Inkstone note “${noteTitle}”` } : null;
  const nothing = !e && !card.links.length && !card.tasks;
  return (
    <div className="smart-card" role="dialog" aria-label="What you circled" style={{ left, top, width }}>
      <button type="button" className="smart-card-x" aria-label="Close" onClick={onClose}><X size={15} /></button>
      {event && (
        <section className="smart-card-sec">
          <p className="smart-card-title"><CalendarPlus size={16} /> Add to calendar</p>
          <p className="smart-card-sub">{describeWhen(event)} · “{event.title}”</p>
          <div className="smart-card-actions">
            {hasNativePlugin && <button type="button" className="btn btn-primary btn-sm" onClick={async () => {
              const r = await InkstoneNative.insertCalendarEvent({ title: event.title, beginTime: event.start.getTime(), endTime: event.end.getTime(), allDay: event.allDay, description: event.description }).catch(() => ({ opened: false }));
              if (!r.opened) toast({ text: 'No calendar app found — download the .ics instead', tone: 'error' });
            }}>Add to calendar</button>}
            <button type="button" className={cx('btn btn-sm', hasNativePlugin ? 'btn-ghost' : 'btn-primary')} onClick={() => void saveFile(icsFileName(event), new TextEncoder().encode(buildIcs(event, { uid: `${event.start.getTime()}-${Math.random().toString(36).slice(2)}@inkstone` })), 'text/calendar')}>
              <Download size={14} /> .ics
            </button>
            <a className="btn btn-ghost btn-sm" href={googleCalendarUrl(event)} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} /> Google Calendar</a>
          </div>
        </section>
      )}
      {card.links.length > 0 && (
        <section className="smart-card-sec smart-links">
          {card.links.map((l) => (
            <a key={l.href} className="smart-link" href={l.href} target={l.kind === 'url' ? '_blank' : undefined} rel="noreferrer noopener">
              {l.kind === 'phone' ? <Phone size={15} /> : l.kind === 'email' ? <Mail size={15} /> : <LinkIcon size={15} />}
              <span>{l.kind === 'phone' ? `Call ${l.text}` : l.kind === 'email' ? `Email ${l.text}` : `Open ${l.text}`}</span>
            </a>
          ))}
        </section>
      )}
      {card.tasks && (
        <section className="smart-card-sec">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChecklist(card.tasks!)}><ListChecks size={14} /> Make a checklist ({card.tasks.length})</button>
        </section>
      )}
      {nothing && <p className="smart-card-sub">Nothing to act on in “{card.text.slice(0, 80)}”.</p>}
    </div>
  );
}

/** Extra buttons for the selection bar when handwriting is selected. */
export function SmartSelectionActions({ engine, api, strokes }: { engine: InkEngine; api: { current: SmartApi | null }; strokes: number }) {
  if (!strokes) return null;
  const items = engine.getSelectionItems();
  const grid = items && items.strokes.length >= 3 ? detectTable(items.strokes, items.strokes) : null;
  return (
    <>
      {grid && <button type="button" className="sel-btn" onClick={() => api.current?.tableFromSelection()} title="Turn this grid into a table"><Table2 size={16} /><span>Table</span></button>}
      <button type="button" className="sel-btn" onClick={() => api.current?.solveSelection()} title="Solve or evaluate this maths"><Sigma size={16} /><span>Solve</span></button>
      <button type="button" className="sel-btn" onClick={() => api.current?.readSelection()} title="Find dates, phone numbers and links"><CalendarPlus size={16} /><span>Dates &amp; links</span></button>
    </>
  );
}

