import { useEffect, useMemo, useRef, useState } from 'react';
import { argbToCss, newId, outlineToSvgPath, penLook, strokeOutline, type InkPoint, type InkStroke, type NoteDocument, type PenType } from '@inkwright/core';

/**
 * Ink on a document: strokes on the note's first page, in the document sheet's coordinates (CSS
 * px of its layout width), drawn as SVG over the text so they scroll and scale with it.
 *
 * While annotating, the pen (or mouse) writes and its eraser end erases; a finger writes only
 * with "Draw with finger" on, and then two fingers scroll the page. Otherwise fingers scroll as
 * usual. Strokes go through `NoteDocument.addStroke`, so they are undoable, saved, synced and
 * recorded in the authorship chain like ink anywhere else.
 */
export interface InkLayerProps {
  doc: NoteDocument;
  /** Annotating: the layer takes pointer input. */
  active: boolean;
  tool: 'pen' | 'eraser';
  pen: { pen: PenType; color: string; size: number };
  fingerDraws: boolean;
  /** Layout width of the sheet in CSS px (points are stored in this space). */
  width: number;
  /** The scroller, panned by two fingers while finger drawing is on. */
  scroller: HTMLElement | null;
  /** Called after a stroke is added (e.g. to schedule handwriting recognition). */
  onStroke?: () => void;
}

const ERASE_RADIUS = 10;

function distToSegment(px: number, py: number, a: InkPoint, b: InkPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Strokes passing within `r` (plus half their width) of the point. */
export function strokesNear(strokes: readonly InkStroke[], x: number, y: number, r = ERASE_RADIUS): string[] {
  const out: string[] = [];
  for (const s of strokes) {
    const reach = r + s.size / 2;
    const pts = s.points;
    if (pts.length === 1 && Math.hypot(pts[0]!.x - x, pts[0]!.y - y) <= reach) { out.push(s.id); continue; }
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(x, y, pts[i - 1]!, pts[i]!) <= reach) { out.push(s.id); break; }
    }
  }
  return out;
}

export function InkLayer({ doc, active, tool, pen, fingerDraws, width, scroller, onStroke }: InkLayerProps) {
  const svg = useRef<SVGSVGElement>(null);
  const wet = useRef<SVGPathElement>(null);
  const drawing = useRef<{ id: number; points: InkPoint[]; t0: number; erase: boolean; input: 'pen' | 'touch' | 'mouse'; hits: Set<string> } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const [erasing, setErasing] = useState<Set<string>>(new Set());
  const [, bump] = useState(0);
  useEffect(() => doc.subscribe(() => bump((x) => x + 1)), [doc]);
  const strokes = doc.page(0).strokes;
  const paths = useMemo(() => strokes.map((s) => ({ s, d: outlineToSvgPath(strokeOutline(s)), look: penLook(s.pen) })), [strokes]);

  const local = (e: PointerEvent | React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const k = r.width / width || 1;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  const renderWet = () => {
    const d = drawing.current;
    if (!wet.current) return;
    if (!d || d.erase || d.points.length < 1) { wet.current.setAttribute('d', ''); return; }
    wet.current.setAttribute('d', outlineToSvgPath(strokeOutline({ pen: pen.pen, size: pen.size, points: d.points })));
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!active) return;
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!fingerDraws) return; // the browser scrolls
      if (touches.current.size > 1) { drawing.current = null; renderWet(); return; }
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { svg.current!.setPointerCapture(e.pointerId); } catch { /* not an active pointer (synthetic input) */ }
    const p = local(e);
    const erase = tool === 'eraser' || (e.pointerType === 'pen' && (e.buttons & 32) !== 0);
    drawing.current = { id: e.pointerId, points: [{ x: p.x, y: p.y, t: 0, p: e.pointerType === 'pen' ? e.pressure || 0.5 : -1, tilt: -1, orient: -1 }], t0: e.timeStamp, erase, input: e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse', hits: new Set() };
    if (erase) eraseAt(p.x, p.y);
    renderWet();
  };
  const eraseAt = (x: number, y: number) => {
    const d = drawing.current!;
    const hit = strokesNear(doc.page(0).strokes, x, y);
    if (hit.some((h) => !d.hits.has(h))) { hit.forEach((h) => d.hits.add(h)); setErasing(new Set(d.hits)); }
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      const prev = touches.current.get(e.pointerId)!;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Two fingers pan the document while one finger draws.
      if (fingerDraws && touches.current.size > 1 && scroller) {
        scroller.scrollTop -= (e.clientY - prev.y) / touches.current.size;
        scroller.scrollLeft -= (e.clientX - prev.x) / touches.current.size;
        return;
      }
    }
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = local(ev);
      if (d.erase) eraseAt(p.x, p.y);
      else d.points.push({ x: p.x, y: p.y, t: ev.timeStamp - d.t0, p: ev.pointerType === 'pen' ? ev.pressure || 0.5 : -1, tilt: -1, orient: -1 });
    }
    renderWet();
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId);
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    drawing.current = null;
    renderWet();
    if (d.erase) {
      if (d.hits.size) doc.deleteStrokes(0, d.hits, 'Erase ink');
      setErasing(new Set());
      return;
    }
    const stroke: InkStroke = { id: newId(), pen: pen.pen, color: pen.color, size: pen.size, createdAt: Date.now(), points: d.points, input: d.input };
    doc.addStroke(0, stroke, false);
    onStroke?.();
  };
  const onCancel = (e: React.PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId);
    if (drawing.current?.id === e.pointerId) { drawing.current = null; renderWet(); setErasing(new Set()); }
  };

  return (
    <svg ref={svg} className={`doc-ink${active ? ' is-active' : ''}${active && fingerDraws ? ' is-finger' : ''}`} aria-hidden={!active} aria-label={active ? 'Ink layer: write on the document' : undefined}
      role={active ? 'img' : undefined} viewBox={undefined}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
      {paths.map(({ s, d, look }) => (
        <path key={s.id} d={d} fill={argbToCss(s.color)} opacity={erasing.has(s.id) ? 0.15 : look.opacity} style={look.multiply ? { mixBlendMode: 'multiply' } : undefined} data-stroke={s.id} />
      ))}
      <path ref={wet} fill={argbToCss(pen.color)} opacity={penLook(pen.pen).opacity} />
    </svg>
  );
}
