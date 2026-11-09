import {
  boundsOfStrokes,
  cssHexToArgb,
  findFreeSpace,
  inkAnswerHeight,
  layoutInkAnswer,
  newId,
  occupiedRects,
  pageSizeOf,
  textBoxBounds,
  writeOnFrame,
  type HandStyle,
  type HandwritingStyle,
  type NoteDocument,
  type Rect,
  type TextBox,
} from '@inkwright/core';

/**
 * Puts an AI answer on the page — in handwriting (`handwrite()`, origin 'ai') or as a typed text
 * box — in the free space next to what it answers, as one undo step through
 * `NoteDocument.commit`. Ink is written on with a calm replay (about 1–2 s) shown as a document
 * preview, which is never saved and never an undo step; people who ask for reduced motion get the
 * finished answer at once.
 */

/** The AI-ink colour: the `--ai-ink` design token (ink-actions.css), so palettes can restyle it. */
export function aiInkColor(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ai-ink').trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return cssHexToArgb(v);
  } catch { /* tests without layout */ }
  return '#FF2D5A8C';
}

export const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A stable seed from the text, so the same answer is written the same way (tests, re-dos). */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface PlacedAnswer {
  pageIndex: number;
  rect: Rect;
  /** Ids of the strokes written (ink), or the text box id (typed). */
  strokeIds: string[];
  textId?: string;
}

/** Where an answer of this text goes: near `near`, else below everything, else on a new page. */
function place(doc: NoteDocument, pageIndex: number, near: Rect | null, heightFor: (w: number) => number): { pageIndex: number; rect: Rect } {
  const page = doc.page(pageIndex);
  const size = pageSizeOf(doc.meta, page);
  const found = findFreeSpace(occupiedRects(page), near, heightFor, { page: size });
  if (found) return { pageIndex, rect: found };
  const next = doc.addPage(pageIndex + 1, { paper: page.paper, size: page.background ? undefined : page.size });
  const w = (size.width || 794) - 96;
  return { pageIndex: next, rect: { minX: 48, minY: 64, maxX: 48 + w, maxY: 64 + heightFor(w) } };
}

/** Writes `text` in AI ink (see the module comment). Resolves when the ink is committed. */
export async function writeInInk(doc: NoteDocument, pageIndex: number, text: string, o: { near?: Rect | null; style?: HandwritingStyle; animate?: boolean; label?: string; hand?: HandStyle | null } = {}): Promise<PlacedAnswer> {
  const style = o.style ?? o.hand?.style ?? 'script';
  const xHeight = o.hand?.xHeight;
  const spot = place(doc, pageIndex, o.near ?? null, (w) => inkAnswerHeight(text, w, { style, ...(xHeight ? { xHeight } : {}) }));
  const { strokes, rect } = layoutInkAnswer(text, { x: spot.rect.minX, y: spot.rect.minY, width: spot.rect.maxX - spot.rect.minX }, { style, color: aiInkColor(), seed: seedOf(text), startTime: Date.now(), newId: () => newId(), ...(xHeight ? { xHeight } : {}), ...(o.hand ? { hand: o.hand } : {}) });
  if (!strokes.length) throw new Error('Nothing to write');
  const i = spot.pageIndex;
  if (o.animate !== false && !prefersReducedMotion() && typeof requestAnimationFrame !== 'undefined') {
    const ms = Math.max(1000, Math.min(2000, 500 + strokes.length * 12));
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      const frame = () => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        // Built on the committed page each frame, so anything written meanwhile stays visible.
        const base = doc.committedPages[i];
        if (!base) { resolve(); return; }
        doc.preview(i, { ...base, strokes: [...base.strokes, ...writeOnFrame(strokes, p)] });
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    doc.clearPreview(i);
  }
  const at = doc.page(i).strokes.length;
  doc.commit(i, { label: o.label ?? 'AI answer in ink', strokes: { removed: [], added: strokes.map((item, k) => ({ index: at + k, item })) } }, 'other');
  return { pageIndex: i, rect: { ...rect, ...boundsOfStrokes(strokes) }, strokeIds: strokes.map((s) => s.id) };
}

/** Puts `text` on the page as an AI text box near `near` (the "typed text" choice). */
export function placeTypedAnswer(doc: NoteDocument, pageIndex: number, text: string, near: Rect | null): PlacedAnswer {
  const fontSize = 16;
  const box: TextBox = { id: newId(), x: 0, y: 0, width: 0, text, fontSize, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'ai' };
  const spot = place(doc, pageIndex, near, (w) => { const b = textBoxBounds({ ...box, width: w }); return b.maxY - b.minY; });
  const placed = { ...box, x: spot.rect.minX, y: spot.rect.minY, width: Math.min(spot.rect.maxX - spot.rect.minX, 520) };
  doc.upsertText(spot.pageIndex, placed, 'AI answer');
  return { pageIndex: spot.pageIndex, rect: textBoxBounds(placed), strokeIds: [], textId: placed.id };
}
