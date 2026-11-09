/**
 * Meeting coaching from the transcript: who talked how much, the longest stretch one person held
 * the floor, questions asked, speaking pace and filler words. Speakers come from a recorded call
 * (`me` / `them`) or a provider's labels; without speakers only the totals are known.
 */
import type { TranscriptSegment } from '../transcript.ts';

export interface SpeakerStats {
  speaker: string;
  /** Speaking time (ms). */
  talkMs: number;
  share: number;
  words: number;
  /** Words per minute while speaking. */
  wpm: number;
  questions: number;
  fillers: number;
  /** The longest unbroken stretch (ms). */
  longestMs: number;
}

export interface MeetingStats {
  durationMs: number;
  talkMs: number;
  speakers: SpeakerStats[];
  /** Filler words found, most frequent first. */
  topFillers: Array<{ word: string; count: number }>;
  /** Times the speaker changed per minute (how conversational it was). */
  turnsPerMinute: number;
}

const FILLERS = ['um', 'uh', 'erm', 'like', 'you know', 'i mean', 'sort of', 'kind of', 'basically', 'actually', 'literally', 'right'];

function countFillers(text: string, tally: Map<string, number>): number {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ')} `;
  let n = 0;
  for (const f of FILLERS) {
    // "like" and "right" count only as fillers between commas or at the start/end of a phrase.
    const re = f === 'like' || f === 'right' ? null : new RegExp(` ${f} `, 'g');
    const hits = re ? (t.match(re)?.length ?? 0) : (text.toLowerCase().trim().match(new RegExp(`(^|[,.!?]\\s)${f},`, 'g'))?.length ?? 0);
    if (hits) { n += hits; tally.set(f, (tally.get(f) ?? 0) + hits); }
  }
  return n;
}

const wordsIn = (t: string) => (t.match(/[\p{L}\p{N}']+/gu) ?? []).length;

export function meetingStats(segments: readonly TranscriptSegment[], durationMs?: number): MeetingStats {
  const segs = [...segments].filter((s) => s.text.trim()).sort((a, b) => a.startMs - b.startMs);
  const by = new Map<string, SpeakerStats>();
  const tally = new Map<string, number>();
  let turns = 0;
  let prev: string | undefined;
  let runStart = 0;
  let runEnd = 0;
  const closeRun = () => {
    if (prev == null) return;
    const s = by.get(prev)!;
    s.longestMs = Math.max(s.longestMs, runEnd - runStart);
  };
  for (const seg of segs) {
    const who = seg.speaker ?? 'all';
    const s = by.get(who) ?? { speaker: who, talkMs: 0, share: 0, words: 0, wpm: 0, questions: 0, fillers: 0, longestMs: 0 };
    const len = Math.max(0, seg.endMs - seg.startMs);
    s.talkMs += len;
    s.words += wordsIn(seg.text);
    s.questions += (seg.text.match(/\?/g) ?? []).length;
    s.fillers += countFillers(seg.text, tally);
    by.set(who, s);
    if (who !== prev) {
      closeRun();
      if (prev != null) turns++;
      prev = who;
      runStart = seg.startMs;
    }
    runEnd = seg.endMs;
  }
  closeRun();
  const talkMs = [...by.values()].reduce((a, s) => a + s.talkMs, 0);
  for (const s of by.values()) {
    s.share = talkMs ? s.talkMs / talkMs : 0;
    s.wpm = s.talkMs > 5000 ? Math.round(s.words / (s.talkMs / 60_000)) : 0;
  }
  const dur = durationMs ?? (segs.length ? segs[segs.length - 1]!.endMs : 0);
  return {
    durationMs: dur,
    talkMs,
    speakers: [...by.values()].sort((a, b) => (a.speaker === 'me' ? -1 : b.speaker === 'me' ? 1 : b.talkMs - a.talkMs)),
    topFillers: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word, count]) => ({ word, count })),
    turnsPerMinute: dur > 60_000 ? Math.round((turns / (dur / 60_000)) * 10) / 10 : 0,
  };
}

/** The stats as plain lines for a coaching prompt. */
export function statsText(st: MeetingStats, name: (speaker: string) => string): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const min = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
  const lines = st.speakers.map((s) => `${name(s.speaker)}: talked ${pct(s.share)} (${min(s.talkMs)}), ${s.wpm || '?'} words a minute, ${s.questions} questions, longest stretch ${min(s.longestMs)}, ${s.fillers} filler words`);
  if (st.topFillers.length) lines.push(`Most used filler words: ${st.topFillers.map((f) => `"${f.word}" ×${f.count}`).join(', ')}`);
  if (st.turnsPerMinute) lines.push(`Turns per minute: ${st.turnsPerMinute}`);
  return lines.join('\n');
}

// ---- Clips ---------------------------------------------------------------------------------------

/** A moment someone marked while recording (a tap on Mark, or a star drawn in the margin). */
export interface MeetingMark {
  id: string;
  /** ms from the start of the recording. */
  ms: number;
  label?: string;
}

/** The span of a clip around a moment: from a little before the sentence to a little after. */
export function clipSpan(segments: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[], ms: number, opts: { before?: number; after?: number; max?: number } = {}): { startMs: number; endMs: number } {
  const before = opts.before ?? 4000;
  const after = opts.after ?? 4000;
  const max = opts.max ?? 60_000;
  const seg = segments.find((s) => ms >= s.startMs && ms <= s.endMs) ?? segments.find((s) => s.startMs >= ms) ?? null;
  const start = Math.max(0, (seg ? Math.min(seg.startMs, ms) : ms) - before);
  const end = Math.min(start + max, (seg ? Math.max(seg.endMs, ms) : ms + 8000) + after);
  return { startMs: start, endMs: end };
}

/** 16-bit mono WAV bytes from float PCM (what a clip is shared as). */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  return new Uint8Array(buf);
}
