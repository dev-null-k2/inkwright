/**
 * Transcripts of audio recordings, lined up with the ink written while they were spoken.
 *
 * Every stroke, text box and image carries its wall-clock `createdAt`, and every recording its
 * `startedAt`, so "what was said while I wrote this" is plain time arithmetic: a transcript
 * segment covers `[clip.startedAt + startMs, clip.startedAt + endMs]`, and the ink whose writing
 * time overlaps that span is the ink "written then". This module holds the vault format for
 * transcripts and page summaries (docs/VAULT_FORMAT.md § Transcripts), the time ↔ ink mapping
 * used by the transcript panel and citations, the page bucketing used by per-page summaries, and
 * the anchored passages ("what was said") that go into the semantic memory index.
 *
 * Everything here is pure, so the alignment rules are unit-tested without a browser.
 */
import { boundsOfStrokes } from './gestures.ts';
import { rectIsEmpty, rectUnion, type Rect } from './geometry.ts';
import type { AudioClip, InkStroke, NoteMeta, PageInk } from './model.ts';

// ---- Vault format ------------------------------------------------------------------------------

export const TRANSCRIPT_FORMAT_VERSION = 1;

/** One stretch of speech: times are ms from the start of its recording. */
export interface TranscriptSegment {
  /** Unique within the transcript (stable across saves so sync can merge by id). */
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

/** Where the audio was turned into text (shown as the privacy indicator). */
export type SpeechWhere = 'device' | 'browser' | 'provider';

/** A whole-lecture summary for one recording. */
export interface LectureSummary {
  summary: string;
  keyTerms: string[];
  todos: string[];
  /** Epoch ms it was written. */
  at: number;
  /** Which AI wrote it (shown, never trusted for anything). */
  by: string;
}

/** `notes/<noteId>/assets/<clipId>.transcript.json` */
export interface TranscriptFile {
  formatVersion: number;
  clipId: string;
  /**
   * One transcription pass. Live transcription and a later "transcribe again" are different runs;
   * sync merges segments by id within a run and takes the newer run wholesale otherwise.
   */
  run: string;
  /** Engine id, e.g. `device:moonshine-base`, `browser`, `provider:openai:gpt-4o-mini-transcribe`. */
  engine: string;
  where: SpeechWhere;
  language?: string;
  /** False while the recording (or a re-transcription) is still running. */
  complete: boolean;
  updatedAt: number;
  segments: TranscriptSegment[];
  lecture?: LectureSummary;
}

/** A summary of one page: what was said while it was written, plus what is on it. */
export interface PageSummary {
  text: string;
  at: number;
  by: string;
  /** Recordings it drew on (empty when made from the page content alone). */
  clipIds: string[];
}

/** `notes/<noteId>/assets/page-summaries.json`, keyed by page id. */
export interface PageSummariesFile {
  formatVersion: number;
  updatedAt: number;
  pages: Record<string, PageSummary>;
}

export const PAGE_SUMMARIES_ASSET = 'page-summaries.json';
export const TRANSCRIPT_SUFFIX = '.transcript.json';

/** Asset name of a recording's transcript. */
export function transcriptAssetName(clipId: string): string {
  return `${clipId}${TRANSCRIPT_SUFFIX}`;
}

/** The clip id of a transcript asset name, or null for other assets. */
export function clipIdOfTranscript(name: string): string | null {
  return name.endsWith(TRANSCRIPT_SUFFIX) ? name.slice(0, -TRANSCRIPT_SUFFIX.length) || null : null;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function decodeLecture(v: unknown): LectureSummary | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return { summary: str(o.summary), keyTerms: strs(o.keyTerms), todos: strs(o.todos), at: num(o.at), by: str(o.by) };
}

/** Parses a transcript file leniently (unknown fields dropped, bad segments skipped). Throws on non-JSON. */
export function decodeTranscript(json: string): TranscriptFile {
  const o = JSON.parse(json) as Record<string, unknown>;
  if (!o || typeof o !== 'object' || typeof o.clipId !== 'string') throw new Error('Not a transcript file');
  const segments: TranscriptSegment[] = [];
  for (const s of Array.isArray(o.segments) ? o.segments : []) {
    if (!s || typeof s !== 'object' || typeof (s as TranscriptSegment).id !== 'string' || typeof (s as TranscriptSegment).text !== 'string') continue;
    const seg = s as TranscriptSegment;
    segments.push({ id: seg.id, startMs: Math.max(0, num(seg.startMs)), endMs: Math.max(num(seg.startMs), num(seg.endMs)), text: seg.text });
  }
  const where = o.where === 'device' || o.where === 'browser' || o.where === 'provider' ? o.where : 'provider';
  const out: TranscriptFile = {
    formatVersion: num(o.formatVersion, TRANSCRIPT_FORMAT_VERSION),
    clipId: o.clipId,
    run: str(o.run, 'run'),
    engine: str(o.engine),
    where,
    complete: o.complete !== false,
    updatedAt: num(o.updatedAt),
    segments: sortSegments(segments),
  };
  if (typeof o.language === 'string') out.language = o.language;
  const lecture = decodeLecture(o.lecture);
  if (lecture) out.lecture = lecture;
  return out;
}

export function encodeTranscript(t: TranscriptFile): string {
  return JSON.stringify({ ...t, formatVersion: TRANSCRIPT_FORMAT_VERSION, segments: sortSegments(t.segments) }, null, 1);
}

export function decodePageSummaries(json: string): PageSummariesFile {
  const o = JSON.parse(json) as Record<string, unknown>;
  const pages: Record<string, PageSummary> = {};
  const src = o && typeof o.pages === 'object' && o.pages ? (o.pages as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    if (typeof p.text !== 'string') continue;
    pages[id] = { text: p.text, at: num(p.at), by: str(p.by), clipIds: strs(p.clipIds) };
  }
  return { formatVersion: num(o?.formatVersion, TRANSCRIPT_FORMAT_VERSION), updatedAt: num(o?.updatedAt), pages };
}

export function encodePageSummaries(f: PageSummariesFile): string {
  return JSON.stringify({ ...f, formatVersion: TRANSCRIPT_FORMAT_VERSION }, null, 1);
}

export function sortSegments(segs: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segs].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}

/** The transcript as plain text with `[m:ss]` stamps, one line per segment. */
export function transcriptText(segments: readonly TranscriptSegment[], opts: { stamps?: boolean; offsetMs?: number } = {}): string {
  return segments.map((s) => (opts.stamps === false ? s.text : `[${formatStamp(s.startMs + (opts.offsetMs ?? 0))}] ${s.text}`)).join('\n');
}

/** `m:ss` (or `h:mm:ss`) for a time in ms. */
export function formatStamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Parses `m:ss` / `h:mm:ss` into ms, or null. */
export function parseStamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[3]) < 60 ? sec * 1000 : null;
}

// ---- Time ↔ ink ---------------------------------------------------------------------------------

/** When a stroke was being written: from pen-down to its last point. */
export function strokeSpan(s: InkStroke): [number, number] {
  const last = s.points.length ? s.points[s.points.length - 1]!.t : 0;
  return [s.createdAt, s.createdAt + Math.max(0, last)];
}

export interface InkMoment {
  pageIndex: number;
  strokeIds: string[];
  textIds: string[];
  /** Page-space bounds of everything written in the span (empty rect when only images). */
  bounds: Rect;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 && b0 <= a1;

/** Ink (strokes and text boxes) written during `[from, to]` (epoch ms), per page. */
export function inkWrittenBetween(pages: readonly PageInk[], from: number, to: number): InkMoment[] {
  const out: InkMoment[] = [];
  pages.forEach((page, pageIndex) => {
    const strokes = page.strokes.filter((s) => { const [a, b] = strokeSpan(s); return overlaps(a, b, from, to); });
    const texts = (page.texts ?? []).filter((t) => t.createdAt >= from && t.createdAt <= to);
    if (!strokes.length && !texts.length) return;
    let bounds = boundsOfStrokes(strokes);
    for (const t of texts) {
      const r: Rect = { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.fontSize * 1.4 };
      bounds = rectIsEmpty(bounds) ? r : rectUnion(bounds, r);
    }
    out.push({ pageIndex, strokeIds: strokes.map((s) => s.id), textIds: texts.map((t) => t.id), bounds });
  });
  return out;
}

/** Absolute (epoch ms) span of a segment. */
export function segmentSpan(clip: Pick<AudioClip, 'startedAt'>, seg: Pick<TranscriptSegment, 'startMs' | 'endMs'>): [number, number] {
  return [clip.startedAt + seg.startMs, clip.startedAt + seg.endMs];
}

/**
 * People write a moment after they hear something. Ink "written during" a sentence includes this
 * much after it ends, and a tap on ink looks this far back for the sentence that prompted it.
 */
export const WRITING_LAG_MS = 1500;

/** The ink written while a segment was spoken (plus the writing lag). */
export function inkForSegment(pages: readonly PageInk[], clip: Pick<AudioClip, 'startedAt'>, seg: Pick<TranscriptSegment, 'startMs' | 'endMs'>, lagMs = WRITING_LAG_MS): InkMoment[] {
  const [a, b] = segmentSpan(clip, seg);
  return inkWrittenBetween(pages, a, b + lagMs);
}

/**
 * The segment being spoken when something was written at `at` (epoch ms): the one whose span
 * contains `at - lag`, else the latest one that started before it (within 20 s), else null.
 */
export function segmentAtTime<S extends Pick<TranscriptSegment, 'startMs' | 'endMs'>>(segments: readonly S[], clip: Pick<AudioClip, 'startedAt' | 'durationMs'>, at: number, lagMs = WRITING_LAG_MS): S | null {
  const t = at - clip.startedAt;
  if (t < -lagMs || t > clip.durationMs + lagMs) return null;
  const probe = Math.max(0, t - lagMs);
  const inside = segments.find((s) => probe >= s.startMs && probe <= s.endMs) ?? segments.find((s) => t >= s.startMs && t <= s.endMs);
  if (inside) return inside;
  let best: S | null = null;
  for (const s of segments) if (s.startMs <= t && (!best || s.startMs > best.startMs)) best = s;
  return best && t - best.endMs <= 20_000 ? best : null;
}

/** The clip that was recording at `at` (the latest one when several overlap). */
export function clipAtTime<C extends Pick<AudioClip, 'startedAt' | 'durationMs'>>(clips: readonly C[], at: number, slackMs = WRITING_LAG_MS): C | null {
  return [...clips].reverse().find((c) => at >= c.startedAt - slackMs && at <= c.startedAt + c.durationMs + slackMs) ?? null;
}

/** Writing times on each page (sorted spans of strokes and text boxes). */
export function pageWritingTimes(pages: readonly PageInk[]): Array<Array<[number, number]>> {
  return pages.map((p) => [...p.strokes.map(strokeSpan), ...(p.texts ?? []).map((t): [number, number] => [t.createdAt, t.createdAt])].sort((a, b) => a[0] - b[0]));
}

export interface RecordingTranscript {
  clip: AudioClip;
  file: TranscriptFile;
}

/**
 * Assigns every segment of every recording to one page, for per-page summaries and for anchoring
 * "what was said" passages:
 * 1. the page with the most writing time during the segment (plus lag) wins;
 * 2. otherwise the page last written on before the segment (you were on that page, listening);
 * 3. otherwise the first page written on after it (talk before the first note on the page);
 * 4. otherwise (nothing written at all) page 0.
 */
export function bucketSegmentsByPage(pages: readonly PageInk[], recordings: readonly RecordingTranscript[], lagMs = WRITING_LAG_MS): Map<number, Array<{ clip: AudioClip; segment: TranscriptSegment }>> {
  const times = pageWritingTimes(pages);
  const out = new Map<number, Array<{ clip: AudioClip; segment: TranscriptSegment }>>();
  for (const { clip, file } of recordings) {
    for (const segment of file.segments) {
      const [a, b0] = segmentSpan(clip, segment);
      const b = b0 + lagMs;
      let page = -1;
      let most = 0;
      times.forEach((spans, i) => {
        let overlap = 0;
        for (const [s, e] of spans) if (overlaps(s, e, a, b)) overlap += Math.max(1, Math.min(e, b) - Math.max(s, a));
        if (overlap > most) { most = overlap; page = i; }
      });
      if (page < 0) {
        let lastBefore = -Infinity;
        times.forEach((spans, i) => { for (const [s] of spans) if (s <= a && s > lastBefore) { lastBefore = s; page = i; } });
      }
      if (page < 0) {
        let firstAfter = Infinity;
        times.forEach((spans, i) => { for (const [s] of spans) if (s >= a && s < firstAfter) { firstAfter = s; page = i; } });
      }
      if (page < 0) page = 0;
      if (page >= pages.length) page = Math.max(0, pages.length - 1);
      let list = out.get(page);
      if (!list) out.set(page, (list = []));
      list.push({ clip, segment });
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.clip.startedAt + x.segment.startMs - (y.clip.startedAt + y.segment.startMs));
  return out;
}

// ---- Memory passages ------------------------------------------------------------------------------

/** A passage of speech for the memory index (see memory.ts `MemoryChunk`, source `speech`). */
export interface SpeechPassage {
  pageIndex: number;
  clipId: string;
  startMs: number;
  endMs: number;
  text: string;
  rect?: Rect;
  strokeIds?: string[];
  /** Index of the passage within its recording (part of the chunk id). */
  n: number;
}

/**
 * Cuts each recording's transcript into passages of up to ~`maxChars`, never mixing pages, each
 * anchored to its recording and start time and to the ink written while it was said, so a cited
 * passage opens the note, seeks the audio and highlights that ink.
 */
export function speechPassages(note: Pick<NoteMeta, 'id'>, pages: readonly PageInk[], recordings: readonly RecordingTranscript[], maxChars = 500): SpeechPassage[] {
  const buckets = bucketSegmentsByPage(pages, recordings);
  const pageOf = new Map<string, number>();
  for (const [p, list] of buckets) for (const { clip, segment } of list) pageOf.set(`${clip.id}/${segment.id}`, p);
  const out: SpeechPassage[] = [];
  void note;
  for (const { clip, file } of recordings) {
    let n = 0;
    let cur: { page: number; segs: TranscriptSegment[]; len: number } | null = null;
    const flush = () => {
      if (!cur || !cur.segs.length) return;
      const first = cur.segs[0]!, last = cur.segs[cur.segs.length - 1]!;
      const text = cur.segs.map((s) => s.text.trim()).filter(Boolean).join(' ');
      if (text) {
        const p: SpeechPassage = { pageIndex: cur.page, clipId: clip.id, startMs: first.startMs, endMs: last.endMs, text, n: n++ };
        const ink = inkForSegment(pages, clip, { startMs: first.startMs, endMs: last.endMs }).find((m) => m.pageIndex === cur!.page);
        if (ink && !rectIsEmpty(ink.bounds)) p.rect = ink.bounds;
        if (ink?.strokeIds.length) p.strokeIds = ink.strokeIds;
        out.push(p);
      }
      cur = null;
    };
    for (const seg of file.segments) {
      if (!seg.text.trim()) continue;
      const page = pageOf.get(`${clip.id}/${seg.id}`) ?? 0;
      if (cur && (cur.page !== page || cur.len + seg.text.length + 1 > maxChars)) flush();
      if (!cur) cur = { page, segs: [], len: 0 };
      cur.segs.push(seg);
      cur.len += seg.text.length + 1;
    }
    flush();
  }
  return out;
}
