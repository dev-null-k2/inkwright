/**
 * Writes a vault of real handwritten notes (the README showcase content: a lecture, study notes,
 * thesis notes, a meeting) into <dir>, for the iOS simulator run to copy into the app's Documents
 * folder, and prints the notes' ids as JSON so the tour can open them. With --strokes it instead
 * prints how many strokes a note has on disk (how the run checks that ink drawn in the app was saved).
 *
 *   npx tsx scripts/ios/seed-vault.ts <dir>
 *   npx tsx scripts/ios/seed-vault.ts --strokes <dir> <noteId>
 *   npx tsx scripts/ios/seed-vault.ts --titles <dir>            (every note's title, as JSON)
 */
import { mkdirSync } from 'node:fs';
import { Vault } from '../../packages/core/src/vault.ts';
import { NodeFS } from '../../apps/mcp-server/src/nodefs.ts';
import { NOTEBOOK_COLORS, launchSync, lecture, studyNotes, thesisNotes, type SeedNote } from '../../apps/web/e2e/showcase/content.ts';

if (process.argv[2] === '--strokes') {
  const [, , , dir, id] = process.argv;
  if (!dir || !id) throw new Error('usage: tsx scripts/ios/seed-vault.ts --strokes <dir> <noteId>');
  const vault = new Vault(new NodeFS(dir));
  const meta = await vault.readNote(id);
  const pages = meta ? await vault.readPages(meta) : [];
  console.log(JSON.stringify({ strokes: pages.reduce((n, p) => n + p.strokes.length, 0) }));
  process.exit(0);
}

if (process.argv[2] === '--titles') {
  const dir = process.argv[3];
  if (!dir) throw new Error('usage: tsx scripts/ios/seed-vault.ts --titles <dir>');
  console.log(JSON.stringify((await new Vault(new NodeFS(dir)).listNotes()).map((n) => n.title)));
  process.exit(0);
}

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
