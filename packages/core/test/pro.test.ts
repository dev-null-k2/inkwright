import { describe, expect, it } from 'vitest';
import {
  MemoryFS, NoteDocument, NoteLockedError, Vault, VaultLayout, VersionHistory, alignPage, calligraphyOutline, classifyPage, createLock, decodePage, decodeStroke,
  editableStroke, encodePage, encodeStroke, erasable, eraserAccepts, exportPageSvg, feelOf, hitTape, isSealedBytes, newPage, nominalWidth, objectRect, objectsText,
  openBox, overlayAt, overlaysSvg, pageDiffBetween, paperSnapLines, replayChain, resizeSticky, retainSnapshots, sealBox, snapMove, snapScale, snapSize, snapTargets,
  stickyStrokesOnPage, strokeIntoSticky, strokeOutline, tapeFromDrag, unlockWith, visibleStrokes, withLayerState, isEmptyDiff,
  type InkStroke, type NoteMeta, type PageInk, type StickyObject, type TapeObject,
} from '../src/index.ts';
import { polyline, stroke, word, horizontalScribble } from './helpers.ts';

const ITER = 1000; // fast PBKDF2 for tests; the app uses LOCK_ITERATIONS

/** Width of an outline polygon measured across a direction at the middle of the stroke. */
function thickness(outline: number[][], nx: number, ny: number): number {
  const d = outline.map(([x, y]) => x! * nx + y! * ny);
  return Math.max(...d) - Math.min(...d);
}

describe('calligraphy pen', () => {
  it('is thick across the nib and a hairline along it', () => {
    // Nib at 45°: moving along (1,1) runs parallel to the nib, moving along (1,-1) runs across it.
    const along = calligraphyOutline(stroke('a', polyline([[0, 0], [60, 60]])).points, 10, 45);
    const across = calligraphyOutline(stroke('b', polyline([[0, 60], [60, 0]])).points, 10, 45);
    const s = Math.SQRT1_2;
    const wAlong = thickness(along, s, -s); // measured perpendicular to travel
    const wAcross = thickness(across, s, s);
    expect(wAcross).toBeGreaterThan(9);
    expect(wAlong).toBeLessThan(2);
  });
  it('follows the nib angle stored on the stroke and is used by strokeOutline', () => {
    const pts = stroke('h', polyline([[0, 0], [100, 0]])).points;
    const flatNib = strokeOutline({ pen: 'calligraphy', size: 10, points: pts, nib: 0 });
    const steepNib = strokeOutline({ pen: 'calligraphy', size: 10, points: pts, nib: 90 });
    expect(thickness(flatNib, 0, 1)).toBeLessThan(2); // horizontal travel with a horizontal nib: hairline
    expect(thickness(steepNib, 0, 1)).toBeGreaterThan(9); // with a vertical nib: full width
  });
  it('draws a dot as the nib shape and survives repeats', () => {
    const p = { x: 5, y: 5, t: 0, p: -1, tilt: -1, orient: -1 };
    expect(calligraphyOutline([p, p, p], 8, 30)).toHaveLength(4);
    expect(calligraphyOutline([], 8)).toEqual([]);
  });
  it('round-trips the nib angle and layer in the file format, and has a feel profile', () => {
    const s: InkStroke = { ...stroke('c', word(0, 0)), pen: 'calligraphy', nib: 37.5, layer: 'drawing' };
    const back = decodeStroke(JSON.parse(JSON.stringify(encodeStroke(s))));
    expect(back.nib).toBe(37.5);
    expect(back.layer).toBe('drawing');
    expect(decodeStroke(encodeStroke(stroke('d', word(0, 0)))).layer).toBeUndefined();
    expect(feelOf('standard', 'calligraphy').soundBaseHz).toBeLessThan(feelOf('standard', 'fountain').soundBaseHz);
    expect(nominalWidth('calligraphy', 7)).toBeCloseTo(7, 5);
  });
});

describe('selective eraser and layers', () => {
  const hl = { ...stroke('hl', word(0, 0)), pen: 'highlighter' as const };
  const ink = stroke('ink', word(0, 20));
  const box = { ...stroke('box', polyline([[0, 0], [50, 0], [50, 50]])), shape: 'rectangle' as const };
  it('erases only what the mode allows', () => {
    expect([hl, ink, box].filter((s) => eraserAccepts('highlighter', s)).map((s) => s.id)).toEqual(['hl']);
    expect([hl, ink, box].filter((s) => eraserAccepts('ink', s)).map((s) => s.id)).toEqual(['ink']);
    expect([hl, ink, box].filter((s) => eraserAccepts('shapes', s)).map((s) => s.id)).toEqual(['box']);
    expect([hl, ink, box].filter((s) => eraserAccepts('all', s))).toHaveLength(3);
  });
  it('draws the drawing layer first, leaves hidden layers out, and protects locked layers', () => {
    const d = { ...stroke('d', word(0, 40)), layer: 'drawing' as const };
    const page: PageInk = { ...newPage('p'), strokes: [ink, d, hl] };
    expect(visibleStrokes(page).map((s) => s.id)).toEqual(['d', 'ink', 'hl']);
    const hidden = { ...page, layers: withLayerState(undefined, 'drawing', { hidden: true }) };
    expect(visibleStrokes(hidden).map((s) => s.id)).toEqual(['ink', 'hl']);
    const locked = { ...page, layers: withLayerState(undefined, 'drawing', { locked: true }) };
    expect(editableStroke(locked, d)).toBe(false);
    expect(erasable(locked, 'all').map((s) => s.id)).toEqual(['ink', 'hl']);
    expect(withLayerState(locked.layers, 'drawing', { locked: false })).toBeUndefined();
    // No layers in use: the page's own array (renderer caches stay warm).
    const plain = { ...newPage('q'), strokes: [ink] };
    expect(visibleStrokes(plain)).toBe(plain.strokes);
  });
  it('scratch-out never erases a locked layer, and layer state is saved but not an undo step', () => {
    const doc = new NoteDocument(meta('n'), [{ ...newPage('p'), strokes: [{ ...stroke('w', word(10, 100, 80)), layer: 'drawing' }] }]);
    doc.setLayerState(0, 'drawing', { locked: true });
    expect(doc.canUndo).toBe(false);
    expect(doc.page(0).layers).toEqual({ drawing: { locked: true } });
    const res = doc.addStroke(0, stroke('x', horizontalScribble(8, 92, 92, 108, 10)), {});
    expect(res.kind).toBe('added');
    expect(doc.page(0).strokes).toHaveLength(2);
  });
  it('hidden layers are left out of the page SVG', () => {
    const page: PageInk = { ...newPage('p'), strokes: [{ ...stroke('d', word(0, 40)), layer: 'drawing' }], layers: { drawing: { hidden: true } } };
    expect(exportPageSvg(meta('n'), page)).not.toContain('<path d="M');
  });
});

function meta(id: string, extra: Partial<NoteMeta> = {}): NoteMeta {
  return { id, title: 'Note', kind: 'paged', paper: { style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: 0 }, pageSize: { name: 'A4', width: 793.7, height: 1122.5 }, pageIds: ['p'], tags: [], createdAt: 0, updatedAt: 0, pinned: false, formatVersion: 2, ...extra };
}

describe('snapping', () => {
  const page = { width: 800, height: 1000 };
  it('snaps a moved box to another item edge and centre with a guide', () => {
    const t = snapTargets({ items: [{ minX: 300, minY: 100, maxX: 400, maxY: 160 }] });
    const r = snapMove({ minX: 0, minY: 300, maxX: 50, maxY: 340 }, 297, 0, t, 6);
    expect(r.dx).toBe(300); // left edge onto the item's left edge
    expect(r.guides[0]).toMatchObject({ axis: 'x', v: 300, source: 'item' });
    expect(r.guides[0]!.from).toBe(100);
    expect(r.guides[0]!.to).toBe(340);
    const c = snapMove({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 337, 500, t, 6);
    expect(c.dx + 10).toBeCloseTo(350); // centres line up
  });
  it('snaps to page margins and centre, not beyond the tolerance', () => {
    const t = snapTargets({ items: [], page });
    expect(snapMove({ minX: 0, minY: 0, maxX: 100, maxY: 10 }, 45, 500, t, 5).dx).toBe(48);
    expect(snapMove({ minX: 0, minY: 0, maxX: 100, maxY: 10 }, 348, 900, t, 5).dx).toBe(350); // centre on the page centre
    expect(snapMove({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 200, 205, t, 5)).toMatchObject({ dx: 200, dy: 205, guides: [] });
  });
  it('snaps edges to ruled lines and grid, skipping lines that are too dense', () => {
    const ruled = paperSnapLines({ style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: 0 }, page);
    expect(ruled.ys.length).toBeGreaterThan(20);
    expect(ruled.xs.length).toBeLessThan(3);
    const grid = paperSnapLines({ style: 'square_grid', tint: 'ivory', texture: 'standard', spacing: 0 }, page);
    expect(grid.xs.length).toBeGreaterThan(20);
    expect(paperSnapLines({ style: 'graph_mm', tint: 'ivory', texture: 'standard', spacing: 0 }, page, 10).ys).toEqual([]);
    expect(paperSnapLines({ style: 'blank', tint: 'ivory', texture: 'standard', spacing: 0 }, page).ys).toEqual([]);
    const t = snapTargets({ items: [], page, paper: { style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: 0 } });
    const line = ruled.ys[10]!;
    const r = snapMove({ minX: 100, minY: 0, maxX: 150, maxY: 13 }, 0, line - 13 + 2, t, 4);
    expect(r.dy + 13).toBeCloseTo(line, 5); // bottom edge sits on the line
  });
  it('snaps a resize corner and a free resize', () => {
    const t = snapTargets({ items: [{ minX: 400, minY: 0, maxX: 500, maxY: 50 }] });
    const s = snapScale({ minX: 100, minY: 100, maxX: 200, maxY: 150 }, { x: 100, y: 100 }, 2.97, t, 6);
    expect(s.scale).toBeCloseTo(3, 5); // far edge at 400
    const z = snapSize({ minX: 100, minY: 100, maxX: 200, maxY: 200 }, 398, 120, t, 5);
    expect(z.width).toBe(400);
    expect(z.height).toBe(120);
  });
});

describe('sticky notes and tape', () => {
  const sticky: StickyObject = { type: 'sticky', id: 's', x: 100, y: 100, width: 180, height: 180, color: '#FFFCE58A', createdAt: 1, text: 'Call Mum' };
  it('keeps its handwriting in its own coordinates and moves it along', () => {
    const withInk = strokeIntoSticky(sticky, stroke('w', word(120, 140, 60)));
    expect(withInk.strokes![0]!.points[0]!.x).toBeCloseTo(20);
    const moved = { ...withInk, x: 300 };
    expect(stickyStrokesOnPage(moved)[0]!.points[0]!.x).toBeCloseTo(320);
    expect(resizeSticky(withInk, 30, 30).width).toBeGreaterThanOrEqual(80);
  });
  it('collapses to an icon and is hit-tested on top', () => {
    const tape = tapeFromDrag('t', { x: 0, y: 150 }, { x: 400, y: 150 }, 20, '#FF8FA7B8', 2)!;
    expect(tapeFromDrag('x', { x: 0, y: 0 }, { x: 3, y: 0 }, 20, '#FF000000', 0)).toBeNull();
    expect(hitTape(tape, 200, 158)).toBe(true);
    expect(hitTape(tape, 200, 175)).toBe(false);
    expect(overlayAt([sticky, tape], 150, 150)?.id).toBe('t'); // tape added later lies on top
    expect(overlayAt([sticky, tape], 150, 250)?.id).toBe('s');
    const icon = objectRect({ ...sticky, collapsed: true });
    expect(icon.maxX - icon.minX).toBeLessThan(40);
  });
  it('is drawn over the ink in SVG, and its text is searchable', () => {
    const page: PageInk = { ...newPage('p'), strokes: [stroke('w', word(0, 0))], objects: [sticky, { type: 'tape', id: 't', x: 0, y: 0, dx: 100, dy: 0, width: 20, color: '#FF8FA7B8', createdAt: 0 } as TapeObject] };
    const svg = exportPageSvg(meta('n'), page);
    expect(svg.indexOf('id="overlays"')).toBeGreaterThan(svg.indexOf('id="ink"'));
    expect(svg).toContain('class="tape"');
    expect(svg).toContain('Call Mum');
    expect(objectsText(page.objects)).toContain('Sticky note: Call Mum');
    expect(overlaysSvg([])).toBe('');
  });
  it('is the user\'s own content in authorship counts, not machine-made', () => {
    expect(classifyPage({ ...newPage('p'), objects: [sticky] }).counts.objects).toBe(0);
  });
});

describe('locked notes', () => {
  it('seals with AES-GCM and refuses the wrong passcode or tampered data', async () => {
    const { lock, key } = await createLock('tulip-42', { now: 1, iterations: ITER });
    expect(await unlockWith(lock, 'tulip-41')).toBeNull();
    const k2 = await unlockWith(lock, 'tulip-42');
    expect(k2).not.toBeNull();
    const box = await sealBox(key, new TextEncoder().encode('secret'), 'a');
    expect(new TextDecoder().decode(await openBox(k2!, box, 'a'))).toBe('secret');
    await expect(openBox(k2!, box, 'b')).rejects.toThrow();
    await expect(createLock('abc', { now: 1, iterations: ITER })).rejects.toThrow(/at least/);
  });

  it('keeps pages, assets and content metadata encrypted at rest; readers without the key see blank pages', async () => {
    const fs = new MemoryFS();
    const vault = new Vault(fs, () => 1000);
    const { note, pages } = await vault.createNote({ title: 'Diary' });
    const page: PageInk = { ...pages[0]!, strokes: [stroke('s', word(0, 0))], texts: [{ id: 't', x: 0, y: 0, width: 100, text: 'my secret plan', fontSize: 14, color: '#FF000000', font: 'sans', createdAt: 0 }], recognizedText: 'dear diary' };
    await vault.writeAsset(note.id, 'pic.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    const locked = await vault.lockNote({ ...note, summary: 'about the plan' }, [page], 'tulip-42', { iterations: ITER });
    // Nothing readable on disk.
    for (const path of fs.paths().filter((p) => p.startsWith(`notes/${note.id}/`))) {
      const bytes = (await fs.readBytes(path))!;
      const text = new TextDecoder().decode(bytes);
      expect(text).not.toContain('secret plan');
      expect(text).not.toContain('dear diary');
      expect(text).not.toContain('about the plan');
      if (path.endsWith('pic.png')) expect(isSealedBytes(bytes)).toBe(true);
    }
    // While unlocked, the editor reads everything back.
    expect((await vault.readPages(locked, { unlocked: true }))[0]!.texts![0]!.text).toBe('my secret plan');
    expect((await vault.readNote(note.id, { unlocked: true }))!.summary).toBe('about the plan');
    expect([...(await vault.readAsset(note.id, 'pic.png'))!]).toEqual([137, 80, 78, 71, 1, 2, 3]);
    // Indexers and agents (no unlocked flag) see a blank page, even while the note is open.
    expect((await vault.readPages(locked))[0]!.texts).toBeUndefined();
    // Closed: no reading, no writing.
    vault.forget(note.id);
    const other = new Vault(fs);
    await expect(other.readPages(locked, { unlocked: true })).rejects.toBeInstanceOf(NoteLockedError);
    await expect(other.saveNote(locked, [page])).rejects.toBeInstanceOf(NoteLockedError);
    await expect(other.writeAsset(note.id, 'x.png', new Uint8Array([1]))).rejects.toBeInstanceOf(NoteLockedError);
    expect(await other.readAsset(note.id, 'pic.png')).toBeNull();
    // The passcode opens it on any device; removing the lock writes plain files again.
    other.unlock(note.id, (await unlockWith(locked.lock!, 'tulip-42'))!);
    const m = (await other.readNote(note.id, { unlocked: true }))!;
    const pg = await other.readPages(m, { unlocked: true });
    const plain = await other.removeLock(m, pg);
    expect(plain.lock).toBeUndefined();
    expect(await fs.readText(VaultLayout.pageInk(note.id, page.id))).toContain('my secret plan');
    expect([...(await fs.readBytes(VaultLayout.asset(note.id, 'pic.png')))!]).toEqual([137, 80, 78, 71, 1, 2, 3]);
  });

  it('a sealed page file swapped onto another page id does not decrypt', async () => {
    const vault = new Vault(new MemoryFS());
    const { note, pages } = await vault.createNote({ title: 'X' });
    const locked = await vault.lockNote(note, [{ ...pages[0]!, strokes: [stroke('s', word(0, 0))] }], 'tulip-42', { iterations: ITER });
    const raw = decodePage((await vault.fs.readText(VaultLayout.pageInk(note.id, pages[0]!.id)))!);
    await vault.fs.writeText(VaultLayout.pageInk(note.id, 'other'), encodePage({ ...raw, id: 'other' }));
    await expect(vault.readPages({ ...locked, pageIds: ['other'] }, { unlocked: true })).rejects.toThrow();
  });
});

describe('version history', () => {
  async function setup() {
    let now = Date.UTC(2026, 10, 1, 9);
    const fs = new MemoryFS(() => now);
    const vault = new Vault(fs, () => now);
    const history = new VersionHistory(vault, () => now);
    const { note, pages } = await vault.createNote({ title: 'Lecture' });
    return { fs, vault, history, note, pages, tick: (ms: number) => { now += ms; return now; }, now: () => now };
  }

  it('takes snapshots, skips identical ones, shares unchanged pages and reads them back', async () => {
    const { fs, history, note, pages, tick } = await setup();
    const p1: PageInk = { ...pages[0]!, strokes: [stroke('a', word(0, 0))] };
    const p2: PageInk = { ...newPage('page2'), strokes: [stroke('b', word(0, 50))] };
    const m = { ...note, pageIds: [p1.id, p2.id] };
    expect(await history.take(m, [p1, p2], 'open')).not.toBeNull();
    tick(1000);
    expect(await history.take(m, [p1, p2], 'close')).toBeNull(); // nothing changed
    tick(1000);
    const p2b = { ...p2, strokes: [...p2.strokes, stroke('c', word(0, 80))] };
    const info = (await history.take(m, [p1, p2b], 'interval'))!;
    expect(info.pageCount).toBe(2);
    const blobs = fs.paths().filter((p) => p.includes('/history/blobs/'));
    expect(blobs).toHaveLength(3); // p1 stored once
    const list = await history.list(note.id);
    expect(list.map((s) => s.reason)).toEqual(['interval', 'open']);
    const first = (await history.read(note.id, list[1]!.id))!;
    expect(first.pages[1]!.strokes.map((s) => s.id)).toEqual(['b']);
    expect(first.meta.title).toBe('Lecture');
  });

  it('keeps hourly versions for a day, daily for a month, weekly for a year', () => {
    const now = Date.UTC(2026, 10, 1, 12);
    const H = 3600_000, D = 24 * H;
    const list = [
      { id: 'a', takenAt: now - 10 * 60_000 }, { id: 'b', takenAt: now - 20 * 60_000 }, // recent: both kept
      { id: 'c', takenAt: now - 5 * H - 60_000 }, { id: 'd', takenAt: now - 5 * H - 120_000 }, // same hour: newest kept
      { id: 'e', takenAt: now - 3 * D }, { id: 'f', takenAt: now - 3 * D - H }, // same day
      { id: 'g', takenAt: now - 100 * D }, // weekly
      { id: 'h', takenAt: now - 400 * D }, // too old
    ];
    const keep = retainSnapshots(list, now);
    expect([...keep].sort()).toEqual(['a', 'b', 'c', 'e', 'g']);
    expect(retainSnapshots([{ id: 'old', takenAt: 0 }], now)).toEqual(new Set(['old'])); // the newest always stays
  });

  it('prunes old snapshots and their unused page blobs', async () => {
    const { fs, history, note, pages, tick } = await setup();
    for (let i = 0; i < 4; i++) {
      await history.take(note, [{ ...pages[0]!, strokes: [stroke(`s${i}`, word(0, i * 10))] }], 'interval');
      tick(3 * 24 * 3600_000);
    }
    expect(await history.prune(note.id)).toBe(0);
    tick(400 * 24 * 3600_000);
    expect(await history.prune(note.id)).toBe(3);
    expect((await history.list(note.id))).toHaveLength(1);
    expect(fs.paths().filter((p) => p.includes('/history/blobs/'))).toHaveLength(1);
  });

  it('encrypts the history of a locked note, and reseals it when the lock is added', async () => {
    const { fs, vault, history, note, pages } = await setup();
    const p: PageInk = { ...pages[0]!, texts: [{ id: 't', x: 0, y: 0, width: 100, text: 'old secret', fontSize: 14, color: '#FF000000', font: 'sans', createdAt: 0 }] };
    await history.take(note, [p], 'open');
    const locked = await vault.lockNote(note, [p], 'tulip-42', { iterations: ITER });
    await history.reseal(note.id, undefined, locked);
    const all = fs.paths().filter((x) => x.includes('/history/'));
    for (const path of all) expect(await fs.readText(path)).not.toContain('old secret');
    const list = await history.list(note.id);
    expect(list[0]!.locked).toBe(true);
    expect((await history.read(note.id, list[0]!.id))!.pages[0]!.texts![0]!.text).toBe('old secret');
    vault.forget(note.id);
    expect(await history.read(note.id, list[0]!.id)).toBeNull();
    expect(await history.take(locked, [p], 'close')).toBeNull(); // can't snapshot without the key
  });

  it('restores a version with minimal, undoable changes recorded in the authorship chain', () => {
    const a = stroke('a', word(0, 0)), b = stroke('b', word(0, 40)), c = stroke('c', word(0, 80));
    const doc = new NoteDocument(meta('n', { pageIds: ['p'] }), [{ ...newPage('p'), strokes: [] }]);
    doc.addStroke(0, a); doc.addStroke(0, b);
    const snapshot = { meta: { ...doc.meta, title: 'Then' }, pages: doc.committedPages.map((p) => JSON.parse(encodePage(p))).map((j) => decodePage(JSON.stringify(j))) };
    doc.deleteStrokes(0, new Set(['a']));
    doc.addStroke(0, c);
    doc.addPage(1);
    doc.rename('Now');
    const aligned = alignPage(doc.page(0), snapshot.pages[0]!);
    const d = pageDiffBetween(doc.page(0), aligned, 'x');
    expect(d.strokes!.removed.map((r) => r.item.id)).toEqual(['c']);
    expect(d.strokes!.added.map((r) => r.item.id)).toEqual(['a']);
    doc.restoreVersion(snapshot.meta, snapshot.pages);
    expect(doc.pageCount).toBe(1);
    expect(doc.page(0).strokes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(doc.meta.title).toBe('Then');
    const { live, problems } = replayChain(doc.page(0).authorship!.events);
    expect(problems).toEqual([]);
    expect([...live.keys()].sort()).toEqual(['s:a', 's:b']);
    doc.undo();
    expect(doc.page(0).strokes.map((s) => s.id).sort()).toEqual(['b', 'c']);
    expect(isEmptyDiff(pageDiffBetween(doc.page(0), alignPage(doc.page(0), doc.page(0)), 'same'))).toBe(true);
  });
});
