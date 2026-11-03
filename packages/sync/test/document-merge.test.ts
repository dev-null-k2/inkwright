import { describe, expect, it } from 'vitest';
import { mergeFileBytes, mergePage } from '../src/merge.ts';
import { encodePage, decodePage, type PageInk, type TextBox } from '@inkwright/core';

const body = (text: string, extra: Partial<TextBox> = {}): TextBox => ({ id: 'BODY', x: 40, y: 40, width: 640, text, fontSize: 17, color: '#FF1B1F24', font: 'sans', createdAt: 1, role: 'document', ...extra });
const page = (texts: TextBox[]): PageInk => ({ id: 'P1', strokes: [], texts, formatVersion: 2 });

describe('mergePage: document bodies', () => {
  it('keeps paragraphs edited on two devices', () => {
    const base = page([body('# Plan\n\nIntro\n\nEnd')]);
    const local = page([body('# Plan\n\nIntro, from the phone\n\nEnd')]);
    const remote = page([body('# Plan\n\nIntro\n\nEnd, from the laptop')]);
    const merged = mergePage(base, local, remote);
    expect(merged.texts?.[0]?.text).toBe('# Plan\n\nIntro, from the phone\n\nEnd, from the laptop');
  });

  it('leaves ordinary text boxes to the usual rule (one side wins)', () => {
    const plain = (text: string) => body(text, { role: undefined, id: 'T' });
    const merged = mergePage(page([plain('a')]), page([plain('mine')]), page([plain('theirs')]));
    expect(merged.texts?.[0]?.text).toBe('mine');
  });

  it('runs through the file merge sync uses, and a one-sided edit passes through untouched', () => {
    const enc = (p: PageInk) => new TextEncoder().encode(encodePage(p));
    const base = page([body('A\n\nB')]);
    const out = mergeFileBytes('notes/N/pages/P1.ink.json', enc(base), enc(page([body('A2\n\nB')])), enc(page([body('A\n\nB2')])));
    expect(decodePage(new TextDecoder().decode(out!)).texts?.[0]?.text).toBe('A2\n\nB2');
    expect(mergePage(base, page([body('A\n\nB')]), page([body('A\n\nB, edited')])).texts?.[0]?.text).toBe('A\n\nB, edited');
  });

  it('a body deleted on one side and edited on the other survives with the edit', () => {
    const merged = mergePage(page([body('A')]), page([]), page([body('A and more')]));
    expect(merged.texts?.[0]?.text).toBe('A and more');
  });
});
