import { describe, expect, it } from 'vitest';
import { NoteDocument, newNote, newPage, translateStroke, type TextBox } from '../src/index.ts';
import { horizontalScribble, stroke, word } from './helpers.ts';

function doc(pages = 1) {
  let ids = 0;
  const pageList = Array.from({ length: pages }, (_, i) => newPage(`p${i + 1}`));
  const meta = { ...newNote({ id: 'n1', title: 'T', pageId: 'p1', now: 0 }), pageIds: pageList.map((p) => p.id) };
  return new NoteDocument(meta, pageList, () => 1000, () => `g${ids++}`);
}
const w = (id: string, x: number, y = 10) => stroke(id, word(x, y, 40));
const ids = (d: NoteDocument, i = 0) => d.page(i).strokes.map((s) => s.id);

describe('NoteDocument', () => {
  it('draw, undo, redo', () => {
    const d = doc();
    d.addStroke(0, w('a', 10));
    d.addStroke(0, w('b', 60));
    expect(ids(d)).toEqual(['a', 'b']);
    expect(d.undo()).toBe(0);
    expect(ids(d)).toEqual(['a']);
    d.redo();
    expect(ids(d)).toEqual(['a', 'b']);
  });

  it('scratch-out erases and is one undo step', () => {
    const d = doc();
    d.addStroke(0, w('w', 100, 100));
    const r = d.addStroke(0, stroke('s', horizontalScribble(95, 145, 90, 110, 8)), {});
    expect(r.kind).toBe('scratched');
    expect(d.page(0).strokes).toHaveLength(0);
    d.undo();
    expect(ids(d)).toEqual(['w']);
  });

  it('scratch disabled keeps the scribble as ink', () => {
    const d = doc();
    d.addStroke(0, w('w', 100, 100));
    expect(d.addStroke(0, stroke('s', horizontalScribble(95, 145, 90, 110, 8)), false).kind).toBe('added');
    expect(ids(d)).toEqual(['w', 's']);
  });

  it('a live gesture commits once', () => {
    const d = doc();
    d.addStroke(0, w('a', 10));
    d.addStroke(0, w('b', 60));
    const before = d.page(0);
    d.preview(0, { ...before, strokes: before.strokes.filter((s) => s.id !== 'a') });
    d.preview(0, { ...before, strokes: [] });
    expect(d.commitBetween(0, before, { ...before, strokes: [] }, 'Erase')).toBe(true);
    expect(d.page(0).strokes).toHaveLength(0);
    d.undo();
    expect(ids(d)).toEqual(['a', 'b']);
  });

  it('transform keeps z-order and undoes', () => {
    const d = doc();
    ['a', 'b', 'c'].forEach((id, i) => d.addStroke(0, w(id, 10 + i * 50)));
    const res = d.transform(0, { strokes: new Set(['b']) }, 'Move', { stroke: (s) => translateStroke(s, 5, 5) });
    expect(res.strokes.size).toBe(1);
    expect(ids(d)).toEqual(['a', [...res.strokes][0], 'c']);
    d.undo();
    expect(ids(d)).toEqual(['a', 'b', 'c']);
  });

  it('undo follows user order across pages', () => {
    const d = doc(2);
    d.addStroke(1, w('x', 10));
    d.addStroke(0, w('y', 10));
    expect(d.undo()).toBe(0);
    expect(d.undo()).toBe(1);
    expect(d.page(1).strokes).toHaveLength(0);
  });

  it('deleting a page drops its history and reports it for removal', () => {
    const d = doc(2);
    d.addStroke(1, w('x', 10));
    d.takeDirty();
    expect(d.deletePage(1)).toBe(true);
    expect(d.canUndo).toBe(false);
    const snap = d.takeDirty()!;
    expect([...snap.removedPageIds]).toEqual(['p2']);
    expect(snap.meta.pageIds).toEqual(['p1']);
    expect(d.deletePage(0)).toBe(false);
  });

  it('dirty tracking reports only touched pages', () => {
    const d = doc(3);
    d.takeDirty();
    d.addStroke(2, w('x', 10));
    expect([...d.takeDirty()!.changedPageIds]).toEqual(['p3']);
    expect(d.takeDirty()).toBeNull();
  });

  it('add, duplicate and move pages keep meta in sync', () => {
    const d = doc(2);
    expect(d.addPage(1)).toBe(1);
    d.addStroke(0, w('x', 10));
    const dup = d.duplicatePage(0);
    expect(d.page(dup).strokes[0]!.id).not.toBe('x');
    d.movePage(0, 3);
    expect(d.meta.pageIds).toEqual(d.pages.map((p) => p.id));
    expect(d.meta.pageIds[3]).toBe('p1');
  });

  it('text boxes: add, edit in place, delete when emptied, all undoable', () => {
    const d = doc();
    const t: TextBox = { id: 't1', x: 10, y: 10, width: 200, text: 'Hello', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 };
    d.upsertText(0, t);
    d.upsertText(0, { ...t, text: 'Hello world' });
    expect(d.page(0).texts![0]!.text).toBe('Hello world');
    d.upsertText(0, { ...t, text: '  ' });
    expect(d.page(0).texts).toHaveLength(0);
    d.undo();
    expect(d.page(0).texts![0]!.text).toBe('Hello world');
    d.undo();
    expect(d.page(0).texts![0]!.text).toBe('Hello');
  });

  it('paste and delete items across kinds', () => {
    const d = doc();
    const res = d.paste(0, { strokes: [w('a', 10)], images: [{ id: 'i', x: 0, y: 0, width: 10, height: 10, asset: 'a.png', rotation: 0, createdAt: 0 }] });
    expect(res.strokes.size).toBe(1);
    expect(d.page(0).images).toHaveLength(1);
    d.deleteItems(0, { strokes: res.strokes, images: res.images });
    expect(d.page(0).strokes).toHaveLength(0);
    expect(d.page(0).images).toHaveLength(0);
    d.undo();
    expect(d.page(0).images).toHaveLength(1);
  });

  it('recognized text is saved but not undoable', () => {
    const d = doc();
    d.takeDirty();
    d.setRecognizedText('p1', 'hello', 'test');
    expect(d.canUndo).toBe(false);
    expect(d.takeDirty()!.pages[0]!.recognizedText).toBe('hello');
  });

  it('listeners fire on change', () => {
    const d = doc();
    let n = 0;
    d.subscribe(() => n++);
    d.addStroke(0, w('a', 10));
    d.rename('New');
    expect(n).toBe(2);
    expect(d.meta.title).toBe('New');
  });
});

describe('gesture previews', () => {
  it('are shown but never saved, and cancel cleanly', () => {
    let ids = 0;
    const p = newPage('p1');
    const d = new NoteDocument({ ...newNote({ id: 'n', title: 'T', pageId: 'p1', now: 0 }) }, [p], () => 1, () => `g${ids++}`);
    d.addStroke(0, stroke('a', word(10, 10, 40)));
    d.takeDirty();
    const before = d.page(0);
    d.preview(0, { ...before, strokes: [] });
    expect(d.page(0).strokes).toHaveLength(0);
    expect(d.takeDirty()).toBeNull(); // autosave mid-gesture writes nothing
    d.clearPreview(0);
    expect(d.page(0).strokes).toHaveLength(1);
  });

  it('commitBetween keeps edits committed during the gesture', () => {
    let ids = 0;
    const d = new NoteDocument({ ...newNote({ id: 'n', title: 'T', pageId: 'p1', now: 0 }) }, [newPage('p1')], () => 1, () => `g${ids++}`);
    d.addStroke(0, stroke('a', word(10, 10, 40)));
    const before = d.page(0);
    d.preview(0, { ...before, strokes: [] });
    // Something else (AI, recognition) commits while the eraser is down.
    d.addStroke(0, stroke('b', word(10, 100, 40)));
    d.commitBetween(0, before, { ...before, strokes: [] }, 'Erase');
    expect(d.page(0).strokes.map((s) => s.id)).toEqual(['b']);
    d.undo();
    expect(d.page(0).strokes.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('replaceContent swaps in synced pages and keeps dirty marks only where asked', () => {
    const d = new NoteDocument({ ...newNote({ id: 'n', title: 'T', pageId: 'p1', now: 0 }) }, [newPage('p1')]);
    d.replaceContent({ ...d.meta, title: 'Synced' }, [{ ...newPage('p1'), strokes: [stroke('r', word(0, 0, 10))] }, newPage('p2')], ['p2']);
    expect(d.meta.title).toBe('Synced');
    expect(d.pageCount).toBe(2);
    expect([...d.takeDirty()!.changedPageIds]).toEqual(['p2']);
  });
});
