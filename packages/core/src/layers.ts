import type { InkStroke, PageInk, PageLayers, StrokeLayer } from './model.ts';

/**
 * Lightweight layers and the selective eraser: which strokes are drawn, in what order, and which
 * ones the eraser, lasso and scratch-out may touch.
 *
 * Layers are a property of strokes only (`InkStroke.layer`): the drawing layer is drawn under the
 * writing layer, so a diagram can be annotated without the two getting in each other's way. Page
 * objects keep their own places (tables, results and graphs under all ink; stickies and tape over
 * it) and are not part of either layer.
 */

export const LAYERS: readonly StrokeLayer[] = ['drawing', 'writing'];

export const layerOf = (s: Pick<InkStroke, 'layer'>): StrokeLayer => (s.layer === 'drawing' ? 'drawing' : 'writing');

export function layerState(page: Pick<PageInk, 'layers'>, layer: StrokeLayer): { hidden: boolean; locked: boolean } {
  const st = page.layers?.[layer];
  return { hidden: !!st?.hidden, locked: !!st?.locked };
}

/** Whether a page uses layers at all (a drawing-layer stroke, or a layer hidden/locked). */
export function pageHasLayers(page: Pick<PageInk, 'strokes' | 'layers'>): boolean {
  return page.strokes.some((s) => s.layer === 'drawing') || !!(page.layers?.drawing?.hidden || page.layers?.drawing?.locked || page.layers?.writing?.hidden || page.layers?.writing?.locked);
}

/**
 * Strokes to draw, in drawing order: the drawing layer first, then the writing layer (each in its
 * own z-order), leaving out hidden layers. Returns the page's own array when layers are unused, so
 * renderers' caches stay warm.
 */
export function visibleStrokes(page: Pick<PageInk, 'strokes' | 'layers'>): readonly InkStroke[] {
  if (!pageHasLayers(page)) return page.strokes;
  const out: InkStroke[] = [];
  for (const layer of LAYERS) {
    if (layerState(page, layer).hidden) continue;
    for (const s of page.strokes) if (layerOf(s) === layer) out.push(s);
  }
  return out;
}

/** Strokes the user can act on (erase, lasso, scratch out): those on layers neither hidden nor locked. */
export function editableStroke(page: Pick<PageInk, 'layers'>, s: Pick<InkStroke, 'layer'>): boolean {
  const st = layerState(page, layerOf(s));
  return !st.hidden && !st.locked;
}

/** A page's layers with one layer's state changed; drops empty entries so files stay small. */
export function withLayerState(layers: PageLayers | undefined, layer: StrokeLayer, patch: { hidden?: boolean; locked?: boolean }): PageLayers | undefined {
  const cur = { ...(layers?.[layer] ?? {}), ...patch };
  const clean: { hidden?: boolean; locked?: boolean } = {};
  if (cur.hidden) clean.hidden = true;
  if (cur.locked) clean.locked = true;
  const next: PageLayers = { ...(layers ?? {}) };
  if (clean.hidden || clean.locked) next[layer] = clean;
  else delete next[layer];
  return next.writing || next.drawing ? next : undefined;
}

// ---- Selective eraser -------------------------------------------------------------------------------

/**
 * What the eraser removes: everything, only highlighter, only pen ink (everything written with a
 * pen that isn't a highlighter or a snapped shape), or only shapes (strokes snapped to a shape).
 */
export type EraserFilter = 'all' | 'highlighter' | 'ink' | 'shapes';

export const ERASER_FILTERS: { value: EraserFilter; label: string; hint: string }[] = [
  { value: 'all', label: 'Everything', hint: 'Ink, highlighter, shapes and tape' },
  { value: 'highlighter', label: 'Only highlighter', hint: 'Leaves the writing underneath' },
  { value: 'ink', label: 'Only pen ink', hint: 'Keeps highlights and shapes' },
  { value: 'shapes', label: 'Only shapes', hint: 'Lines, boxes, circles you snapped' },
];

export function eraserAccepts(filter: EraserFilter | undefined, s: Pick<InkStroke, 'pen' | 'shape'>): boolean {
  switch (filter ?? 'all') {
    case 'highlighter': return s.pen === 'highlighter';
    case 'shapes': return !!s.shape;
    case 'ink': return s.pen !== 'highlighter' && !s.shape;
    default: return true;
  }
}

/** Splits a page's strokes into what an eraser with [filter] may touch and what it must keep. */
export function erasable(page: Pick<PageInk, 'strokes' | 'layers'>, filter: EraserFilter | undefined): InkStroke[] {
  return page.strokes.filter((s) => eraserAccepts(filter, s) && editableStroke(page, s));
}
