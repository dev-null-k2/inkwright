import { formatStamp, parseStamp, type TranscriptSegment } from '@inkstone/core';
import { extractJson } from '../json.ts';
import type { ChatMessage } from '../types.ts';

/**
 * Prompts for "notes that listen": a summary of each page (what was said while it was written,
 * plus what is on it), a whole-lecture summary with key terms and to-dos, and answers to questions
 * asked *during* a recording with `[m:ss]` citations into the transcript. Kept short and explicit
 * so the small on-device models (Qwen3 0.6B–4B, Granite 4.0) follow them.
 */

export interface StampedLine {
  /** ms from the start of the recording. */
  ms: number;
  text: string;
}

export const stampLines = (segs: readonly Pick<TranscriptSegment, 'startMs' | 'text'>[]): StampedLine[] => segs.map((s) => ({ ms: s.startMs, text: s.text }));

const render = (lines: readonly StampedLine[]) => lines.map((l) => `[${formatStamp(l.ms)}] ${l.text}`).join('\n');

/** Keeps the newest lines that fit `maxChars` (live context) or the whole thing, evenly thinned. */
export function fitLines(lines: readonly StampedLine[], maxChars: number, keep: 'newest' | 'spread' = 'newest'): StampedLine[] {
  const cost = (l: StampedLine) => l.text.length + 8;
  const total = lines.reduce((a, l) => a + cost(l), 0);
  if (total <= maxChars) return [...lines];
  if (keep === 'spread') {
    const step = Math.ceil(total / maxChars);
    return lines.filter((_, i) => i % step === 0);
  }
  const out: StampedLine[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + cost(lines[i]!) > maxChars) break;
    used += cost(lines[i]!);
    out.unshift(lines[i]!);
  }
  return out;
}

/** "Summarize this page." Returns 1–4 short bullet points as Markdown. */
export function pageSummaryMessages(a: { title: string; pageNumber: number; pageText: string; said: readonly StampedLine[]; maxChars?: number }): ChatMessage[] {
  const said = fitLines(a.said, a.maxChars ?? 6000, 'spread');
  const system = 'You write short study notes. Summarize one page of a student’s notes from what is written on it and what was said in the lecture while it was being written. Write 1 to 4 bullet points in Markdown ("- …"), plain and specific, in the language of the material. Use only the material given. No preamble.';
  const user = [
    `Note: ${a.title || 'Untitled'}, page ${a.pageNumber}`,
    `Written on the page:\n${a.pageText.trim() || '(handwriting not transcribed)'}`,
    said.length ? `Said while this page was written:\n${render(said)}` : 'Nothing was recorded while this page was written.',
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Bullets only, trimmed (models sometimes add a heading or a closing remark). */
export function cleanSummary(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const bullets = t.split('\n').map((l) => l.trim()).filter((l) => /^[-*•]\s+/.test(l)).map((l) => `- ${l.replace(/^[-*•]\s+/, '')}`);
  return bullets.length ? bullets.slice(0, 6).join('\n') : t;
}

export interface LectureSummaryResult {
  summary: string;
  keyTerms: string[];
  todos: string[];
}

/** The whole recording: a summary, key terms and to-dos, as JSON. */
export function lectureSummaryMessages(a: { title: string; transcript: readonly StampedLine[]; notesText: string; maxChars?: number }): ChatMessage[] {
  const lines = fitLines(a.transcript, a.maxChars ?? 9000, 'spread');
  const system = 'You summarize recorded lectures and meetings for the person who took notes. Reply with JSON only: {"summary": "3-6 sentences", "keyTerms": ["term", …], "todos": ["task", …]}. keyTerms: up to 8 important terms or names that were said. todos: assignments, deadlines or follow-ups that were mentioned (empty list if none). Use only the transcript and notes given, in their language.';
  const user = [
    `Title: ${a.title || 'Untitled'}`,
    `Transcript:\n${render(lines) || '(nothing transcribed)'}`,
    a.notesText.trim() ? `Their notes:\n${a.notesText.slice(0, 3000)}` : '',
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function parseLectureSummary(text: string): LectureSummaryResult {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  let j: unknown = null;
  try {
    j = extractJson(clean);
  } catch {
    j = null;
  }
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : []);
  const summary = typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : j ? '' : clean;
  return { summary, keyTerms: list(o.keyTerms ?? o.key_terms), todos: list(o.todos ?? o.toDos ?? o.tasks) };
}

/**
 * Context for a question asked while recording: the transcript so far (newest kept when long),
 * how far into the recording we are, and what is on the current page. Goes into the assistant's
 * system prompt next to the open note.
 */
export function liveTranscriptContext(a: { elapsedMs: number; segments: readonly Pick<TranscriptSegment, 'startMs' | 'text'>[]; pageNumber: number; pageText: string; maxChars?: number }): string {
  const lines = fitLines(stampLines(a.segments), a.maxChars ?? 6000, 'newest');
  return [
    `A recording is in progress (${formatStamp(a.elapsedMs)} so far). The user may ask about what was just said. The live transcript so far${lines.length < a.segments.length ? ' (latest part)' : ''}, with times from the start of the recording:`,
    lines.length ? render(lines) : '(nothing transcribed yet)',
    `They are writing on page ${a.pageNumber}${a.pageText.trim() ? `, which says:\n${a.pageText.slice(0, 2000)}` : ' (handwriting not transcribed yet).'}`,
    'When you use the transcript, cite the time of the line you used in square brackets, like [12:03]. "Just now" means the last minute or two. If the transcript does not cover it, say so.',
  ].join('\n');
}

/** A `[m:ss]` citation resolved to a segment of the recording. */
export interface StampCitation {
  /** The text as written in the answer, e.g. `[12:03]`. */
  raw: string;
  ms: number;
  segment: Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'> | null;
}

/** Finds `[m:ss]` / `[h:mm:ss]` citations and the segment each points at (nearest start within 15 s). */
export function findStampCitations(text: string, segments: readonly Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'>[]): StampCitation[] {
  const out: StampCitation[] = [];
  for (const m of text.matchAll(/\[((?:\d+:)?\d{1,2}:\d{2})\]/g)) {
    const ms = parseStamp(m[1]!);
    if (ms == null) continue;
    let best: StampCitation['segment'] = null;
    let bestD = Infinity;
    for (const s of segments) {
      const d = ms >= s.startMs && ms <= s.endMs ? 0 : Math.min(Math.abs(s.startMs - ms), Math.abs(s.endMs - ms));
      if (d < bestD) { bestD = d; best = s; }
    }
    out.push({ raw: m[0], ms, segment: bestD <= 15_000 ? best : null });
  }
  return out;
}

/**
 * Turns valid `[m:ss]` citations into Markdown links (`[m:ss](<href>)`); times that match no
 * segment stay plain text, so a model can't link to speech that doesn't exist.
 */
export function linkStampCitations(text: string, segments: readonly Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'>[], href: (seg: Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'>, ms: number) => string): string {
  return text.replace(/\[((?:\d+:)?\d{1,2}:\d{2})\](?!\()/g, (raw) => {
    const c = findStampCitations(raw, segments)[0];
    return c?.segment ? `${raw.slice(0, -1)}](${href(c.segment, c.ms)})` : raw;
  });
}
