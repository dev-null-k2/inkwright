import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { closePalette, findActions, openPalette, paletteActionsChanged, registerPaletteActions, usePalette, usePaletteActionsVersion } from './palette.ts';
import { applyFocus } from './focus.ts';

describe('palette actions', () => {
  it('matches by label and keywords, screen actions first, and unregisters cleanly', () => {
    const run = vi.fn();
    const offApp = registerPaletteActions('app', () => [
      { id: 'new-note', label: 'New note', keywords: 'create page', run },
      { id: 'sound', label: 'Turn writing sound off', keywords: 'audio mute', run },
      { id: 'export-pdf', label: 'Export PDF (global)', run },
    ]);
    const offEditor = registerPaletteActions('editor', () => [{ id: 'export-pdf', label: 'Export PDF', keywords: 'save share print', run }]);
    expect(findActions('writing sound').map((a) => a.id)).toEqual(['sound']);
    expect(findActions('mute').map((a) => a.id)).toEqual(['sound']);
    expect(findActions('crea')[0]!.id).toBe('new-note');
    // The editor's own "Export PDF" wins over a same-id global one.
    expect(findActions('export')[0]!.label).toBe('Export PDF');
    expect(findActions('').length).toBe(3);
    offEditor();
    expect(findActions('print')).toEqual([]);
    offApp();
    expect(findActions('')).toEqual([]);
  });

  it('tells an open palette when the actions on offer change (a plugin starting late)', () => {
    const { result } = renderHook(() => usePaletteActionsVersion());
    const at = () => result.current;
    const start = at();
    let off!: () => void;
    act(() => { off = registerPaletteActions('late', () => [{ id: 'late', label: 'Late command', run() {} }]); });
    expect(at()).toBe(start + 1);
    act(() => paletteActionsChanged()); // a source's own list changed
    expect(at()).toBe(start + 2);
    act(() => off());
    expect(at()).toBe(start + 3);
    act(() => off()); // unregistering twice changes nothing
    expect(at()).toBe(start + 3);
  });

  it('opens in a mode with a query and closes', () => {
    openPalette({ mode: 'ask', query: 'fourier' });
    expect(usePalette.getState()).toMatchObject({ open: true, mode: 'ask', query: 'fourier' });
    closePalette();
    expect(usePalette.getState().open).toBe(false);
  });
});

describe('focus requests', () => {
  it('flashes the cited region on the matching note only', () => {
    const engine = { flashRegion: vi.fn(), scrollToPage: vi.fn() };
    const req = { noteId: 'n1', pageIndex: 2, rect: { x: 10, y: 20, width: 100, height: 30 }, seq: 1 };
    expect(applyFocus(engine as any, 'other', req)).toBe(false);
    expect(engine.flashRegion).not.toHaveBeenCalled();
    expect(applyFocus(engine as any, 'n1', req)).toBe(true);
    expect(engine.flashRegion).toHaveBeenCalledWith(2, { minX: 10, minY: 20, maxX: 110, maxY: 50 });
    applyFocus(engine as any, 'n1', { noteId: 'n1', pageIndex: 1, seq: 2 });
    expect(engine.scrollToPage).toHaveBeenCalledWith(1);
  });
});
