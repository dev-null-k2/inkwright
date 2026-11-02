import { useMemo, useRef } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { boundsOfStrokes, liveInkLinks, linkLabel, parseWikiTarget, rectIsEmpty, type NoteDocument, type Rect, type TextBox } from '@inkwright/core';
import type { InkEngine } from '../../canvas/engine.ts';
import { textLinkRects } from '../../canvas/render.ts';

interface Placed {
  key: string;
  target: string;
  noteId?: string;
  label: string;
  pageIndex: number;
  rect: Rect;
  ink: boolean;
}

/**
 * Links on the page, drawn over the canvas: a fine dotted jade thread under linked handwriting
 * and typed `[[links]]`, and a small arrow at the end of each to follow it. Only the arrows take
 * taps, so writing over linked ink works as usual.
 */
export function InkLinkLayer({ doc, engine, host, version, editingTextId, onFollow }: {
  doc: NoteDocument;
  engine: InkEngine;
  /** The canvas host element (for culling links scrolled out of view). */
  host: HTMLElement;
  /** Changes whenever the view moves (the editor's viewport state) so the layer re-places. */
  version: unknown;
  editingTextId?: string;
  onFollow: (target: string, noteId?: string) => void;
}) {
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  const cache = useRef(new Map<string, { at: TextBox; rects: ReturnType<typeof textLinkRects> }>());
  measure.current ??= typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

  // Page-space link positions: recomputed when the document changes, not when the view moves.
  const placedOnPage = useMemo(() => {
    const out: Placed[] = [];
    const ctx = measure.current;
    doc.pages.forEach((p, pageIndex) => {
      for (const l of liveInkLinks(p)) {
        const ids = new Set(l.strokeIds);
        const r = boundsOfStrokes(p.strokes.filter((s) => ids.has(s.id)));
        if (rectIsEmpty(r)) continue;
        const parts = parseWikiTarget(l.target);
        out.push({ key: l.id, target: l.target, noteId: l.noteId, label: linkLabel(parts), pageIndex, rect: r, ink: true });
      }
      if (!ctx) return;
      for (const t of p.texts ?? []) {
        if (!t.text.includes('[[') || t.id === editingTextId) continue;
        let c = cache.current.get(t.id);
        if (!c || c.at !== t) cache.current.set(t.id, (c = { at: t, rects: textLinkRects(ctx, t) }));
        c.rects.forEach((x, k) => out.push({ key: `${t.id}:${k}`, target: x.target, label: x.label, pageIndex, rect: x.rect, ink: false }));
      }
    });
    return out;
  }, [doc, doc.version, editingTextId]); // eslint-disable-line react-hooks/exhaustive-deps

  void version;
  const box = host.getBoundingClientRect();
  return (
    <div className="ink-links" role="group" aria-label="Links on this page">
      {placedOnPage.map((l) => {
        const s = engine.pageRectToScreen(l.pageIndex, l.rect);
        if (s.x > box.width + 40 || s.y > box.height + 40 || s.x + s.w < -40 || s.y + s.h < -40) return null;
        const under = l.ink ? s.y + s.h + 3 : s.y + s.h - 1;
        return (
          <div key={l.key} className={`ink-link${l.ink ? ' is-ink' : ''}`}>
            <span className="ink-link-thread" style={{ left: s.x, top: under, width: Math.max(8, s.w) }} aria-hidden />
            {/* Ink: an arrow beside the writing. Typed text: a small raised arrow, like a footnote mark. */}
            <button type="button" className="ink-link-go" style={l.ink ? { left: s.x + s.w + 2, top: s.y + s.h / 2 - 11 } : { left: s.x + s.w - 3, top: s.y - 9 }}
              aria-label={`Open “${l.label}”`} title={`Open “${l.label}”`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onFollow(l.target, l.noteId)}>
              <ArrowUpRight size={l.ink ? 13 : 10} strokeWidth={2.4} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
