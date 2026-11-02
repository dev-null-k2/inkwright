import { describe, expect, it } from 'vitest';
import { MemoryFS, Vault, parseWikiLinks } from '@inkstone/core';
import { seedSampleLibrary } from './sample.ts';

describe('sample library', () => {
  it('writes realistic, searchable notebooks in handwriting', async () => {
    const vault = new Vault(new MemoryFS());
    const r = await seedSampleLibrary(vault);
    expect(r).toEqual({ notebooks: 3, notes: 4 });
    const notebooks = await vault.listNotebooks();
    expect(notebooks.map((n) => n.name).sort()).toEqual(['Journal', 'Signals & Systems', 'Startup']);
    const notes = await vault.listNotes();
    expect(notes).toHaveLength(4);
    for (const meta of notes) {
      const doc = await vault.readNote(meta.id);
      const page = (await vault.readPage(meta.id, doc!.pageIds[0]!))!;
      const strokes = page.strokes;
      expect(strokes.length, meta.title).toBeGreaterThan(20);
      // Every stroke sits on the page and has real pressure/timing data.
      for (const s of strokes) {
        expect(s.points.length).toBeGreaterThan(1);
        for (const p of s.points) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
          expect(p.x).toBeGreaterThan(0);
          expect(p.y).toBeGreaterThan(0);
          expect(p.x).toBeLessThan(page.size?.width ?? 900);
        }
      }
      expect(page.recognizedText.length).toBeGreaterThan(10);
    }
    // Searchable before any AI is configured.
    const lecture = notes.find((n) => n.title.startsWith('Lecture 7'))!;
    const lp = (await vault.readPage(lecture.id, (await vault.readNote(lecture.id))!.pageIds[0]!))!;
    expect(lp.recognizedText).toMatch(/Gibbs/);
    // The design review links to the lecture.
    const review = notes.find((n) => n.title.startsWith('Design review'))!;
    const rp = (await vault.readPage(review.id, (await vault.readNote(review.id))!.pageIds[0]!))!;
    expect(rp.texts.flatMap((t) => parseWikiLinks(t.text).map((l) => l.target))).toContain('Lecture 7 — Fourier series');
  });
});
