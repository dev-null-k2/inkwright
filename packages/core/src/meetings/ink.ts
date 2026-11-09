/**
 * Meetings and the pen. Handwritten notes are read line by line (the recogniser's lines, each with
 * its strokes), and because every stroke carries the time it was written, each of your lines can
 * be put at the moment of the meeting you wrote it — which is where the AI should look for its
 * details. A small box drawn before a line makes it an action item; a star drawn while recording
 * marks the moment.
 */
import { boundsOf, pathLength } from '../geometry.ts';
import { strokeBounds } from '../gestures.ts';
import type { InkStroke, PageInk } from '../model.ts';
import { strokeAsBox } from '../tables.ts';
import { formatStamp } from '../transcript.ts';

/** A small square or rectangle (a hand-drawn checkbox). */
export function isBoxStroke(s: Pick<InkStroke, 'points' | 'shape'>): boolean {
  if (s.points.length < 4) return false;
  const b = boundsOf(s.points);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  if (w < 6 || w > 40 || h < 6 || h > 40 || w / h > 1.8 || h / w > 1.8) return false;
  return s.shape === 'rectangle' || !!strokeAsBox(s as InkStroke);
}

/**
 * A five-pointed star drawn in one stroke: about the size of a letter or two, a path much longer
 * than its outline, and at least four sharp turns (the points), ending near where it began.
 */
export function isStarStroke(s: Pick<InkStroke, 'points' | 'origin'>): boolean {
  if (s.origin || s.points.length < 12) return false;
  const pts = s.points;
  const b = boundsOf(pts);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  if (w < 10 || h < 10 || w > 90 || h > 90 || w / h > 1.8 || h / w > 1.8) return false;
  const len = pathLength(pts);
  if (len < (w + h) * 2.2) return false;
  const first = pts[0]!, last = pts[pts.length - 1]!;
  if (Math.hypot(last.x - first.x, last.y - first.y) > Math.max(w, h) * 0.45) return false;
  // Sharp turns, measured over a few points so jitter doesn't count.
  let turns = 0;
  let cool = 0;
  const step = Math.max(1, Math.floor(pts.length / 40));
  for (let i = step; i + step < pts.length; i += step) {
    const a = pts[i - step]!, p = pts[i]!, c = pts[i + step]!;
    const v1x = p.x - a.x, v1y = p.y - a.y, v2x = c.x - p.x, v2y = c.y - p.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 0.5 || l2 < 0.5) continue;
    const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
    if (cool > 0) { cool--; continue; }
    if (cos < -0.4) { turns++; cool = 2; }
  }
  return turns >= 4 && turns <= 7;
}

export interface InkNoteLine {
  text: string;
  /** ms from the start of the recording when the line was written (if it was, during it). */
  ms?: number;
  /** A box was drawn before it: an action item. */
  task?: boolean;
  y: number;
  page: number;
}

/**
 * Your notes as lines, in the order written: handwriting from the recogniser's lines (with their
 * strokes' times), typed text boxes, then any recognised text without line detail.
 */
export function inkNoteLines(pages: readonly PageInk[], clip?: { startedAt: number; durationMs: number } | ReadonlyArray<{ startedAt: number; durationMs: number; offsetMs?: number }> | null): InkNoteLine[] {
  const clips = !clip ? [] : Array.isArray(clip) ? clip : [clip as { startedAt: number; durationMs: number; offsetMs?: number }];
  const out: InkNoteLine[] = [];
  const at = (t: number | undefined) => {
    if (t == null) return undefined;
    const c = clips.find((x) => t >= x.startedAt - 5000 && t <= x.startedAt + x.durationMs + 5000);
    return c ? (c.offsetMs ?? 0) + Math.max(0, t - c.startedAt) : undefined;
  };
  pages.forEach((p, pi) => {
    const byId = new Map(p.strokes.map((s) => [s.id, s]));
    const lines = p.recognizedLines ?? [];
    for (const l of lines) {
      const text = l.text.trim();
      if (!text) continue;
      const strokes = l.strokeIds.map((id) => byId.get(id)).filter((s): s is InkStroke => !!s);
      const t = strokes.length ? Math.min(...strokes.map((s) => s.createdAt)) : undefined;
      // A box just left of the line (drawn as its own stroke, often not part of the recognised line).
      const task = p.strokes.some((s) => {
        if (!isBoxStroke(s)) return false;
        const b = strokeBounds(s);
        const cy = (b.minY + b.maxY) / 2;
        return b.maxX <= l.bounds.minX + 6 && l.bounds.minX - b.maxX < 40 && cy > l.bounds.minY - 6 && cy < l.bounds.maxY + 6;
      });
      out.push({ text, ...(at(t) != null ? { ms: at(t)! } : {}), ...(task ? { task } : {}), y: l.bounds.minY, page: pi });
    }
    if (!lines.length && p.recognizedText?.trim()) for (const t of p.recognizedText.split('\n')) if (t.trim()) out.push({ text: t.trim(), y: 0, page: pi });
    for (const tb of p.texts ?? []) {
      if (tb.origin === 'ai') continue;
      for (const t of tb.text.split('\n')) if (t.replace(/^#+\s*/, '').trim()) out.push({ text: t.replace(/^#+\s*/, '').trim(), ...(at(tb.createdAt) != null ? { ms: at(tb.createdAt)! } : {}), y: tb.y, page: pi });
    }
  });
  // Written order when known, page order otherwise.
  return out.sort((a, b) => (a.ms != null && b.ms != null ? a.ms - b.ms : a.page - b.page || a.y - b.y));
}

/** The lines as the notes the AI gets: "[m:ss] text" when written during the recording, "[ ] " for tasks. */
export function inkNotesText(lines: readonly InkNoteLine[]): string {
  return lines.map((l) => `${l.ms != null ? `[${formatStamp(l.ms)}] ` : ''}${l.task ? '[ ] ' : ''}${l.text}`).join('\n');
}
