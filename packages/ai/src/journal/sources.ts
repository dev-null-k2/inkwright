/**
 * What a day held, as citable sources for the journal that writes itself: what you wrote (only
 * the ink and text made that day, anchored to the exact lines), what was said in recordings, the
 * calendar events you imported, and — when the memory timeline is on — what was on screen.
 *
 * Every source gets a short id (`s1`, `s2`, …) that the model must cite; anything it writes
 * without a valid citation is dropped (draft.ts). Text is bounded per source and in total, so a
 * busy day still fits a small on-device model.
 */
import {
  formatAnchor,
  pageText,
  segmentSpan,
  sentenceHash,
  strokeSpan,
  type Capture,
  type IcsOccurrence,
  type NoteMeta,
  type PageInk,
  type Rect,
  type TranscriptFile,
} from '@inkwright/core';

export type JournalSourceKind = 'note' | 'speech' | 'event' | 'screen' | 'audio';

export interface JournalSource {
  /** Citation id (`s1`…), assigned by `collectJournalSources`. */
  id: string;
  kind: JournalSourceKind;
  /** Note title, event title, or "Terminal" for screen moments. */
  title: string;
  at: number;
  end?: number;
  text: string;
  /** Provenance anchor (`formatAnchor`) for notes and recordings. */
  anchor?: string;
  noteId?: string;
  pageIndex?: number;
  /** In-app link to open it (`#mem/…`, `#said/…`, `#recall/<ms>`). */
  link?: string;
}

export type SourceDraft = Omit<JournalSource, 'id'>;

const MAX = { note: 1400, speech: 1600, event: 300, screen: 500, audio: 900 } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const unionRect = (a: Rect | null, b: Rect): Rect => (a ? { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) } : { ...b });

/**
 * The parts of a note written during `[from, to)`: recognised handwriting lines whose strokes
 * were written then, and text boxes made then. A page edited that day but with no recognised text
 * falls back to its whole text. One source per page.
 */
export function noteSourcesForDay(note: Pick<NoteMeta, 'id' | 'title'>, pages: readonly PageInk[], from: number, to: number): SourceDraft[] {
  const out: SourceDraft[] = [];
  pages.forEach((page, pageIndex) => {
    const inDay = (t: number) => t >= from && t < to;
    // The user's own writing only: not AI ink, solver results or imported content.
    const own = (origin: string | undefined) => !origin || origin === 'recognized';
    const strokesToday = new Set(page.strokes.filter((s) => { const [a, b] = strokeSpan(s); return inDay(a) || inDay(b); }).filter((s) => own(s.origin)).map((s) => s.id));
    const textsToday = (page.texts ?? []).filter((t) => inDay(t.createdAt) && own(t.origin));
    if (!strokesToday.size && !textsToday.length) return;
    const parts: string[] = [];
    let rect: Rect | null = null;
    let first = Infinity;
    for (const s of page.strokes) if (strokesToday.has(s.id)) first = Math.min(first, strokeSpan(s)[0]);
    for (const t of textsToday) first = Math.min(first, t.createdAt);
    const lines = page.recognizedLines ?? [];
    for (const l of lines) {
      if (!l.strokeIds.some((id) => strokesToday.has(id))) continue;
      parts.push(l.text);
      rect = unionRect(rect, l.bounds);
    }
    for (const t of textsToday) {
      parts.push(t.text);
      rect = unionRect(rect, { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.fontSize * 1.4 });
    }
    if (!parts.length && strokesToday.size) {
      // Ink with no line-level recognition: the page's whole text is the best we have.
      const whole = pageText(page).trim();
      if (whole) parts.push(whole);
    }
    const text = parts.join('\n').trim();
    if (!text) return;
    const h = sentenceHash(text.split(/(?<=[.!?])\s+|\n/)[0] ?? text);
    out.push({
      kind: 'note',
      title: note.title || 'Untitled',
      at: Number.isFinite(first) ? first : from,
      text: clip(text, MAX.note),
      anchor: formatAnchor({ noteId: note.id, page: pageIndex, ...(rect ? { rect } : {}), h }),
      noteId: note.id,
      pageIndex,
      link: `#mem/${encodeURIComponent(note.id)}/${pageIndex + 1}`,
    });
  });
  return out;
}

/** What was said during `[from, to)` in a note's recordings (one source per recording). */
export function speechSourcesForDay(note: Pick<NoteMeta, 'id' | 'title' | 'recordings'>, transcripts: readonly TranscriptFile[], from: number, to: number): SourceDraft[] {
  const out: SourceDraft[] = [];
  for (const t of transcripts) {
    const clipMeta = note.recordings?.find((r) => r.id === t.clipId);
    if (!clipMeta) continue;
    const segs = t.segments.filter((s) => { const [a] = segmentSpan(clipMeta, s); return a >= from && a < to; });
    if (!segs.length) continue;
    const text = segs.map((s) => s.text.trim()).filter(Boolean).join(' ');
    if (!text) continue;
    const [at] = segmentSpan(clipMeta, segs[0]!);
    const [, end] = segmentSpan(clipMeta, segs[segs.length - 1]!);
    out.push({
      kind: 'speech',
      title: clipMeta.title || note.title || 'Recording',
      at,
      end,
      text: clip(text, MAX.speech),
      anchor: formatAnchor({ noteId: note.id, page: 0, clip: t.clipId, ms: segs[0]!.startMs, h: '0' }),
      noteId: note.id,
      link: `#said/${encodeURIComponent(note.id)}/${encodeURIComponent(t.clipId)}/${Math.round(segs[0]!.startMs)}`,
    });
  }
  return out;
}

const hhmm = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Calendar events of the day. */
export function eventSources(events: readonly IcsOccurrence[]): SourceDraft[] {
  return events.map((e) => {
    const when = e.allDay ? 'all day' : `${hhmm(e.start)}–${hhmm(e.end)}`;
    const text = [`${e.title} (${when})`, e.location ? `at ${e.location}` : '', e.description ? clip(e.description.replace(/\s+/g, ' '), 160) : ''].filter(Boolean).join(' · ');
    return { kind: 'event' as const, title: e.title, at: e.start, end: e.end, text: clip(text, MAX.event) };
  });
}

/**
 * Memory-timeline moments, grouped by app and hour so a day of screens becomes a few dozen
 * sources at most; each keeps its distinct lines (most recent last) within the budget.
 */
export function captureSources(captures: readonly Capture[]): SourceDraft[] {
  const groups = new Map<string, Capture[]>();
  for (const c of captures) {
    const d = new Date(c.at);
    const key = `${c.kind}|${c.app ?? ''}|${d.getHours()}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(c);
  }
  const out: SourceDraft[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.at - b.at);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const c of g) {
      for (const l of [c.title ?? '', ...c.text.split('\n')]) {
        const t = l.trim();
        if (t.length < 3 || seen.has(t)) continue;
        seen.add(t);
        lines.push(t);
      }
    }
    const first = g[0]!;
    const kind = first.kind === 'audio' ? 'audio' : 'screen';
    const text = clip(lines.join('\n'), MAX[kind]);
    if (!text) continue;
    out.push({ kind, title: first.kind === 'audio' ? 'Heard nearby' : first.app || 'Screen', at: first.at, end: g[g.length - 1]!.end ?? g[g.length - 1]!.at, text, link: `#recall/${first.at}` });
  }
  return out;
}

/** Orders the day's sources by time, assigns citation ids and keeps the total within `budget` characters. */
export function collectJournalSources(parts: readonly SourceDraft[], budget = 14_000): JournalSource[] {
  const sorted = [...parts].sort((a, b) => a.at - b.at);
  // Over budget: drop screen moments first, then trim the longest sources.
  let total = sorted.reduce((n, s) => n + s.text.length, 0);
  let kept = sorted;
  if (total > budget) {
    const screens = sorted.filter((s) => s.kind === 'screen' || s.kind === 'audio').sort((a, b) => a.text.length - b.text.length);
    const drop = new Set<SourceDraft>();
    while (total > budget && screens.length) { const s = screens.pop()!; drop.add(s); total -= s.text.length; }
    kept = sorted.filter((s) => !drop.has(s));
    if (total > budget) {
      const scale = budget / total;
      kept = kept.map((s) => ({ ...s, text: clip(s.text, Math.max(120, Math.floor(s.text.length * scale))) }));
    }
  }
  return kept.map((s, i) => ({ ...s, id: `s${i + 1}` }));
}

/** The sources as the model sees them (no internal links or anchors). */
export function sourcesForModel(sources: readonly JournalSource[]): Array<{ id: string; kind: JournalSourceKind; title: string; time: string; text: string }> {
  return sources.map((s) => ({ id: s.id, kind: s.kind, title: s.title, time: s.end && s.end - s.at >= 60_000 ? `${hhmm(s.at)}–${hhmm(s.end)}` : hhmm(s.at), text: s.text }));
}
