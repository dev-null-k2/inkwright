import { describe, expect, it } from 'vitest';
import {
  MemoryFS,
  Vault,
  decodePageSummaries,
  decodeTranscript,
  encodePageSummaries,
  encodeTranscript,
  transcriptAssetName,
  type PageSummariesFile,
  type TranscriptFile,
} from '@inkstone/core';
import { MemoryRemote, MemoryStateStore, SyncEngine, mergeFileBytes, mergeKindOf, mergePageSummaries, mergeTranscript } from '../src/index.ts';

const seg = (id: string, startMs: number, text = id) => ({ id, startMs, endMs: startMs + 900, text });
const tf = (segments: TranscriptFile['segments'], extra: Partial<TranscriptFile> = {}): TranscriptFile => ({ formatVersion: 1, clipId: 'C1', run: 'r1', engine: 'device:moonshine-base', where: 'device', complete: false, updatedAt: 100, segments, ...extra });
const enc = (s: string) => new TextEncoder().encode(s);

describe('mergeTranscript', () => {
  it('unions segments of the same run (one device still transcribing)', () => {
    const base = tf([seg('a', 0)]);
    const local = tf([seg('a', 0), seg('b', 1000)], { updatedAt: 200 });
    const remote = tf([seg('a', 0), seg('c', 2000)], { updatedAt: 300, complete: true });
    const m = mergeTranscript(base, local, remote);
    expect(m.segments.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(m.complete).toBe(true);
    expect(m.updatedAt).toBe(300);
  });

  it('takes one-sided edits and deletions; the newer file wins a segment both changed', () => {
    const base = tf([seg('a', 0, 'helo'), seg('b', 1000, 'two'), seg('c', 2000, 'three')]);
    const local = tf([seg('a', 0, 'hello'), seg('b', 1000, 'two'), seg('c', 2000, 'local')], { updatedAt: 200 });
    const remote = tf([seg('a', 0, 'helo'), seg('c', 2000, 'remote')], { updatedAt: 300 });
    const m = mergeTranscript(base, local, remote);
    expect(m.segments.map((s) => `${s.id}:${s.text}`)).toEqual(['a:hello', 'c:remote']);
  });

  it('a different run (transcribed again) replaces the other wholesale, newest first', () => {
    const local = tf([seg('a', 0), seg('b', 1000)], { run: 'old', updatedAt: 200 });
    const remote = tf([seg('x', 0, 'better')], { run: 'new', updatedAt: 300 });
    expect(mergeTranscript(null, local, remote).segments.map((s) => s.id)).toEqual(['x']);
    expect(mergeTranscript(null, remote, local).segments.map((s) => s.id)).toEqual(['x']);
  });

  it('keeps the newer lecture summary whichever side has it', () => {
    const lecture = (at: number, summary: string) => ({ summary, keyTerms: [], todos: [], at, by: 'ai' });
    const local = tf([seg('a', 0)], { updatedAt: 500, lecture: lecture(10, 'old') });
    const remote = tf([seg('a', 0)], { updatedAt: 100, lecture: lecture(20, 'new') });
    expect(mergeTranscript(null, local, remote).lecture?.summary).toBe('new');
    expect(mergeTranscript(null, tf([]), tf([], { lecture: lecture(1, 'only') })).lecture?.summary).toBe('only');
  });
});

describe('mergePageSummaries', () => {
  const ps = (pages: PageSummariesFile['pages'], updatedAt = 1): PageSummariesFile => ({ formatVersion: 1, updatedAt, pages });
  const s = (text: string, at: number) => ({ text, at, by: 'ai', clipIds: [] });
  it('merges per page; newer summary wins; one-sided deletion of an unchanged page is honoured', () => {
    const base = ps({ p1: s('one', 1), p2: s('two', 1) });
    const local = ps({ p1: s('one v2', 5), p2: s('two', 1), p3: s('three', 3) }, 5);
    const remote = ps({ p1: s('one v3', 9) }, 9);
    const m = mergePageSummaries(base, local, remote);
    expect(Object.fromEntries(Object.entries(m.pages).map(([k, v]) => [k, v.text]))).toEqual({ p1: 'one v3', p3: 'three' });
    expect(m.updatedAt).toBe(9);
  });
});

describe('file routing', () => {
  it('recognizes transcript and page summary paths only under a note’s assets', () => {
    expect(mergeKindOf('notes/N1/assets/C1.transcript.json')).toBe('transcript');
    expect(mergeKindOf('notes/N1/assets/page-summaries.json')).toBe('page-summaries');
    expect(mergeKindOf('notes/N1/assets/C1.webm')).toBeNull();
    expect(mergeKindOf('ai/C1.transcript.json')).toBeNull();
  });

  it('merges bytes, and falls back (null) when a side is unreadable', () => {
    const l = enc(encodeTranscript(tf([seg('a', 0)], { updatedAt: 200 })));
    const r = enc(encodeTranscript(tf([seg('b', 1000)], { updatedAt: 300 })));
    const out = mergeFileBytes('notes/N1/assets/C1.transcript.json', null, l, r)!;
    expect(decodeTranscript(new TextDecoder().decode(out)).segments.map((x) => x.id)).toEqual(['a', 'b']);
    expect(mergeFileBytes('notes/N1/assets/C1.transcript.json', null, enc('nope'), r)).toBeNull();
    const pl = enc(encodePageSummaries({ formatVersion: 1, updatedAt: 1, pages: { p1: { text: 'x', at: 1, by: 'a', clipIds: [] } } }));
    const pr = enc(encodePageSummaries({ formatVersion: 1, updatedAt: 2, pages: { p2: { text: 'y', at: 2, by: 'a', clipIds: [] } } }));
    expect(Object.keys(decodePageSummaries(new TextDecoder().decode(mergeFileBytes('notes/N1/assets/page-summaries.json', null, pl, pr)!)).pages).sort()).toEqual(['p1', 'p2']);
  });
});

describe('sync engine', () => {
  it('merges a transcript edited on two devices instead of keeping a conflict copy', async () => {
    let now = 1_700_000_000_000;
    const clock = () => (now += 1000);
    const remote = new MemoryRemote();
    const dev = () => {
      const fs = new MemoryFS(clock);
      return { fs, vault: new Vault(fs, clock), engine: new SyncEngine({ local: fs, remote, state: new MemoryStateStore(), clock }) };
    };
    const a = dev(), b = dev();
    await a.vault.init();
    const { note } = await a.vault.createNote({ title: 'Lecture' });
    const name = transcriptAssetName('C1');
    await a.vault.writeAsset(note.id, name, enc(encodeTranscript(tf([seg('a', 0)]))));
    await a.engine.sync();
    await b.engine.sync();
    // Device A finishes transcribing; device B (same run) gets a lecture summary.
    await a.vault.writeAsset(note.id, name, enc(encodeTranscript(tf([seg('a', 0), seg('b', 1000)], { updatedAt: 300, complete: true }))));
    await b.vault.writeAsset(note.id, name, enc(encodeTranscript(tf([seg('a', 0)], { updatedAt: 200, lecture: { summary: 'S', keyTerms: [], todos: [], at: 5, by: 'ai' } }))));
    await a.engine.sync();
    const rep = await b.engine.sync();
    expect(rep.merged).toContain(`notes/${note.id}/assets/${name}`);
    expect(rep.conflicts).toEqual([]);
    const merged = decodeTranscript(new TextDecoder().decode((await b.vault.readAsset(note.id, name))!));
    expect(merged.segments.map((s) => s.id)).toEqual(['a', 'b']);
    expect(merged.lecture?.summary).toBe('S');
    expect(merged.complete).toBe(true);
    await a.engine.sync();
    expect(new TextDecoder().decode((await a.vault.readAsset(note.id, name))!)).toBe(new TextDecoder().decode((await b.vault.readAsset(note.id, name))!));
  });
});
