import { useEffect, useRef, useState } from 'react';
import { formatApa, parseCitations, referenceLabel, type NoteDocument, type Rect, type TextBox } from '@inkstone/core';
import type { InkEngine } from '../canvas/engine.ts';
import { FONT_FAMILIES, layoutText } from '../canvas/render.ts';
import { useApp } from '../state/app.ts';
import { findReference } from './library.ts';

/**
 * Hover cards for `[@key]` citations in typed text on the page: resting the mouse on a citation
 * shows the paper (formatted reference, and a way to open its note). Touch and pens are left
 * alone — writing over a citation must never pop anything up — and the Bibliography dialog gives
 * the same information to keyboards and screen readers.
 */

/** Where each citation group sits in a text box (page units), measured like the canvas draws it. */
export function citationRects(ctx: CanvasRenderingContext2D, t: TextBox): { keys: string[]; rect: Rect }[] {
  const cites = parseCitations(t.text);
  if (!cites.length) return [];
  const fam = FONT_FAMILIES[t.font] ?? FONT_FAMILIES.sans;
  const { lines, lineHeights } = layoutText(ctx, t);
  const out: { keys: string[]; rect: Rect }[] = [];
  let y = t.y;
  lines.forEach((line, i) => {
    for (const c of parseCitations(line.text)) {
      ctx.font = `${line.weight} ${line.size}px ${fam}`;
      const x0 = t.x + line.x + ctx.measureText(line.text.slice(0, c.start)).width;
      const w = ctx.measureText(line.text.slice(c.start, c.end)).width;
      out.push({ keys: c.items.map((it) => it.key), rect: { minX: x0, minY: y, maxX: x0 + w, maxY: y + line.size * 1.25 } });
    }
    y += lineHeights[i]!;
  });
  return out;
}

export function CiteHover({ doc, engine, host }: { doc: NoteDocument; engine: InkEngine; host: HTMLElement }) {
  const navigate = useApp((s) => s.navigate);
  const [card, setCard] = useState<{ keys: string[]; x: number; y: number } | null>(null);
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  const hideTimer = useRef(0);
  useEffect(() => {
    measure.current ??= document.createElement('canvas').getContext('2d');
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      const ctx = measure.current;
      if (!ctx) return;
      const hr = host.getBoundingClientRect();
      const sx = e.clientX - hr.left, sy = e.clientY - hr.top;
      const i = engine.currentPageIndex;
      for (const t of doc.page(i).texts ?? []) {
        if (!t.text.includes('@')) continue;
        for (const c of citationRects(ctx, t)) {
          const s = engine.pageRectToScreen(i, c.rect);
          if (sx >= s.x && sx <= s.x + s.w && sy >= s.y && sy <= s.y + s.h) {
            clearTimeout(hideTimer.current);
            setCard({ keys: c.keys, x: s.x, y: s.y + s.h + 6 });
            return;
          }
        }
      }
      clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setCard(null), 250);
    };
    host.addEventListener('pointermove', move);
    return () => { host.removeEventListener('pointermove', move); clearTimeout(hideTimer.current); };
  }, [doc, engine, host]);
  if (!card) return null;
  return (
    <div className="ia-cite-card" role="tooltip" style={{ left: card.x, top: card.y }} onPointerEnter={() => clearTimeout(hideTimer.current)} onPointerLeave={() => setCard(null)}>
      {card.keys.map((k) => {
        const found = findReference(k);
        return (
          <div key={k} className="ia-cite-card-item">
            {found ? (
              <>
                <div className="ia-cite-card-title">{referenceLabel(found.ref)}</div>
                <div className="ia-cite-card-ref">{formatApa(found.ref).text}</div>
                <button type="button" className="ia-link" onClick={() => navigate({ name: 'editor', noteId: found.noteId })}>Open the paper’s note</button>
              </>
            ) : <div className="ia-muted">@{k} is not in your library of papers.</div>}
          </div>
        );
      })}
    </div>
  );
}
