import { describe, expect, it } from 'vitest';
import { PAGE_SIZES } from '@inkstone/core';
import { classifyFile, isHeic, textToPages } from './openFiles.ts';
import { describePages } from './pageTools.ts';
import { checkmark, cross, formDate } from '../fill/marks.ts';

describe('opening files', () => {
  it('classifies by type, or by extension when the system gives none', () => {
    expect(classifyFile({ name: 'a.pdf', type: '' })).toBe('pdf');
    expect(classifyFile({ name: 'x', type: 'application/pdf' })).toBe('pdf');
    expect(classifyFile({ name: 'IMG_1.HEIC', type: '' })).toBe('image');
    expect(classifyFile({ name: 'p.webp', type: 'image/webp' })).toBe('image');
    expect(classifyFile({ name: 'notes.md', type: '' })).toBe('text');
    expect(classifyFile({ name: 'readme.txt', type: 'text/plain' })).toBe('text');
    expect(classifyFile({ name: 'backup.zip', type: 'application/zip' })).toBe('backup');
    expect(classifyFile({ name: 'song.mp3', type: 'audio/mpeg' })).toBe('unknown');
    expect(isHeic({ name: 'a.heif', type: '' })).toBe(true);
    expect(isHeic({ name: 'a.jpg', type: 'image/heic' })).toBe(true);
    expect(isHeic({ name: 'a.jpg', type: 'image/jpeg' })).toBe(false);
  });

  it('lays text out over as many pages as it needs, breaking between lines', () => {
    let n = 0;
    const one = textToPages('# Title\n\nShort note\n', PAGE_SIZES.A4, { makeId: () => `t${n++}`, now: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]![0]).toMatchObject({ id: 't0', text: '# Title\n\nShort note', x: 72, y: 72, fontSize: 16, font: 'sans' });
    const long = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`).join('\n');
    const pages = textToPages(long, PAGE_SIZES.A4);
    expect(pages.length).toBeGreaterThan(2);
    const all = pages.map((p) => p[0]!.text).join('\n');
    expect(all).toBe(long);
    // Every page fits: lines per page × line height within the margins.
    for (const p of pages) expect(p[0]!.text.split('\n').length * 16 * 1.5).toBeLessThanOrEqual(PAGE_SIZES.A4.height - 144);
    // A long paragraph counts as several lines.
    const para = textToPages('word '.repeat(4000).trim(), PAGE_SIZES.A4);
    expect(para.length).toBeGreaterThan(2); // a paragraph longer than a page is cut between words
    expect(para.map((p) => p[0]!.text).join(' ')).toBe('word '.repeat(4000).trim());
    expect(textToPages('', PAGE_SIZES.A4)).toEqual([[]]);
  });

  it('names extracted page ranges', () => {
    expect(describePages([1])).toBe('page 2');
    expect(describePages([4, 1, 2, 0])).toBe('pages 1–3, 5');
  });
});

describe('form marks', () => {
  const box = { minX: 10, minY: 10, maxX: 30, maxY: 30 };
  it('a checkmark and a cross stay inside their box as ink', () => {
    const c = checkmark(box, '#FF000000', 5, () => 'c');
    expect(c).toHaveLength(1);
    const pts = c[0]!.points;
    expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThanOrEqual(10);
    expect(Math.max(...pts.map((p) => p.x))).toBeLessThanOrEqual(30);
    expect(Math.max(...pts.map((p) => p.y))).toBeLessThanOrEqual(30);
    expect(c[0]!.pen).toBe('ballpoint');
    const x = cross(box);
    expect(x).toHaveLength(2);
    expect(x[0]!.points[0]).toMatchObject({ x: 10, y: 10 });
  });
  it('dates use the locale’s form style', () => {
    expect(formDate(new Date(2026, 10, 1), 'en-US')).toBe('11/01/2026');
    expect(formDate(new Date(2026, 10, 1), 'en-GB')).toBe('01/11/2026');
  });
});
