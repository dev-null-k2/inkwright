import { describe, expect, it } from 'vitest';
import { isReadableLine, isStudyWorthy, readableText, tokenKind } from '../src/index.ts';

describe('recognized text quality', () => {
  it('classifies tokens', () => {
    expect(['Budget', 'Car', '4000$', '$12.50', '2+2=', '=', 'DNA', 'café', '東京', 'is'].map(tokenKind)).toEqual(['word', 'word', 'number', 'number', 'math', 'math', 'word', 'word', 'word', 'word']);
    expect(['xkcqzt', '~~', '/|', 'Iiil', 'zz', 'aaab'].map(tokenKind)).toEqual(['junk', 'junk', 'junk', 'junk', 'junk', 'junk']);
  });

  it('keeps lines a model can use and drops scribbles', () => {
    expect(isReadableLine('Budget Car 4000$')).toBe(true);
    expect(isReadableLine('2+2=')).toBe(true);
    expect(isReadableLine('milk')).toBe(true);
    expect(isReadableLine('~~ /| xkcq')).toBe(false);
    expect(readableText('Budget\n~~ //\nCar 4000$')).toBe('Budget\nCar 4000$');
  });

  it('only teaches from real sentences (the "ools" card from the phone)', () => {
    expect(isStudyWorthy('ools')).toBe(false);
    expect(isStudyWorthy('Car 4000$')).toBe(false);
    expect(isStudyWorthy('Mitochondria make ATP for the cell.')).toBe(true);
    expect(isStudyWorthy('Mitochondria xkcq ~~ // zz qq')).toBe(false);
  });
});
