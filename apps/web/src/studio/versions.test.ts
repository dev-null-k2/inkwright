import { beforeEach, describe, expect, it } from 'vitest';
import { NoteLockedError, VersionHistory, type InkStroke } from '@inkstone/core';
import { AppVault } from '../lib/vault.ts';
import { EditorSession } from '../lib/session.ts';
import { useApp } from '../state/app.ts';
import { NoteVersioning, snapshotBeforeAgentEdit } from './versions.ts';

const stroke = (id: string, y: number): InkStroke => ({ id, pen: 'fountain', color: '#FF1B1F24', size: 2, createdAt: Date.now(), input: 'pen', points: Array.from({ length: 20 }, (_, i) => ({ x: 10 + i * 4, y: y + Math.sin(i), t: i * 8, p: 0.5, tilt: -1, orient: -1 })) });
const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 50 && !(await f()); i++) await new Promise((r) => setTimeout(r, 10)); };

describe('version history in the editor', () => {
  beforeEach(() => indexedDB.deleteDatabase('inkstone-vault'));

  it('snapshots on open, while editing and before an assistant edit, never twice for the same state', async () => {
    const v = await AppVault.open();
    useApp.setState({ vault: v });
    const { note } = await v.vault.createNote({ title: 'Lecture' });
    const s = (await EditorSession.open(v, note.id))!;
    const ver = new NoteVersioning(s, 0);
    await ver.start();
    expect((await ver.history.list(note.id)).map((x) => x.reason)).toEqual(['open']);
    s.doc.addStroke(0, stroke('a', 40));
    await ver.take('interval');
    await ver.take('interval'); // nothing changed since
    expect((await ver.history.list(note.id)).map((x) => x.reason)).toEqual(['interval', 'open']);
    // The assistant is about to change it: the state right now is kept, without waiting.
    s.doc.addStroke(0, stroke('b', 80));
    snapshotBeforeAgentEdit(v, s.doc.meta, s.doc.committedPages);
    await until(async () => (await ver.history.list(note.id)).length === 3);
    const list = await ver.history.list(note.id);
    expect(list[0]!.reason).toBe('agent');
    expect((await ver.history.read(note.id, list[0]!.id))!.pages[0]!.strokes.map((x) => x.id)).toEqual(['a', 'b']);
    await ver.close();
    await s.close();
  });

  it('a locked note opens only with its key and its history is encrypted', async () => {
    const v = await AppVault.open();
    useApp.setState({ vault: v });
    const { note, pages } = await v.vault.createNote({ title: 'Diary' });
    const locked = await v.vault.lockNote(note, [{ ...pages[0]!, strokes: [stroke('a', 40)] }], 'tulip-42', { iterations: 1000 });
    const key = v.vault.keyFor(note.id)!;
    v.vault.forget(note.id);
    await expect(EditorSession.open(v, note.id)).rejects.toBeInstanceOf(NoteLockedError);
    v.vault.unlock(note.id, key);
    const s = (await EditorSession.open(v, note.id))!;
    expect(s.doc.page(0).strokes).toHaveLength(1);
    const ver = new NoteVersioning(s, 0);
    await ver.start();
    const [snap] = await new VersionHistory(v.vault).list(note.id);
    expect(snap!.locked).toBe(true);
    // Search never sees its content.
    s.doc.addStroke(0, stroke('b', 80));
    s.doc.setRecognizedText(s.doc.page(0).id, 'secret words');
    await s.flush();
    expect(v.search.search('secret').length).toBe(0);
    expect(locked.lock).toBeTruthy();
    await ver.close();
    await s.close();
  });
});
