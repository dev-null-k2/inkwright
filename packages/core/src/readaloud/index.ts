import { boundsOf, type Rect } from '../geometry.ts';
import { textBoxBounds } from '../inkanswer/index.ts';
import type { PageInk } from '../model.ts';

/**
 * Read aloud: a page (or a selection) as the pieces a voice reads in order — typed paragraphs,
 * recognized handwriting lines (with the strokes that wrote them, so the app can highlight the
 * ink being read), and sticky-note text — sorted in reading order: top to bottom, and left to
 * right within a line band.
 */

export interface ReadingSegment {
  text: string;
  kind: 'typed' | 'handwriting' | 'sticky';
  rect: Rect;
  strokeIds?: string[];
  textId?: string;
}

/** Text a speech engine should say: no Markdown syntax, links as their labels. */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
    .replace(/\[(-?@[^\]]+)\]/g, (_m, c: string) => `(${c.replace(/-?@/g, '')})`)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[( |x|X)\]\s+/gm, '')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SegmentFilter {
  strokeIds?: ReadonlySet<string>;
  textIds?: ReadonlySet<string>;
}

/** The page's readable pieces, in reading order; with a filter, only what was selected. */
export function readingSegments(page: Pick<PageInk, 'strokes' | 'texts' | 'objects' | 'recognizedText' | 'recognizedLines'>, filter?: SegmentFilter): ReadingSegment[] {
  const out: ReadingSegment[] = [];
  const picked = (ids: readonly string[]) => !filter?.strokeIds || ids.some((id) => filter.strokeIds!.has(id));
  for (const t of page.texts ?? []) {
    if (filter && !filter.textIds?.has(t.id)) continue;
    const b = textBoxBounds(t);
    const paras = t.text.split(/\n{2,}/).map(speakableText).filter(Boolean);
    const h = (b.maxY - b.minY) / Math.max(1, paras.length);
    paras.forEach((p, i) => out.push({ text: p, kind: 'typed', rect: { ...b, minY: b.minY + i * h, maxY: b.minY + (i + 1) * h }, textId: t.id }));
  }
  if (page.recognizedLines?.length) {
    for (const l of page.recognizedLines) {
      if (!l.text.trim() || (filter && !(filter.strokeIds && picked(l.strokeIds)))) continue;
      out.push({ text: speakableText(l.text), kind: 'handwriting', rect: l.bounds, strokeIds: l.strokeIds });
    }
  } else if (page.recognizedText?.trim()) {
    // Recognized without line positions: one piece covering the handwriting (or the selection).
    const strokes = page.strokes.filter((s) => !s.origin && (!filter?.strokeIds || filter.strokeIds.has(s.id)));
    if (strokes.length && (!filter || filter.strokeIds?.size)) {
      out.push({ text: speakableText(page.recognizedText), kind: 'handwriting', rect: boundsOf(strokes.flatMap((s) => s.points)), strokeIds: strokes.map((s) => s.id) });
    }
  }
  if (!filter) {
    for (const o of page.objects ?? []) {
      if (o.type !== 'sticky' || !o.text?.trim() || o.collapsed) continue;
      out.push({ text: speakableText(o.text), kind: 'sticky', rect: { minX: o.x, minY: o.y, maxX: o.x + o.width, maxY: o.y + o.height } });
    }
  }
  // Reading order: bands of roughly one line height, left to right inside a band.
  return out.sort((a, b) => {
    const band = Math.max(12, Math.min(a.rect.maxY - a.rect.minY, b.rect.maxY - b.rect.minY) * 0.6);
    return Math.abs(a.rect.minY - b.rect.minY) < band ? a.rect.minX - b.rect.minX : a.rect.minY - b.rect.minY;
  });
}

/** Handwriting with no recognized text yet (the app offers to read it first). */
export function unreadHandwriting(page: Pick<PageInk, 'strokes' | 'recognizedText' | 'recognizedLines'>): boolean {
  return page.strokes.some((s) => !s.origin) && !page.recognizedText?.trim() && !page.recognizedLines?.length;
}
