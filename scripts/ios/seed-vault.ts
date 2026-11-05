/**
 * Writes a vault of real handwritten notes (the README showcase content: a lecture, study notes,
 * thesis notes, a meeting) into <dir>, for the iOS simulator run to copy into the app's Documents
 * folder, and prints the notes' ids as JSON so the tour can open them.
 *
 *   npx tsx scripts/ios/seed-vault.ts <dir>
 */
import { mkdirSync } from 'node:fs';
import { Vault } from '../../packages/core/src/vault.ts';
import { NodeFS } from '../../apps/mcp-server/src/nodefs.ts';
import { NOTEBOOK_COLORS, launchSync, lecture, studyNotes, thesisNotes, type SeedNote } from '../../apps/web/e2e/showcase/content.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: tsx scripts/ios/seed-vault.ts <dir>');
mkdirSync(dir, { recursive: true });
const now = Date.now();
const v = new Vault(new NodeFS(dir), () => now);
await v.init();
const books = new Map<string, string>();
const ids: Record<string, string> = {};
const notes: [string, SeedNote][] = [['lecture', lecture(now)], ['study', studyNotes(now)], ['meeting', launchSync(now)], ...thesisNotes(now).map((n, i): [string, SeedNote] => [`thesis${i}`, n])];
for (const [key, n] of notes) {
  if (!books.has(n.notebook)) books.set(n.notebook, (await v.createNotebook(n.notebook, NOTEBOOK_COLORS[n.notebook])).id);
  const { note, pages } = await v.createNote({ title: n.title, notebookId: books.get(n.notebook), tags: n.tags, paper: n.paper });
  const at = now - n.agoMin * 60_000;
  const p = n.pages[0]!;
  await v.saveNote({ ...note, createdAt: at - 40 * 60_000, updatedAt: at }, [{ ...pages[0]!, strokes: p.strokes, texts: p.texts ?? [], recognizedText: p.recognizedText, recognizedLines: p.recognizedLines, recognizedAt: at, recognizedBy: 'mlkit' }]);
  ids[key] = note.id;
}
console.log(JSON.stringify(ids));
