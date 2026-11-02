import type { TranscriptSegment } from '@inkstone/core';
import type { AudioWindow } from './audio.ts';

/**
 * Turning a window's text into timestamped transcript segments.
 *
 * Whisper returns its own timestamps; those are used as they are. Moonshine, provider endpoints
 * and most others return plain text for the window, so the text is split into sentences and laid
 * over the window's *speech* (the VAD regions, not the silences) in proportion to their length.
 * At speaking pace the error is a second or two — enough to line a sentence up with the ink
 * written while it was said, which is what the timestamps are for.
 */

export interface TimedText {
  text: string;
  /** Seconds from the start of the window's audio. */
  start: number;
  end: number | null;
}

/** Sentences (and over-long sentences cut at commas or words), trimmed, non-empty. */
export function splitSentences(text: string, maxChars = 220): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.match(/[^.!?。！？]+(?:[.!?。！？]+["”’)]?|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= maxChars) { out.push(p); continue; }
    let cur = '';
    for (const word of p.split(/(?<=,)\s+|\s+/)) {
      if (cur && (cur + ' ' + word).length > maxChars) { out.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
  }
  // Fold fragments ("OK.") into the next sentence so segments read naturally.
  const merged: string[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.length < 12) merged[merged.length - 1] = `${prev} ${s}`;
    else merged.push(s);
  }
  return merged;
}

/** The time (ms) a fraction `f` of the way through the speech regions. */
export function timeAlongSpeech(regions: ReadonlyArray<readonly [number, number]>, f: number): number {
  const total = regions.reduce((a, [s, e]) => a + Math.max(0, e - s), 0);
  if (!regions.length) return 0;
  let left = Math.max(0, Math.min(1, f)) * total;
  for (const [s, e] of regions) {
    const d = Math.max(0, e - s);
    if (left <= d) return s + left;
    left -= d;
  }
  return regions[regions.length - 1]![1];
}

/** Lays sentences over the speech regions by character count. */
export function distributeText(text: string, regions: ReadonlyArray<readonly [number, number]>, fallback: readonly [number, number]): Array<{ text: string; startMs: number; endMs: number }> {
  const sentences = splitSentences(text);
  if (!sentences.length) return [];
  const spans = regions.length ? regions : [fallback];
  const total = sentences.reduce((a, s) => a + s.length, 0) || 1;
  let acc = 0;
  return sentences.map((s) => {
    const startMs = timeAlongSpeech(spans, acc / total);
    acc += s.length;
    const endMs = timeAlongSpeech(spans, acc / total);
    return { text: s, startMs: Math.round(startMs), endMs: Math.round(Math.max(endMs, startMs)) };
  });
}

/** Text Whisper produces for silence or noise ("[Music]", "(applause)", "Thank you." alone…). */
const NOISE = /^\s*(?:[[(][^\])]{0,40}[\])]\s*)+$/;

/** Segment id: base-36 start time plus index, unique within a run. */
export const segmentId = (startMs: number, i: number) => `${Math.round(startMs).toString(36)}-${i}`;

/**
 * Segments for one transcribed window. `chunks` are the model's own timestamps (seconds from the
 * start of the window audio), used when present; otherwise the text is spread over the speech.
 */
export function windowSegments(w: Pick<AudioWindow, 'startMs' | 'endMs' | 'speech'>, text: string, chunks?: readonly TimedText[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const push = (t: string, a: number, b: number) => {
    const clean = t.replace(/\s+/g, ' ').trim();
    if (!clean || NOISE.test(clean)) return;
    const startMs = Math.round(Math.max(w.startMs, Math.min(a, w.endMs)));
    const endMs = Math.round(Math.max(startMs, Math.min(b, w.endMs)));
    out.push({ id: segmentId(startMs, out.length), startMs, endMs, text: clean });
  };
  const timed = chunks?.filter((c) => c.text.trim() && Number.isFinite(c.start));
  if (timed?.length) {
    timed.forEach((c, i) => {
      const next = timed[i + 1];
      const end = c.end ?? next?.start ?? (w.endMs - w.startMs) / 1000;
      push(c.text, w.startMs + c.start * 1000, w.startMs + end * 1000);
    });
    return out;
  }
  for (const s of distributeText(text, w.speech, [w.startMs, w.endMs])) push(s.text, s.startMs, s.endMs);
  return out;
}
