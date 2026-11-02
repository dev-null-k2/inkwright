import { newId as defaultNewId } from './ids.ts';
import type { FormFieldValue, NoteMeta, PageInk, PageSize } from './model.ts';

/**
 * Page-level tools that work on plain page data: rotating a page a quarter turn and copying pages
 * into another note. Pure functions, so the editor, the MCP server and tests share them.
 */

/** Normalizes degrees to 0, 90, 180 or 270. */
export function normalizeQuarter(deg: number): number {
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

/**
 * Rotates a page a quarter turn (clockwise by default): the page becomes `height × width`, ink
 * follows the paper, images turn with it, and text boxes keep reading left to right with their
 * centre moved to where it lands. An imported PDF/image background records the extra turn in
 * `background.rotation` so renderers and exporters turn the source page the same way.
 */
export function rotatePageQuarter(page: PageInk, size: PageSize, clockwise = true): { page: PageInk; size: PageSize } {
  const W = size.width, H = size.height;
  if (W <= 0 || H <= 0) return { page, size }; // boards have no orientation
  const map = clockwise ? (x: number, y: number) => ({ x: H - y, y: x }) : (x: number, y: number) => ({ x: y, y: W - x });
  const turn = clockwise ? Math.PI / 2 : -Math.PI / 2;
  const next: PageInk = {
    ...page,
    strokes: page.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, ...map(p.x, p.y) })) })),
  };
  if (page.texts) {
    next.texts = page.texts.map((t) => {
      // Text stays upright; its (estimated) centre moves with the page.
      const lines = Math.max(1, t.text.split('\n').length);
      const h = t.fontSize * 1.35 * lines;
      const c = map(t.x + t.width / 2, t.y + h / 2);
      return { ...t, x: c.x - t.width / 2, y: c.y - h / 2 };
    });
  }
  if (page.images) {
    next.images = page.images.map((m) => {
      const c = map(m.x + m.width / 2, m.y + m.height / 2);
      return { ...m, x: c.x - m.width / 2, y: c.y - m.height / 2, rotation: (m.rotation || 0) + turn };
    });
  }
  if (page.background) next.background = { ...page.background, rotation: normalizeQuarter((page.background.rotation ?? 0) + (clockwise ? 90 : -90)) };
  const newSize: PageSize = { ...size, width: H, height: W };
  next.size = newSize;
  return { page: next, size: newSize };
}

/** Asset names a page refers to (background and placed images). */
export function pageAssets(page: PageInk): string[] {
  const out = new Set<string>();
  if (page.background) out.add(page.background.asset);
  for (const im of page.images ?? []) out.add(im.asset);
  return [...out];
}

/**
 * Copies pages for a new note ("Extract pages"): every page and item gets a fresh id, pages keep
 * their own size so they look the same in a note with a different default, and the form values of
 * any PDF the copies show come along. The caller copies the asset files (`assets`).
 */
export function copyPagesForNewNote(meta: NoteMeta, pages: PageInk[], newId: () => string = () => defaultNewId()): { pages: PageInk[]; assets: string[]; forms?: Record<string, Record<string, FormFieldValue>> } {
  const out = pages.map((p) => ({
    ...p,
    id: newId(),
    size: p.size ?? meta.pageSize,
    paper: p.paper ?? meta.paper,
    strokes: p.strokes.map((s) => ({ ...s, id: newId() })),
    texts: p.texts?.map((t) => ({ ...t, id: newId() })),
    images: p.images?.map((m) => ({ ...m, id: newId() })),
  }));
  const assets = [...new Set(out.flatMap(pageAssets))];
  let forms: Record<string, Record<string, FormFieldValue>> | undefined;
  for (const a of assets) {
    const v = meta.forms?.[a];
    if (v) (forms ??= {})[a] = { ...v };
  }
  return { pages: out, assets, forms };
}
