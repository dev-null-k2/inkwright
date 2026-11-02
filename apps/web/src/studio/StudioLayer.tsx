import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Minimize2, Trash2, Type } from 'lucide-react';
import {
  STICKY_COLORS, STICKY_DEFAULT, STICKY_FONT, STICKY_PAD, newId, resizeSticky, stickyRect,
  type NoteDocument, type Rect, type StickyObject,
} from '@inkwright/core';
import type { InkEngine, Tool } from '../canvas/engine.ts';
import { FONT_FAMILIES } from '../canvas/render.ts';
import { cx } from '../ui/primitives.tsx';

/**
 * Sticky notes on the page: the canvas draws them (studio/render.ts); this layer adds the
 * handles. A grip beside each note selects it — then drag the grip to move it (it snaps to
 * guides), drag the corner to resize, and use the little bar to recolour, type, fold it away or
 * delete it. A folded note is a small icon; tap it to open it again. Writing that starts on a
 * note goes onto it (the engine does that); the text tool types on it.
 */
export interface StudioApi {
  /** The text tool tapped at a page point: type on the sticky note there (true if handled). */
  editStickyAt(pageIndex: number, x: number, y: number): boolean;
  /** Puts a new sticky note in the middle of what is visible on the current page. */
  addSticky(): void;
}

interface Props {
  doc: NoteDocument;
  engine: InkEngine;
  host: HTMLElement;
  tool: Tool;
  /** Re-render trigger: the editor's viewport state. */
  view: unknown;
  apiRef: { current: StudioApi | null };
}

type Drag = { id: string; kind: 'move' | 'size'; dx: number; dy: number };

export function StudioLayer({ doc, engine, host, tool, apiRef }: Props) {
  const [active, setActive] = useState<{ pageIndex: number; id: string } | null>(null);
  const [editing, setEditing] = useState<{ pageIndex: number; id: string; value: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const find = (pageIndex: number, id: string) => doc.page(pageIndex)?.objects?.find((o): o is StickyObject => o.type === 'sticky' && o.id === id) ?? null;
  const upsert = (pageIndex: number, s: StickyObject, label: string) => doc.editObjects(pageIndex, label, { upsert: [s] });

  const commitText = () => {
    if (!editing) return;
    const s = find(editing.pageIndex, editing.id);
    if (s && (s.text ?? '') !== editing.value) upsert(editing.pageIndex, { ...s, text: editing.value.trim() ? editing.value : undefined }, 'Type on sticky note');
    setEditing(null);
    engine.setEditingSticky(null);
  };

  const startEditing = (pageIndex: number, s: StickyObject) => {
    setActive({ pageIndex, id: s.id });
    setEditing({ pageIndex, id: s.id, value: s.text ?? '' });
    engine.setEditingSticky(s.id);
  };

  apiRef.current = {
    editStickyAt(pageIndex, x, y) {
      const list = (doc.page(pageIndex).objects ?? []).filter((o): o is StickyObject => o.type === 'sticky' && !o.collapsed);
      const s = [...list].reverse().find((o) => x >= o.x && y >= o.y && x <= o.x + o.width && y <= o.y + o.height);
      if (!s) return false;
      startEditing(pageIndex, s);
      return true;
    },
    addSticky() {
      const pageIndex = engine.currentPageIndex;
      const c = engine.visibleCenter(pageIndex);
      const s: StickyObject = { type: 'sticky', id: newId(), x: c.x - STICKY_DEFAULT.width / 2, y: c.y - STICKY_DEFAULT.height / 2, width: STICKY_DEFAULT.width, height: STICKY_DEFAULT.height, color: STICKY_COLORS[0], createdAt: Date.now() };
      upsert(pageIndex, s, 'Add sticky note');
      setActive({ pageIndex, id: s.id });
    },
  };

  useEffect(() => { if (editing) textRef.current?.focus(); }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Picking another tool puts the handles away.
  useEffect(() => { if (tool !== 'pen' && tool !== 'text' && tool !== 'lasso') setActive(null); }, [tool]);
  // A note removed (undo, erase) loses its handles.
  const activeSticky = active ? find(active.pageIndex, active.id) : null;
  useEffect(() => { if (active && !activeSticky) setActive(null); }, [active, activeSticky]);

  const zoom = engine.zoom;
  const W = host.clientWidth, H = host.clientHeight;
  const scr = (pageIndex: number, r: Rect) => engine.pageRectToScreen(pageIndex, r);

  const startDrag = (e: ReactPointerEvent, pageIndex: number, s: StickyObject, kind: Drag['kind']) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    let last = { dx: 0, dy: 0 };
    setActive({ pageIndex, id: s.id });
    setDrag({ id: s.id, kind, dx: 0, dy: 0 });
    const box = stickyRect(s);
    const move = (ev: PointerEvent) => {
      const raw = { dx: (ev.clientX - x0) / zoom, dy: (ev.clientY - y0) / zoom };
      last = engine.snapDrag(pageIndex, box, raw.dx, raw.dy, { exclude: new Set([s.id]), mode: kind === 'size' ? 'size' : 'move', free: ev.altKey });
      setDrag({ id: s.id, kind, ...last });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      engine.clearGuides();
      setDrag(null);
      const { dx, dy } = last;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      const cur = find(pageIndex, s.id) ?? s;
      if (kind === 'move') upsert(pageIndex, { ...cur, x: cur.x + dx, y: cur.y + dy }, 'Move sticky note');
      else upsert(pageIndex, resizeSticky(cur, cur.width + dx, cur.height + dy), 'Resize sticky note');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const stickies = doc.pages.flatMap((p, pageIndex) => (p.objects ?? []).filter((o): o is StickyObject => o.type === 'sticky').map((o) => ({ o, pageIndex })));

  return (
    <div className="studio-layer" role="group" aria-label="Sticky notes">
      {stickies.map(({ o: s, pageIndex }) => {
        const d = drag?.id === s.id ? drag : null;
        const r = scr(pageIndex, stickyRect(s));
        if (r.x + r.w < -60 || r.y + r.h < -60 || r.x > W + 60 || r.y > H + 60) return null;
        if (s.collapsed) {
          return (
            <button key={s.id} type="button" className="sticky-icon" style={{ left: r.x, top: r.y, width: Math.max(28, r.w), height: Math.max(28, r.h) }}
              aria-label="Open sticky note" title={s.text?.trim() ? s.text.trim().slice(0, 80) : 'Sticky note'}
              onClick={() => { upsert(pageIndex, { ...s, collapsed: false }, 'Open sticky note'); setActive({ pageIndex, id: s.id }); }} />
          );
        }
        const isActive = active?.id === s.id;
        const isEditing = editing?.id === s.id;
        const moveX = d?.kind === 'move' ? d.dx * zoom : 0, moveY = d?.kind === 'move' ? d.dy * zoom : 0;
        const sizeX = d?.kind === 'size' ? d.dx * zoom : 0, sizeY = d?.kind === 'size' ? d.dy * zoom : 0;
        return (
          <div key={s.id}>
            {d && <div className="sticky-ghost" style={{ left: r.x + moveX, top: r.y + moveY, width: Math.max(20, r.w + sizeX), height: Math.max(20, r.h + sizeY) }} aria-hidden />}
            <button type="button" className={cx('sticky-grip', isActive && 'is-on')} style={{ left: r.x - 30 + moveX, top: r.y + moveY }}
              aria-label={isActive ? 'Done with sticky note' : 'Sticky note options'} title={isActive ? 'Drag to move · tap when done' : 'Sticky note: move, resize, colour, type, fold'}
              onPointerDown={isActive ? (e) => startDrag(e, pageIndex, s, 'move') : undefined}
              onClick={() => { if (!drag) setActive(isActive ? null : { pageIndex, id: s.id }); }}>
              <GripVertical size={15} />
            </button>
            {isActive && !d && (
              <>
                <div className="sticky-size" style={{ left: r.x + r.w - 9, top: r.y + r.h - 9 }} role="button" aria-label="Resize sticky note" onPointerDown={(e) => startDrag(e, pageIndex, s, 'size')} />
                <div className="sticky-bar" style={{ left: Math.max(8, Math.min(W - 250, r.x)), top: Math.max(8, r.y - 46) }} role="toolbar" aria-label="Sticky note">
                  {STICKY_COLORS.map((c) => (
                    <button key={c} type="button" className={cx('swatch', s.color === c && 'is-on')} style={{ background: '#' + c.slice(3) }} aria-label={`Sticky colour ${c}`} aria-pressed={s.color === c} onClick={() => upsert(pageIndex, { ...s, color: c }, 'Recolour sticky note')} />
                  ))}
                  <span className="sticky-bar-sep" />
                  <button type="button" className="smart-tool" aria-label="Type on sticky note" title="Type" onClick={() => startEditing(pageIndex, s)}><Type size={15} /></button>
                  <button type="button" className="smart-tool" aria-label="Fold sticky note away" title="Fold away" onClick={() => { commitText(); upsert(pageIndex, { ...s, collapsed: true }, 'Fold sticky note'); setActive(null); }}><Minimize2 size={15} /></button>
                  <button type="button" className="smart-tool is-danger" aria-label="Delete sticky note" title="Delete" onClick={() => { setEditing(null); engine.setEditingSticky(null); doc.editObjects(pageIndex, 'Delete sticky note', { removeObjects: new Set([s.id]) }); setActive(null); }}><Trash2 size={15} /></button>
                </div>
              </>
            )}
            {isEditing && (
              <textarea ref={textRef} className="sticky-text" aria-label="Sticky note text"
                style={{ left: r.x, top: r.y, width: r.w, height: r.h, fontSize: STICKY_FONT * zoom, padding: `${(STICKY_PAD - 2) * zoom}px ${STICKY_PAD * zoom}px`, fontFamily: FONT_FAMILIES.sans, lineHeight: 1.3 }}
                value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                onBlur={commitText} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); commitText(); } }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
