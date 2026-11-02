import { describe, expect, it } from 'vitest';
import { newNote, newPage, type PageInk } from '@inkwright/core';
import { SPREAD_GUTTER, autoSpreads, layoutPages, nearestSlot, rowHeight, slotAt } from './layout.ts';

const note = newNote({ id: 'n', title: 'T', pageId: 'a', now: 0 });
const pages = (n: number): PageInk[] => Array.from({ length: n }, (_, i) => newPage(`p${i}`));

describe('two-page view layout', () => {
  it('pairs pages side by side, top-aligned and centred, with spreads stacked', () => {
    const l = layoutPages(note, pages(3), { spreads: true });
    const [a, b, c] = l.slots;
    expect(l.spreads).toBe(true);
    expect(a!.y).toBe(b!.y);
    expect(b!.x).toBeCloseTo(a!.x + a!.w + SPREAD_GUTTER);
    expect(l.width).toBeCloseTo(a!.w * 2 + SPREAD_GUTTER);
    expect(c!.y).toBeGreaterThan(a!.y + a!.h);
    // The odd last page sits centred on its own row.
    expect(c!.x + c!.w / 2).toBeCloseTo(l.width / 2);
  });

  it('maps points to the right page of a spread and picks pages by x', () => {
    const l = layoutPages(note, pages(4), { spreads: true });
    const [a, b] = l.slots;
    expect(slotAt(l, b!.x + 10, b!.y + 10)?.index).toBe(1);
    expect(slotAt(l, a!.x + a!.w + SPREAD_GUTTER / 2, a!.y + 10)).toBeNull(); // the gutter
    expect(nearestSlot(l, a!.y + 50, b!.x + 50).index).toBe(1);
    expect(nearestSlot(l, a!.y + 50, a!.x + 50).index).toBe(0);
    expect(rowHeight(l, a!)).toBeCloseTo(a!.h);
  });

  it('keeps the single-column layout when off, and decides Auto by screen and page count', () => {
    const l = layoutPages(note, pages(2));
    expect(l.slots[1]!.y).toBeGreaterThan(l.slots[0]!.y);
    expect(l.spreads).toBeUndefined();
    expect(autoSpreads(1280, 860, 2)).toBe(true); // desktop
    expect(autoSpreads(955, 860, 3)).toBe(true); // unfolded Razr Fold inner display
    expect(autoSpreads(884, 1104, 3)).toBe(false); // portrait foldable/tablet
    expect(autoSpreads(412, 915, 3)).toBe(false); // phone
    expect(autoSpreads(1280, 860, 1)).toBe(false); // one page
  });
});
