import { VaultLayout, decodeNote, decodePage, exportMarkdown, exportPageSvg, isSafeId, newPage, type PageInk, type VaultFS } from '@inkstone/core';

/** `notes/<id>/...` → `<id>`. */
export function noteIdOf(path: string): string | null {
  const m = /^notes\/([^/]+)\//.exec(path);
  return m && isSafeId(m[1]!) ? m[1]! : null;
}

/**
 * Rewrites a note's derived files (`note.md`, `pages/*.svg`) from its sources, exactly as
 * `Vault.saveNote` would. Only files whose content changes are written. Returns written paths.
 */
export async function regenerateDerived(fs: VaultFS, noteId: string): Promise<string[]> {
  if (!isSafeId(noteId)) return [];
  const text = await fs.readText(VaultLayout.noteMeta(noteId));
  if (text == null) return [];
  let note;
  try {
    note = decodeNote(text);
  } catch {
    return [];
  }
  const written: string[] = [];
  const put = async (path: string, content: string) => {
    if ((await fs.readText(path)) !== content) {
      await fs.writeText(path, content);
      written.push(path);
    }
  };
  const pages: PageInk[] = [];
  for (const pid of note.pageIds) {
    if (!isSafeId(pid)) continue;
    const t = await fs.readText(VaultLayout.pageInk(noteId, pid));
    let page: PageInk | null = null;
    if (t != null) {
      try {
        page = decodePage(t);
      } catch {
        page = null;
      }
    }
    if (page) await put(VaultLayout.pageSvg(noteId, pid), exportPageSvg(note, page));
    pages.push(page ?? newPage(pid));
  }
  await put(VaultLayout.noteMarkdown(noteId), exportMarkdown(note, pages));
  return written;
}
