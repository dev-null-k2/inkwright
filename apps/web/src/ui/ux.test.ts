import { describe, expect, it } from 'vitest';
import { THEME_CYCLE, applyThemeAttribute, nextTheme } from './ThemeToggle.tsx';
import { toggledFingerAction } from './FingerDraw.tsx';
import { pageForImage } from '../fill/signFlow.ts';
import { requestFillOnOpen, takeFillRequest } from '../fill/signIntent.ts';

describe('quick theme switch', () => {
  it('cycles Light → Dark → System → Light', () => {
    expect(THEME_CYCLE).toEqual(['light', 'dark', 'system']);
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(nextTheme('system')).toBe('light');
  });

  it('writes the mode on <html> the way App does (System removes it)', () => {
    const el = document.createElement('html');
    applyThemeAttribute('dark', el);
    expect(el.getAttribute('data-theme')).toBe('dark');
    applyThemeAttribute('system', el);
    expect(el.hasAttribute('data-theme')).toBe(false);
  });
});

describe('draw with finger', () => {
  it('toggles between drawing and scrolling; erasing counts as not drawing', () => {
    expect(toggledFingerAction('scroll')).toBe('draw');
    expect(toggledFingerAction('draw')).toBe('scroll');
    expect(toggledFingerAction('erase')).toBe('draw');
  });
});

describe('sign a document', () => {
  it('puts a photo of a page on an A4-wide page with its own proportions', () => {
    expect(pageForImage(1000, 1414)).toEqual({ width: 595.28, height: (595.28 * 1414) / 1000 });
    const land = pageForImage(1600, 900);
    expect(land.width).toBeCloseTo(841.89);
    expect(land.height).toBeCloseTo((841.89 * 900) / 1600);
    expect(pageForImage(0, 0)).toEqual({ width: 595.28, height: 841.89 });
  });

  it('opens a note with the form layer on once', () => {
    requestFillOnOpen('N1');
    expect(takeFillRequest('N1')).toBe(true);
    expect(takeFillRequest('N1')).toBe(false);
    expect(takeFillRequest('N2')).toBe(false);
  });
});
