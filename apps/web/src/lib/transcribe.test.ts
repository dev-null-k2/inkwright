import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteDocument, newNote, type InkStroke, type PageInk } from '@inkwright/core';
import { CallbackProvider, type ChatRequest } from '@inkwright/ai';

/** Convert handwriting: the device reads first; pictures go only to strong vision models. */
const recognize = vi.fn();
let ai: Record<string, unknown> | null = null;
const seen: ChatRequest[] = [];
vi.mock('./recognition.ts', () => ({ recognizeLocally: (s: InkStroke[]) => recognize(s) }));
vi.mock('./trust/gateway.ts', () => ({ guardActiveAI: async () => ai }));
vi.mock('./exporter.ts', () => ({ pageImageForAI: async () => ({ mediaType: 'image/png', base64: 'AAAA' }) }));
const { transcribeWithSource } = await import('./ai.ts');

const stroke = (id: string): InkStroke => ({ id, pen: 'ballpoint', color: '#FF000000', size: 2, createdAt: 1, points: [{ x: 10, y: 10, t: 0, p: 0.5 }, { x: 40, y: 12, t: 9, p: 0.5 }] } as InkStroke);
const doc = () => new NoteDocument(newNote({ id: 'n', title: 'Maths', pageId: 'p', now: 1 }), [{ id: 'p', formatVersion: 2, strokes: [stroke('a')] } as PageInk]);
const visionAI = (local: boolean) => ({
  provider: new CallbackProvider({ handler: async (r) => { seen.push(r); return 'x = 4'; } }),
  model: 'm', label: local ? 'Gemma 4 E2B (on this phone)' : 'Gemini · gemini-3-flash', vision: true, tools: true, local, budgetKey: local ? 'device' : 'gemini',
});
const vault = {} as never;

describe('transcribeWithSource', () => {
  beforeEach(() => { recognize.mockReset(); seen.length = 0; ai = null; });

  it('uses the device reading when it is readable, even with a cloud vision model set up', async () => {
    recognize.mockResolvedValue({ text: '2+2=', engine: 'native', lines: [] });
    ai = visionAI(false);
    expect(await transcribeWithSource(vault, doc(), 0)).toEqual({ text: '2+2=', by: 'This device', engine: 'device' });
    expect(seen).toHaveLength(0);
  });

  it('sends a picture to a strong vision model when the device reading is unreadable, and says who read it', async () => {
    recognize.mockResolvedValue({ text: '~~ // ||', engine: 'native', lines: [] });
    ai = visionAI(false);
    expect(await transcribeWithSource(vault, doc(), 0)).toMatchObject({ text: 'x = 4', by: 'Gemini · gemini-3-flash', engine: 'ai' });
    expect(seen[0]!.messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'))).toBe(true);
  });

  it('never sends a picture to a small on-device model', async () => {
    recognize.mockResolvedValue(null); // no recognizer on this device
    ai = visionAI(true);
    await expect(transcribeWithSource(vault, doc(), 0)).rejects.toThrow(/can’t be read on this device/);
    expect(seen).toHaveLength(0);
    recognize.mockResolvedValue({ text: '~~ //', engine: 'native', lines: [] });
    expect(await transcribeWithSource(vault, doc(), 0)).toMatchObject({ by: 'This device', engine: 'device' });
    expect(seen).toHaveLength(0);
  });
});
