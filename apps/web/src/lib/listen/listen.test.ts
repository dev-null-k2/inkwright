import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SearchIndex,
  decodePageSummaries,
  decodeTranscript,
  encodeTranscript,
  newNote,
  newPage,
  transcriptAssetName,
  type AudioClip,
  type InkStroke,
  type NoteMeta,
  type PageInk,
  type TranscriptFile,
} from '@inkwright/core';

// ---- Mocks: no worker, no settings store, a scripted AI ---------------------------------------------
const state = vi.hoisted(() => ({ asrInstalled: false, browser: false, provider: null as null | { id: string; label: string; transcribe: () => Promise<string> } }));
vi.mock('../localai.ts', async () => {
  const ai = await import('@inkwright/ai');
  const spec = ai.getLocalModel('moonshine-base')!;
  return {
  currentEmbedder: async () => null,
  onLocalAIChange: () => () => {},
  initLocalAI: async () => {},
  localAISupported: () => true,
  asrChoice: () => ({ spec, variant: spec.variants[0] }),
  isInstalled: () => state.asrInstalled,
  localEngine: () => { throw new Error('no worker in unit tests'); },
  refOf: () => ({}),
  };
});
vi.mock('../agent/voice.ts', () => ({ providerTranscriber: async () => state.provider }));
vi.mock('../../canvas/assets.ts', () => ({ loadPdfJs: async () => { throw new Error('no pdf.js'); } }));
const ai = vi.hoisted(() => {
  const h = { prompts: [] as any[], reply: (_req: any) => '- A summary.' };
  const fakeAI = {
    provider: { id: 'fake', label: 'Fake', capabilities: {}, async chat(req: any) { h.prompts.push(req); return { text: h.reply(req), toolCalls: [], stopReason: 'stop' }; } },
    model: 'm', label: 'Fake AI', vision: false, tools: true,
  };
  return { h, fakeAI };
});
vi.mock('../ai.ts', () => ({ getActiveAI: async () => ai.fakeAI }));
const prompts = ai.h.prompts;
const setReply = (f: (req: any) => string) => { ai.h.reply = f; };

const { attachMemory, toHit } = await import('../memory.ts');
const { anchorOf, sourceKindLabel, toSources } = await import('../ask.ts');
const { summarizePages, summarizeLecture, pagesToSummarize, lectureMarkdown } = await import('./summaries.ts');
const { insertAtCaret } = await import('./dictation.ts');
const { linkLiveCitations, parseSaidHref, saidHref, recordingRoutineContext, useListen, liveAskContext } = await import('./session.ts');
const { resolveSpeech, useSpeechPrefs } = await import('./engines.ts');
const { applyFocus } = await import('../focus.ts');

const T0 = 1_700_000_000_000;
const clip: AudioClip = { id: 'C1', asset: 'C1.webm', startedAt: T0, durationMs: 180_000, mimeType: 'audio/webm' };
const ink = (id: string, ms: number, y = 120): InkStroke => ({ id, pen: 'ballpoint', color: '#FF1B1F24', size: 2, createdAt: T0 + ms, points: [0, 1, 2, 3, 4].map((k) => ({ x: 80 + k * 30, y: y + (k % 2) * 8, t: k * 150, p: 0.5, tilt: -1, orient: -1 })) });
const transcript: TranscriptFile = {
  formatVersion: 1, clipId: 'C1', run: 'r', engine: 'device:moonshine-base', where: 'device', complete: true, updatedAt: T0,
  segments: [
    { id: 's0', startMs: 1_000, endMs: 5_000, text: 'Today we cover convolution of two signals.' },
    { id: 's1', startMs: 62_000, endMs: 66_000, text: 'Convolution in time is multiplication in frequency.' },
    { id: 's2', startMs: 125_000, endMs: 128_000, text: 'Homework three is due on Friday.' },
  ],
};

function fakeVault() {
  const notes = new Map<string, { note: NoteMeta; pages: PageInk[] }>();
  const assets = new Map<string, Uint8Array>();
  return {
    assets,
    search: new SearchIndex(),
    vault: {
      readNote: async (id: string) => notes.get(id)?.note ?? null,
      readPages: async (n: NoteMeta) => notes.get(n.id)?.pages ?? [],
      readAsset: async (n: string, a: string) => assets.get(`${n}/${a}`) ?? null,
      writeAsset: async (n: string, a: string, b: Uint8Array) => { assets.set(`${n}/${a}`, b); return a; },
    },
    put(note: NoteMeta, pages: PageInk[]) { notes.set(note.id, { note, pages }); this.search.indexNote(note, pages); },
  };
}

const lectureNote = (): { note: NoteMeta; pages: PageInk[] } => {
  const note = { ...newNote({ id: 'L1', title: 'Signals 3', pageId: 'P0', now: T0 }), recordings: [clip], pageIds: ['P0', 'P1'] };
  const p0: PageInk = { ...newPage('P0'), strokes: [ink('a', 2_000), ink('b', 4_000, 160)], recognizedText: 'conv = flip + slide' };
  const p1: PageInk = { ...newPage('P1'), strokes: [ink('c', 63_000), ink('d', 126_000, 200)] };
  return { note, pages: [p0, p1] };
};

const until = async (fn: () => boolean) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); expect(fn()).toBe(true); };
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => { prompts.length = 0; setReply(() => '- A summary.'); state.asrInstalled = false; state.browser = false; state.provider = null; });

describe('what was said, in search and Ask', () => {
  it('indexes transcripts as anchored speech passages that open the moment', async () => {
    const v = fakeVault();
    const { note, pages } = lectureNote();
    v.assets.set(`L1/${transcriptAssetName('C1')}`, enc(encodeTranscript(transcript)));
    const mem = attachMemory(v as any);
    v.put(note, pages);
    await until(() => mem.corpus.chunksOf('L1').some((c) => c.source === 'speech'));
    const { results } = await mem.search('multiplication in frequency');
    const top = results[0]!;
    expect(top.chunk.source).toBe('speech');
    expect(top.chunk.pageIndex).toBe(1);
    const hit = toHit(top);
    expect(hit.said).toEqual({ clipId: 'C1', startMs: 62_000, endMs: 128_000 });
    const src = toSources([top])[0]!;
    expect(sourceKindLabel(src)).toBe('what was said at 1:02');
    expect(anchorOf(src)).toMatchObject({ noteId: 'L1', pageIndex: 1, seek: { clipId: 'C1', ms: 62_000 }, strokeIds: ['c', 'd'] });
  });
});

describe('summaries', () => {
  it('summarizes each page from what was said while it was written, and stores them by page id', async () => {
    const v = fakeVault();
    const { note, pages } = lectureNote();
    v.assets.set(`L1/${transcriptAssetName('C1')}`, enc(encodeTranscript(transcript)));
    v.put(note, pages);
    setReply((req) => (req.messages[1].content.includes('page 2') ? '- Page two summary.' : 'Sure!\n- Page one summary.'));
    const done = await summarizePages(v as any, note, pages);
    expect([...done.keys()]).toEqual([0, 1]);
    expect(prompts[0].messages[1].content).toContain('[0:01] Today we cover convolution');
    expect(prompts[0].messages[1].content).not.toContain('Homework');
    expect(prompts[1].messages[1].content).toContain('[2:05] Homework three');
    const stored = decodePageSummaries(new TextDecoder().decode(v.assets.get('L1/page-summaries.json')!));
    expect(stored.pages.P0).toMatchObject({ text: '- Page one summary.', by: 'Fake AI', clipIds: ['C1'] });
    expect(stored.pages.P1!.text).toBe('- Page two summary.');
    expect(pagesToSummarize(pages, [])).toEqual([0, 1]);
  });

  it('writes the lecture summary with key terms and to-dos into the transcript', async () => {
    const v = fakeVault();
    const { note, pages } = lectureNote();
    v.assets.set(`L1/${transcriptAssetName('C1')}`, enc(encodeTranscript(transcript)));
    setReply(() => '{"summary":"Convolution and its frequency view.","keyTerms":["convolution","Fourier"],"todos":["Homework 3 due Friday"]}');
    const l = await summarizeLecture(v as any, note, pages, 'C1');
    expect(l).toMatchObject({ keyTerms: ['convolution', 'Fourier'], todos: ['Homework 3 due Friday'], by: 'Fake AI' });
    const saved = decodeTranscript(new TextDecoder().decode(v.assets.get(`L1/${transcriptAssetName('C1')}`)!));
    expect(saved.lecture?.summary).toBe('Convolution and its frequency view.');
    expect(saved.segments).toHaveLength(3);
    expect(lectureMarkdown(l!)).toContain('- [ ] Homework 3 due Friday');
    // Routines triggered by the recording get all of it.
    v.put(note, pages);
    const ctx = await recordingRoutineContext(v as any, 'L1');
    expect(ctx).toContain('transcribed on this device');
    expect(ctx).toContain('To-dos mentioned:\n- Homework 3 due Friday');
    expect(ctx).toContain('[1:02] Convolution in time');
  });
});

describe('live recording', () => {
  it('gives Ask the live transcript and links its [m:ss] citations to that moment', () => {
    useListen.setState({ noteId: 'L1', clipId: 'C1', startedAt: Date.now() - 130_000, status: 'listening', segments: transcript.segments });
    const ctx = liveAskContext('L1', 1, { ...newPage('P1'), texts: [{ id: 't', x: 0, y: 0, width: 100, text: 'convolution notes', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] });
    expect(ctx).toContain('[1:02] Convolution in time');
    expect(ctx).toContain('convolution notes');
    expect(liveAskContext('other', 0, undefined)).toBe('');
    expect(linkLiveCitations('Yes [1:03], see also [7:00].', 'L1')).toBe(`Yes [1:03](${saidHref('L1', 'C1', 62_000)}), see also [7:00].`);
    expect(parseSaidHref(saidHref('L1', 'C1', 62_000))).toEqual({ noteId: 'L1', clipId: 'C1', ms: 62_000 });
    useListen.setState({ noteId: null, clipId: null, status: 'idle', segments: [] });
    expect(linkLiveCitations('Yes [1:03]', 'L1', { clipId: 'C1', segments: transcript.segments })).toContain('#said/L1/C1/62000');
  });

  it('dictation inserts at the caret with sensible spaces', () => {
    expect(insertAtCaret('Hello world', 5, 'big')).toEqual({ value: 'Hello big world', caret: 9 });
    expect(insertAtCaret('', 0, 'Hi')).toEqual({ value: 'Hi', caret: 2 });
    expect(insertAtCaret('End.', 4, 'More')).toEqual({ value: 'End. More', caret: 9 });
    expect(insertAtCaret('a.', 1, 'b')).toEqual({ value: 'a b.', caret: 3 });
  });
});

describe('choosing who transcribes (app side)', () => {
  it('prefers the downloaded device model, else browser/provider, and offers the download', async () => {
    useSpeechPrefs.getState().set({ engine: 'auto' });
    let r = await resolveSpeech();
    expect(r.choice.kind).toBe('offer-download');
    expect(r.label).toMatch(/Download Moonshine Base \(157 MB\)/);
    state.provider = { id: 'openai:gpt-4o-mini-transcribe', label: 'OpenAI · gpt-4o-mini-transcribe', transcribe: async () => '' };
    r = await resolveSpeech();
    expect(r).toMatchObject({ where: 'provider', label: 'Sent to OpenAI', engineId: 'provider:openai:gpt-4o-mini-transcribe' });
    state.asrInstalled = true;
    r = await resolveSpeech();
    expect(r).toMatchObject({ where: 'device', label: 'On this device · Moonshine Base', engineId: 'device:moonshine-base' });
    state.asrInstalled = false;
    r = await resolveSpeech('device');
    expect(r.choice.kind).toBe('offer-download'); // never the provider
  });
});

describe('citations open the moment', () => {
  it('applyFocus seeks the recording and picks out the strokes', () => {
    const calls: any[] = [];
    const engine = { focusStrokes: (...a: any[]) => calls.push(['strokes', ...a]), flashRegion: (...a: any[]) => calls.push(['flash', ...a]), scrollToPage: () => {} };
    applyFocus(engine as any, 'L1', { noteId: 'L1', pageIndex: 1, strokeIds: ['c'], seek: { clipId: 'C1', ms: 62_000 }, seq: 1 }, (c, ms) => calls.push(['seek', c, ms]));
    expect(calls).toEqual([['seek', 'C1', 62_000], ['strokes', 1, ['c']]]);
  });
});
