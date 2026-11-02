import { describe, expect, it } from 'vitest';
import {
  bucketSegmentsByPage,
  chunkNote,
  clipAtTime,
  clipIdOfTranscript,
  decodePageSummaries,
  decodeTranscript,
  encodePageSummaries,
  encodeTranscript,
  formatStamp,
  inkForSegment,
  inkWrittenBetween,
  newNote,
  newPage,
  parseStamp,
  segmentAtTime,
  speechPassages,
  strokeSpan,
  transcriptAssetName,
  transcriptText,
  type AudioClip,
  type PageInk,
  type TranscriptFile,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

const T0 = 1_700_000_000_000;
const clip: AudioClip = { id: 'clip1', asset: 'clip1.webm', startedAt: T0, durationMs: 120_000, mimeType: 'audio/webm' };

/** A stroke written at `at` ms into the recording, taking ~800 ms. */
const at = (id: string, ms: number, y = 100) => ({ ...stroke(id, word(80, y, 120)), createdAt: T0 + ms });

function file(segments: TranscriptFile['segments'], extra: Partial<TranscriptFile> = {}): TranscriptFile {
  return { formatVersion: 1, clipId: clip.id, run: 'r1', engine: 'device:moonshine-base', where: 'device', complete: true, updatedAt: T0, segments, ...extra };
}

describe('transcript files', () => {
  it('round-trips, sorts segments and drops malformed ones', () => {
    const t = file([{ id: 'b', startMs: 5000, endMs: 7000, text: 'second' }, { id: 'a', startMs: 0, endMs: 4000, text: 'first' }], { lecture: { summary: 'S', keyTerms: ['x'], todos: [], at: 1, by: 'ai' }, language: 'en-US' });
    const back = decodeTranscript(encodeTranscript(t));
    expect(back.segments.map((s) => s.id)).toEqual(['a', 'b']);
    expect(back.lecture).toEqual(t.lecture);
    expect(back.language).toBe('en-US');
    const messy = decodeTranscript(JSON.stringify({ clipId: 'c', segments: [{ id: 'ok', startMs: 3, endMs: 1, text: 'x' }, { id: 5 }, null], where: 'mars', extra: true }));
    expect(messy.segments).toEqual([{ id: 'ok', startMs: 3, endMs: 3, text: 'x' }]);
    expect(messy.where).toBe('provider');
    expect(messy.complete).toBe(true);
    expect(() => decodeTranscript('{"segments":[]}')).toThrow();
  });

  it('names assets next to the clip', () => {
    expect(transcriptAssetName('01ABC')).toBe('01ABC.transcript.json');
    expect(clipIdOfTranscript('01ABC.transcript.json')).toBe('01ABC');
    expect(clipIdOfTranscript('01ABC.webm')).toBeNull();
    expect(/^[0-9A-Za-z_.-]{1,96}$/.test(transcriptAssetName('0123456789ABCDEFGHJKMN'))).toBe(true);
  });

  it('round-trips page summaries', () => {
    const f = { formatVersion: 1, updatedAt: 5, pages: { p1: { text: '- a', at: 3, by: 'ai', clipIds: ['c'] } } };
    expect(decodePageSummaries(encodePageSummaries(f))).toEqual(f);
    expect(decodePageSummaries('{"pages":{"p":{"at":1}}}').pages).toEqual({});
  });

  it('formats and parses stamps', () => {
    expect(formatStamp(0)).toBe('0:00');
    expect(formatStamp(83_400)).toBe('1:23');
    expect(formatStamp(3_725_000)).toBe('1:02:05');
    expect(parseStamp('1:23')).toBe(83_000);
    expect(parseStamp('1:02:05')).toBe(3_725_000);
    expect(parseStamp('1:75')).toBeNull();
    expect(parseStamp('abc')).toBeNull();
    expect(transcriptText([{ startMs: 61_000, text: 'Hi' }] as any)).toBe('[1:01] Hi');
  });
});

describe('time ↔ ink', () => {
  const page: PageInk = { ...newPage('p1'), strokes: [at('s1', 2_000, 100), at('s2', 10_000, 140), at('s3', 30_000, 180)], texts: [{ id: 't1', x: 60, y: 300, width: 200, text: 'typed', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: T0 + 31_000 }] };

  it('spans a stroke from pen-down to its last point', () => {
    const s = at('x', 1000);
    const [a, b] = strokeSpan(s);
    expect(a).toBe(T0 + 1000);
    expect(b).toBe(T0 + 1000 + s.points.at(-1)!.t);
  });

  it('finds ink written during a span, with bounds', () => {
    const m = inkWrittenBetween([page], T0 + 9_000, T0 + 12_000);
    expect(m).toHaveLength(1);
    expect(m[0]!.strokeIds).toEqual(['s2']);
    expect(m[0]!.bounds.minY).toBeGreaterThan(120);
    const both = inkWrittenBetween([page], T0 + 29_000, T0 + 32_000)[0]!;
    expect(both.strokeIds).toEqual(['s3']);
    expect(both.textIds).toEqual(['t1']);
    expect(inkWrittenBetween([page], T0 + 50_000, T0 + 60_000)).toEqual([]);
  });

  it('includes the writing lag after a sentence', () => {
    // Said 8.0–8.7 s; the note was written at 10 s, within 1.5 s of the end.
    expect(inkForSegment([page], clip, { startMs: 8_000, endMs: 8_700 })[0]?.strokeIds).toEqual(['s2']);
    expect(inkForSegment([page], clip, { startMs: 8_000, endMs: 8_000 }, 0)).toEqual([]);
  });

  it('finds the sentence being said when ink was written', () => {
    const segs = [{ id: 'a', startMs: 0, endMs: 5_000 }, { id: 'b', startMs: 6_000, endMs: 11_000 }, { id: 'c', startMs: 25_000, endMs: 28_000 }];
    expect(segmentAtTime(segs, clip, T0 + 10_500)?.id).toBe('b'); // probe at 9 s
    expect(segmentAtTime(segs, clip, T0 + 6_500)?.id).toBe('a'); // written 1.5 s after: the sentence before
    expect(segmentAtTime(segs, clip, T0 + 40_000)?.id).toBe('c'); // after the last sentence: the latest one
    expect(segmentAtTime(segs, clip, T0 + 60_000)).toBeNull(); // too long after anything
    expect(segmentAtTime(segs, clip, T0 - 10_000)).toBeNull(); // before the recording
  });

  it('finds the recording running at a moment (latest wins)', () => {
    const c2: AudioClip = { ...clip, id: 'clip2', startedAt: T0 + 100_000 };
    expect(clipAtTime([clip, c2], T0 + 110_000)?.id).toBe('clip2');
    expect(clipAtTime([clip, c2], T0 + 50_000)?.id).toBe('clip1');
    expect(clipAtTime([clip, c2], T0 + 500_000)).toBeNull();
  });
});

describe('page bucketing for summaries', () => {
  const p0: PageInk = { ...newPage('p0'), strokes: [at('a', 1_000), at('b', 20_000)] };
  const p1: PageInk = { ...newPage('p1'), strokes: [at('c', 60_000), at('d', 61_000)] };
  const p2: PageInk = newPage('p2');

  it('assigns each segment to exactly one page', () => {
    const segs = [
      { id: 's0', startMs: 0, endMs: 2_000, text: 'during a' }, // writing on p0
      { id: 's1', startMs: 30_000, endMs: 35_000, text: 'between' }, // nothing written: last page written before (p0)
      { id: 's2', startMs: 59_500, endMs: 62_000, text: 'during c d' }, // p1
      { id: 's3', startMs: 90_000, endMs: 95_000, text: 'after' }, // last written before: p1
    ];
    const b = bucketSegmentsByPage([p0, p1, p2], [{ clip, file: file(segs) }]);
    expect(b.get(0)!.map((x) => x.segment.id)).toEqual(['s0', 's1']);
    expect(b.get(1)!.map((x) => x.segment.id)).toEqual(['s2', 's3']);
    expect(b.has(2)).toBe(false);
  });

  it('talk before any writing goes to the first page written after; no writing at all → page 0', () => {
    const early = { ...clip, startedAt: T0 - 10_000 };
    const b = bucketSegmentsByPage([p2, p1], [{ clip: early, file: file([{ id: 'x', startMs: 0, endMs: 1000, text: 'intro' }]) }]);
    expect([...b.keys()]).toEqual([1]);
    const none = bucketSegmentsByPage([p2], [{ clip, file: file([{ id: 'x', startMs: 0, endMs: 1000, text: 'intro' }]) }]);
    expect([...none.keys()]).toEqual([0]);
  });

  it('prefers the page with the most writing during the segment', () => {
    const q0: PageInk = { ...newPage('q0'), strokes: [at('a', 10_000)] };
    const q1: PageInk = { ...newPage('q1'), strokes: [at('b', 10_500), at('c', 11_500), at('d', 12_500)] };
    const b = bucketSegmentsByPage([q0, q1], [{ clip, file: file([{ id: 's', startMs: 9_000, endMs: 13_000, text: 'x' }]) }]);
    expect([...b.keys()]).toEqual([1]);
  });
});

describe('speech passages for the memory index', () => {
  const p0: PageInk = { ...newPage('p0'), strokes: [at('a', 1_000), at('b', 5_000, 160)] };
  const p1: PageInk = { ...newPage('p1'), strokes: [at('c', 60_000)] };
  const segs = [
    { id: 's0', startMs: 0, endMs: 2_000, text: 'Convolution flips one signal.' },
    { id: 's1', startMs: 4_000, endMs: 6_000, text: 'Then it slides it across the other.' },
    { id: 's2', startMs: 59_000, endMs: 61_000, text: 'Now the Fourier transform.' },
  ];

  it('groups by page with the recording, times and the ink written then', () => {
    const ps = speechPassages({ id: 'n' }, [p0, p1], [{ clip, file: file(segs) }]);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ pageIndex: 0, clipId: 'clip1', startMs: 0, endMs: 6_000, n: 0 });
    expect(ps[0]!.text).toBe('Convolution flips one signal. Then it slides it across the other.');
    expect(ps[0]!.strokeIds).toEqual(['a', 'b']);
    expect(ps[0]!.rect!.minY).toBeLessThan(110);
    expect(ps[1]).toMatchObject({ pageIndex: 1, startMs: 59_000, strokeIds: ['c'], n: 1 });
  });

  it('splits long talk into passages of bounded size', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, startMs: i * 1000, endMs: i * 1000 + 900, text: `Sentence number ${i} about signals and systems.` }));
    const ps = speechPassages({ id: 'n' }, [p0], [{ clip, file: file(many) }], 300);
    expect(ps.length).toBeGreaterThan(3);
    expect(ps.every((p) => p.text.length <= 320)).toBe(true);
    expect(ps.map((p) => p.n)).toEqual(ps.map((_, i) => i));
  });

  it('chunkNote indexes them as speech chunks with anchors', () => {
    const note = { ...newNote({ id: 'n1', title: 'Signals', pageId: 'p0', now: T0 }), recordings: [clip] };
    const chunks = chunkNote(note, [p0, p1], { transcripts: [{ clip, file: file(segs) }] });
    const speech = chunks.filter((c) => c.source === 'speech');
    expect(speech).toHaveLength(2);
    expect(speech[0]).toMatchObject({ id: 'n1:0:speech:clip1.0', pageIndex: 0, clipId: 'clip1', startMs: 0, endMs: 6_000, strokeIds: ['a', 'b'] });
    expect(speech[1]!.id).toBe('n1:1:speech:clip1.1');
    expect(chunkNote(note, [p0, p1]).some((c) => c.source === 'speech')).toBe(false);
  });
});
