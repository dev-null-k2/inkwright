import { describe, expect, it } from 'vitest';
import { planPages } from './pdf.ts';

/** Lines of text 20 px tall every 24 px from y = 0. */
const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ top: from + i * 24, bottom: from + i * 24 + 20 }));

describe('planPages', () => {
  it('fits a short document on one page', () => {
    expect(planPages(lines(5), [], 0, 116, 900)).toEqual([{ from: 0, to: 116 }]);
  });

  it('cuts between lines, never through one', () => {
    const spans = lines(100);
    const pages = planPages(spans, [], 0, 2396, 500);
    expect(pages.length).toBeGreaterThan(4);
    for (const p of pages) {
      expect(p.to - p.from).toBeLessThanOrEqual(500);
      for (const s of spans) expect(s.top < p.to - 0.5 && s.bottom > p.to + 0.5).toBe(false);
    }
    // Contiguous, covering everything.
    expect(pages[0]!.from).toBe(0);
    pages.slice(1).forEach((p, i) => expect(p.from).toBe(pages[i]!.to));
    expect(pages[pages.length - 1]!.to).toBe(2396);
  });

  it('starts a new page at a manual page break', () => {
    const pages = planPages(lines(10), [120], 0, 236, 900);
    expect(pages).toEqual([{ from: 0, to: 120 }, { from: 120, to: 236 }]);
  });

  it('cuts a picture taller than a page at the page height', () => {
    const pages = planPages([{ top: 0, bottom: 1500 }], [], 0, 1500, 600);
    expect(pages).toEqual([{ from: 0, to: 600 }, { from: 600, to: 1200 }, { from: 1200, to: 1500 }]);
  });

  it('keeps a table row whole', () => {
    const spans = [...lines(20), { top: 470, bottom: 540 }];
    const pages = planPages(spans, [], 0, 600, 500);
    expect(pages[0]!.to).toBeLessThanOrEqual(470);
  });
});
