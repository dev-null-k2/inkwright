import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteDocument, newNote, type InkStroke, type PageInk } from '@inkwright/core';
import { createFakeNativeAI, baseStatus } from '../../test/fake-native-ai.ts';
import { downloadNative, cancelNativeDownload, initNativeAI, setNativeAIPluginForTests, useNativeAI } from '../native-ai.ts';
import { classifyDownloadError, describeDownloadIssue, downloadButtonState, retryDelayMs } from './download-status.ts';
import { GENERAL_SCOPE, chatTitle, clearChatsForTests, getChat, latestChat, listChats, newThread, saveChat, storableHistory } from './chats.ts';

const recognize = vi.fn();
vi.mock('../recognition.ts', () => ({ recognizeLocally: (strokes: InkStroke[]) => recognize(strokes) }));
const { ensurePageRecognized, isSmallModel, needsRecognition, noteTextForAI, selectionText, sendsImagesTo } = await import('./context.ts');

const AICORE_IPC = '[ErrorCode 6] AICore failed with error type 1-DOWNLOAD_ERROR and error code 6-IPC_ERROR: AICore service disconnected';

describe('download status copy', () => {
  it('treats AICore restarts as transient, never as the headline', () => {
    expect(classifyDownloadError('service', AICORE_IPC)).toBe('transient');
    // Older builds sent it as a generic failure; the text still tells.
    expect(classifyDownloadError('failed', `On-device AI failed: ${AICORE_IPC}`)).toBe('transient');
    const calm = describeDownloadIssue('Gemini Nano', 'transient', AICORE_IPC, true);
    expect(calm).toMatchObject({ tone: 'retrying', canRetry: false, detail: AICORE_IPC });
    expect(calm.headline).not.toMatch(/ErrorCode|IPC|failed/i);
    expect(describeDownloadIssue('Gemini Nano', 'transient', AICORE_IPC, false)).toMatchObject({ tone: 'error', canRetry: true });
  });

  it('names real problems and what to do', () => {
    expect(classifyDownloadError('disk', 'Not enough free storage')).toBe('storage');
    expect(classifyDownloadError('update', 'x')).toBe('update');
    expect(classifyDownloadError('failed', 'Connection reset by peer')).toBe('network');
    expect(describeDownloadIssue('Qwen3 1.7B', 'storage').headline).toMatch(/Free some space/);
    expect(classifyDownloadError('failed', 'Unexpected end of stream')).toBe('failed');
  });

  it('paces retries', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([3000, 8000, 20000, 45000, 90000, null]);
  });

  it('never says Download while downloading', () => {
    expect(downloadButtonState({ ready: false })).toEqual({ kind: 'idle' });
    expect(downloadButtonState({ ready: false, progress: { phase: 'download', loaded: 68, total: 100 } })).toMatchObject({ kind: 'active', label: 'Downloading… 68%', percent: 68 });
    expect(downloadButtonState({ ready: false, progress: { phase: 'started', loaded: 0, total: 0 } })).toMatchObject({ kind: 'active', label: 'Starting…' });
    expect(downloadButtonState({ ready: false, progress: { phase: 'retrying', loaded: 5, total: 10 } })).toMatchObject({ kind: 'active', label: 'Retrying…' });
    expect(downloadButtonState({ ready: false, systemDownloading: true })).toMatchObject({ kind: 'active', label: 'Downloading…', cancellable: false });
    expect(downloadButtonState({ ready: false, progress: { phase: 'failed', loaded: 0, total: 0 } })).toEqual({ kind: 'idle' });
    expect(downloadButtonState({ ready: true, progress: { phase: 'download', loaded: 1, total: 2 } })).toEqual({ kind: 'ready' });
  });
});

describe('native downloads retry transient AICore errors', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setNativeAIPluginForTests(null);
  });

  it('retries with backoff, calmly, and succeeds', async () => {
    const fake = createFakeNativeAI(baseStatus({ engines: [{ id: 'gemini-nano', state: 'downloadable' }] }));
    let calls = 0;
    fake.onDownload = async (args, emit) => {
      calls++;
      if (calls === 1) {
        emit({ target: args.target, phase: 'failed', error: AICORE_IPC, code: 'service' });
        throw Object.assign(new Error(AICORE_IPC), { code: 'service' });
      }
      fake.status.engines[0]!.state = 'available';
      return { state: 'available' };
    };
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    expect(await downloadNative('gemini-nano')).toBe(false);
    expect(useNativeAI.getState().downloads['gemini-nano']).toMatchObject({ phase: 'retrying', code: 'service' });
    await vi.advanceTimersByTimeAsync(3100);
    expect(calls).toBe(2);
    expect(useNativeAI.getState().downloads['gemini-nano']).toBeUndefined();
    expect(useNativeAI.getState().status!.engines[0]!.state).toBe('available');
  });

  it('stands down when Android carries on downloading by itself', async () => {
    const fake = createFakeNativeAI(baseStatus({ engines: [{ id: 'gemini-nano', state: 'downloadable' }] }));
    let calls = 0;
    fake.onDownload = async () => {
      calls++;
      fake.status.engines[0]!.state = 'downloading';
      throw Object.assign(new Error(AICORE_IPC), { code: 'service' });
    };
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    await downloadNative('gemini-nano');
    await vi.advanceTimersByTimeAsync(3100);
    expect(calls).toBe(1);
    expect(useNativeAI.getState().downloads['gemini-nano']).toBeUndefined();
  });

  it('cancel stops a scheduled retry; a real failure is reported at once', async () => {
    const fake = createFakeNativeAI(baseStatus({ engines: [{ id: 'gemini-nano', state: 'downloadable' }] }));
    let calls = 0;
    fake.onDownload = async () => { calls++; throw Object.assign(new Error('x'), { code: calls === 1 ? 'service' : 'disk' }); };
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    await downloadNative('gemini-nano');
    cancelNativeDownload('gemini-nano');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
    expect(useNativeAI.getState().downloads['gemini-nano']).toBeUndefined();
    await downloadNative('gemini-nano'); // service again → retry → disk
    await vi.advanceTimersByTimeAsync(3100);
    expect(useNativeAI.getState().downloads['gemini-nano']).toMatchObject({ phase: 'failed', code: 'disk' });
  });
});

describe('chats persist', () => {
  beforeEach(() => clearChatsForTests());

  it('saves, lists per scope, restores the latest and drops images', async () => {
    const a = { ...newThread('note-1', 1000), title: chatTitle('What is the budget here?'), items: [{ id: '1', role: 'user' as const, text: 'What is the budget here?' }], history: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }, { type: 'image' as const, mediaType: 'image/png', data: 'AAAA' }] }] };
    await saveChat(a);
    await saveChat({ ...newThread(GENERAL_SCOPE, 2000), title: 'General', items: [{ id: '2', role: 'user', text: 'hi' }] });
    await saveChat(newThread('note-1', 3000)); // empty: not kept
    expect((await listChats('note-1')).map((c) => c.title)).toEqual(['What is the budget here?']);
    expect((await listChats()).map((c) => c.scope)).toEqual([GENERAL_SCOPE, 'note-1']);
    const back = await latestChat('note-1');
    expect(back!.history[0]!.content).toEqual([{ type: 'text', text: 'q' }, { type: 'text', text: '[image]' }]);
    expect(await getChat('nope')).toBeNull();
  });

  it('caps history and shortens titles', () => {
    expect(storableHistory(Array.from({ length: 100 }, (_, i) => ({ role: 'user' as const, content: String(i) }))).length).toBe(60);
    expect(chatTitle('x'.repeat(100))).toHaveLength(58);
  });
});

describe('reading the page before asking', () => {
  const stroke = (id: string, x: number, y: number, createdAt = 10): InkStroke => ({ id, pen: 'ballpoint', color: '#FF000000', size: 2, createdAt, points: [{ x, y, t: 0, p: 0.5 }, { x: x + 30, y, t: 10, p: 0.5 }] } as InkStroke);
  const docWith = (page: Partial<PageInk>) => {
    const note = newNote({ id: 'n1', title: 'Budget', pageId: 'p1', now: 1 });
    return new NoteDocument(note, [{ id: 'p1', formatVersion: 2, strokes: [], ...page } as PageInk]);
  };

  beforeEach(() => recognize.mockReset());

  it('recognizes unread or changed ink, and stores it on the page', async () => {
    const doc = docWith({ strokes: [stroke('a', 10, 10), stroke('b', 60, 10)] });
    expect(needsRecognition(doc.pages[0]!)).toBe(true);
    recognize.mockResolvedValue({ text: 'Budget Car 4000$\n~~ //', engine: 'native', lines: [{ text: 'Budget Car 4000$', strokeIds: ['a', 'b'], bounds: { minX: 0, minY: 0, maxX: 90, maxY: 20 } }, { text: '~~ //', strokeIds: [], bounds: { minX: 0, minY: 30, maxX: 9, maxY: 40 } }] });
    expect(await ensurePageRecognized(doc, 0)).toBe(true);
    expect(doc.pages[0]!.recognizedText).toBe('Budget Car 4000$');
    expect(needsRecognition(doc.pages[0]!)).toBe(false);
    expect(await ensurePageRecognized(doc, 0)).toBe(false);
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it('reads a lasso selection as text, recognizing it when needed', async () => {
    const doc = docWith({ strokes: [stroke('a', 10, 10), stroke('b', 60, 10), stroke('c', 10, 200)], texts: [{ id: 't', x: 0, y: 300, width: 100, text: 'typed', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] });
    recognize.mockResolvedValue({ text: '2+2=', engine: 'native', lines: [{ text: '2+2=', strokeIds: ['a', 'b'], bounds: { minX: 0, minY: 0, maxX: 90, maxY: 20 } }] });
    expect(await selectionText(doc, 0, ['a', 'b'], ['t'])).toEqual({ text: 'typed\n2+2=', unreadInk: false });
    expect(recognize.mock.calls[0]![0].map((s: InkStroke) => s.id)).toEqual(['a', 'b']);
    recognize.mockResolvedValue(null); // no recognizer on this device
    expect(await selectionText(doc, 0, ['c'], [])).toEqual({ text: '', unreadInk: true });
  });

  it('gives the note to quick actions without scribbles', () => {
    const doc = docWith({ recognizedText: 'Mitochondria make ATP\n~~ // xkcq' });
    expect(noteTextForAI(doc)).toBe('Mitochondria make ATP');
  });

  it('sends pictures only to strong vision models', () => {
    expect(isSmallModel({ local: true, budgetKey: 'device' })).toBe(true);
    expect(isSmallModel({ local: true, budgetKey: 'ollama-1' })).toBe(false);
    expect(sendsImagesTo({ vision: true, local: false, budgetKey: 'openai' })).toBe(true);
    expect(sendsImagesTo({ vision: true, local: true, budgetKey: 'device' })).toBe(false);
    expect(sendsImagesTo({ vision: false, local: false, budgetKey: 'x' })).toBe(false);
  });
});
