import { describe, expect, it, beforeEach } from 'vitest';
import { AppVault } from './vault.ts';
import { EditorSession } from './session.ts';
import { useApp } from '../state/app.ts';
import { DEFAULT_SETTINGS, useSettings, activePreset, inputPrefs } from '../state/settings.ts';

const stroke = (id: string) => ({ id, pen: 'fountain' as const, color: '#FF000000', size: 2, createdAt: 1, points: [0, 1, 2, 3].map((i) => ({ x: 10 + i * 5, y: 10, t: i * 8, p: 0.5, tilt: -1, orient: -1 })) });

describe('app vault + editor session', () => {
  beforeEach(() => indexedDB.deleteDatabase('inkstone-vault'));

  it('first run seeds the welcome note and indexes it for search', async () => {
    const v = await AppVault.open();
    const notes = await v.listNotes();
    expect(notes.map((n) => n.title)).toContain('Welcome to Inkstone');
    await v.buildIndex();
    expect(v.search.search('scribble')[0]?.title).toBe('Welcome to Inkstone');
  });

  it('autosaves only changed pages and survives reopening', async () => {
    const v = await AppVault.open();
    useApp.setState({ vault: v });
    const { note } = await v.vault.createNote({ title: 'Lecture' });
    const s = (await EditorSession.open(v, note.id))!;
    s.doc.addPage();
    s.doc.addStroke(1, stroke('a'));
    await s.flush();
    const again = (await EditorSession.open(v, note.id))!;
    expect(again.doc.pageCount).toBe(2);
    expect(again.doc.page(1).strokes.map((x) => x.id)).toEqual(['a']);
    await s.close();
    await again.close();
  });

  it('re-indexes after save so new typed text is searchable', async () => {
    const v = await AppVault.open();
    useApp.setState({ vault: v });
    const { note } = await v.vault.createNote({ title: 'Plans' });
    const s = (await EditorSession.open(v, note.id))!;
    s.doc.upsertText(0, { id: 't', x: 0, y: 0, width: 200, text: 'quarterly roadmap', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 });
    await s.flush();
    expect(v.search.search('roadmap')[0]?.noteId).toBe(note.id);
    await s.close();
  });
});

describe('settings', () => {
  it('fills defaults and derives the active pen and input prefs', () => {
    const s = useSettings.getState();
    expect(activePreset(s).id).toBe(DEFAULT_SETTINGS.activePresetId);
    expect(inputPrefs(s).highlighter.pen).toBe('highlighter');
    s.update(() => ({ eraserSize: 40 }));
    expect(JSON.parse(localStorage.getItem('inkstone.settings.v1')!).eraserSize).toBe(40);
  });
});

describe('sync while a note is open', () => {
  it('brings in strokes from another device and keeps strokes written meanwhile', async () => {
    indexedDB.deleteDatabase('inkstone-vault');
    const v = await AppVault.open();
    useApp.setState({ vault: v });
    const { note } = await v.vault.createNote({ title: 'Shared' });
    const s = (await EditorSession.open(v, note.id))!;
    s.doc.addStroke(0, stroke('mine-1'));
    await s.flush();
    const base = new Map(s.doc.committedPages.map((p) => [p.id, p]));
    const baseMeta = s.doc.meta;
    // Another device's stroke arrives on disk via sync...
    const disk = (await v.vault.readNote(note.id))!;
    const pages = await v.vault.readPages(disk);
    await v.vault.saveNote({ ...disk, updatedAt: disk.updatedAt + 1 }, [{ ...pages[0]!, strokes: [...pages[0]!.strokes, stroke('theirs')] }]);
    // ...while this device wrote another stroke that isn't saved yet.
    s.doc.addStroke(0, stroke('mine-2'));
    await s.reloadAfterSync(base, baseMeta);
    expect(s.doc.page(0).strokes.map((x) => x.id).sort()).toEqual(['mine-1', 'mine-2', 'theirs']);
    await s.flush();
    const saved = await v.vault.readPage(note.id, pages[0]!.id);
    expect(saved.strokes.map((x) => x.id).sort()).toEqual(['mine-1', 'mine-2', 'theirs']);
    await s.close();
  });

  it('a clean open note simply shows the synced version', async () => {
    indexedDB.deleteDatabase('inkstone-vault');
    const v = await AppVault.open();
    useApp.setState({ vault: v });
    const { note } = await v.vault.createNote({ title: 'Shared' });
    const s = (await EditorSession.open(v, note.id))!;
    const base = new Map(s.doc.committedPages.map((p) => [p.id, p]));
    const disk = (await v.vault.readNote(note.id))!;
    const pages = await v.vault.readPages(disk);
    await v.vault.saveNote({ ...disk, title: 'Renamed elsewhere' }, [{ ...pages[0]!, strokes: [stroke('theirs')] }]);
    await s.reloadAfterSync(base, s.doc.meta);
    expect(s.doc.meta.title).toBe('Renamed elsewhere');
    expect(s.doc.page(0).strokes.map((x) => x.id)).toEqual(['theirs']);
    await s.close();
  });
});
