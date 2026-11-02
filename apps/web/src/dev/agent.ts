/**
 * The developer module's assistant tools in the app: create_diagram (verified, placed in the open
 * note — undoable there — or in a new note, which Activity can undo), code_search, code_symbol and
 * drift_report. Added to every run that may write notes while the module is on.
 */
import { makeDiagramObject, newId, pageSizeOf, type DiagramIR, type NoteDocument } from '@inkwright/core';
import { DEV_TOOLS_PROMPT, createCodeTools, createDiagramTool, type AgentTool, type DevToolHost, type NoteToolHost } from '@inkwright/ai';
import type { AppVault } from '../lib/vault.ts';
import { noteChanged } from '../lib/actions.ts';
import { devToolsOn } from './settings.ts';
import { allDrift, ensureCodeLoaded, useDev } from './store.ts';

/** Where a diagram goes on a page: below what is there, centred, at most the page's width. */
function placeOn(doc: NoteDocument, ir: DiagramIR, origin: 'ai') {
  const pageIndex = Math.max(0, doc.pageCount - 1);
  const size = pageSizeOf(doc.meta, doc.page(pageIndex));
  const width = Math.min(560, (size.width || 800) - 160);
  const obj = makeDiagramObject(ir, { id: newId(), x: 80, y: 0, width, now: Date.now(), origin });
  const page = doc.page(pageIndex);
  const bottoms = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 40), ...(page.objects ?? []).map((o) => o.y + ('height' in o ? (o.height as number) : 40))];
  obj.y = Math.round(Math.max(96, ...bottoms) + 32);
  obj.x = Math.round(((size.width || 800) - obj.width) / 2);
  doc.editObjects(pageIndex, 'Add diagram', { upsert: [obj] });
  return { pageIndex, objectId: obj.id };
}

export async function devAgentTools(o: { vault: AppVault; openDoc: NoteDocument | null; host: NoteToolHost }): Promise<{ tools: AgentTool[]; prompt: string } | null> {
  if (!devToolsOn()) return null;
  await ensureCodeLoaded().catch(() => {});
  const host: DevToolHost = {
    codeGraphs: async () => useDev.getState().graphs,
    driftReport: () => allDrift(),
    placeDiagram: async (ir, opts) => {
      const doc = o.openDoc;
      if (doc && (!opts.noteId || opts.noteId === doc.meta.id)) {
        const r = placeOn(doc, ir, 'ai');
        return { noteId: doc.meta.id, title: doc.meta.title, ...r };
      }
      // Elsewhere: a new note (create_note is recorded in Activity, so the whole thing undoes).
      const note = opts.noteId ? await o.vault.vault.readNote(opts.noteId) : null;
      const target = note ?? await o.host.createNote({ title: opts.title ?? ir.title ?? 'Diagram', text: '' }).then((n) => o.vault.vault.readNote(n.id));
      if (!target) throw new Error('Could not open the note for the diagram.');
      if (target.lock) throw new Error('That note is locked.');
      const pages = await o.vault.vault.readPages(target);
      const pageIndex = pages.length - 1;
      const size = pageSizeOf(target, pages[pageIndex]);
      const obj = makeDiagramObject(ir, { id: newId(), x: 80, y: 120, width: Math.min(560, (size.width || 800) - 160), now: Date.now(), origin: 'ai' });
      const last = pages[pageIndex]!;
      pages[pageIndex] = { ...last, objects: [...(last.objects ?? []), obj] };
      await o.vault.vault.saveNote({ ...target, updatedAt: Date.now() }, pages, { changedPageIds: new Set([last.id]) });
      await noteChanged(target.id);
      return { noteId: target.id, title: target.title, pageIndex, objectId: obj.id };
    },
  };
  return { tools: [createDiagramTool(host), ...createCodeTools(host)], prompt: DEV_TOOLS_PROMPT };
}

/** A diagram the user wrote in the Insert diagram dialog (no origin: it is theirs). */
export function placeUserDiagram(doc: NoteDocument, ir: DiagramIR, pageIndex: number, center: { x: number; y: number }): string {
  const size = pageSizeOf(doc.meta, doc.page(pageIndex));
  const obj = makeDiagramObject(ir, { id: newId(), x: 0, y: 0, width: Math.min(560, (size.width || 800) - 160), now: Date.now() });
  obj.x = Math.round(Math.max(24, center.x - obj.width / 2));
  obj.y = Math.round(Math.max(24, center.y - obj.height / 2));
  doc.editObjects(pageIndex, 'Add diagram', { upsert: [obj] });
  return obj.id;
}
