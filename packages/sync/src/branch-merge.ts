/**
 * Merging a branch (core branches.ts) back into the notes: the same three-way merge sync uses
 * between devices, with the branch as the "remote" side.
 *
 * For each note the branch changed: base = main when the branch first touched it, local = main
 * now, remote = the branch's head. Strokes, text boxes and page objects merge by id (both sides'
 * additions kept, deletions applied, an item edited on both sides takes the branch's version),
 * metadata merges field by field, and the page order merges like sync's. A note the branch
 * created comes over as it is; a note deleted from main since is brought back, because merging
 * is the person saying they want the branch's content.
 */
import type { NoteMeta, PageInk } from '@inkwright/core';
import { mergeNote, mergeOrder, mergePage } from './merge.ts';

export interface NoteVersion {
  meta: NoteMeta;
  pages: PageInk[];
}

export interface BranchMergeResult {
  meta: NoteMeta;
  pages: PageInk[];
  /** True when main had changed since the branch started (a real three-way merge happened). */
  threeWay: boolean;
}

export function mergeBranchNote(base: NoteVersion | null, main: NoteVersion | null, head: NoteVersion): BranchMergeResult {
  if (!main) return { meta: head.meta, pages: head.pages, threeWay: false };
  const sameAsBase = base && JSON.stringify(base.meta.pageIds) === JSON.stringify(main.meta.pageIds) && main.meta.updatedAt === base.meta.updatedAt;
  const meta = mergeNote(base?.meta ?? null, main.meta, head.meta, { prefer: 'remote' });
  const byId = (v: NoteVersion | null) => new Map((v?.pages ?? []).map((p) => [p.id, p]));
  const [b, m, h] = [byId(base), byId(main), byId(head)];
  // Page order: both sides' additions, deletions only where the other side left the page alone.
  const keep = new Set<string>();
  for (const id of new Set([...m.keys(), ...h.keys()])) {
    const inBase = b.has(id);
    const deletedOnMain = inBase && !m.has(id);
    const deletedOnBranch = inBase && !h.has(id);
    if (deletedOnMain && JSON.stringify(h.get(id)) === JSON.stringify(b.get(id))) continue;
    if (deletedOnBranch && JSON.stringify(m.get(id)) === JSON.stringify(b.get(id))) continue;
    keep.add(id);
  }
  const order = mergeOrder(base ? base.meta.pageIds : null, main.meta.pageIds, head.meta.pageIds, keep, { prefer: 'b' });
  const pages = order.map((id) => {
    const mp = m.get(id);
    const hp = h.get(id);
    if (mp && hp) return mergePage(b.get(id) ?? null, mp, hp, { prefer: 'remote' });
    return (hp ?? mp)!;
  });
  return { meta: { ...meta, pageIds: order }, pages, threeWay: !sameAsBase };
}
