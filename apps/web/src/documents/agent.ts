/**
 * The assistant's document tools in the app (read_document, edit_document from @inkwright/ai),
 * over the open note when it is the document in question (so the editor updates live and the
 * change is one undo step there) or the vault otherwise. The AI policy applies as for every note
 * tool: hidden notes don't exist for the assistant, read-only ones can't be edited, and what it
 * reads counts as seen for the run's routing.
 */
import { DOCUMENT_TOOLS_PROMPT, accessFor, createDocumentTools, type AgentTool, type DocumentToolHost, type NewActivityOp, type TrustRun } from '@inkwright/ai';
import { documentBody, type NoteDocument } from '@inkwright/core';
import type { AppVault } from '../lib/vault.ts';
import { noteChanged } from '../lib/actions.ts';
import { currentPolicy, noteLabelOf } from '../lib/trust/state.ts';
import { snapshotBeforeAgentEdit } from '../studio/versions.ts';

export interface DocumentAgentOptions {
  vault: AppVault;
  openDoc: NoteDocument | null;
  run?: TrustRun;
  record?: (op: NewActivityOp) => void;
  /** Read-only runs only get read_document. */
  write: boolean;
}

export function documentToolHost(o: Pick<DocumentAgentOptions, 'vault' | 'openDoc' | 'run'>): DocumentToolHost {
  const access = (id: string) => {
    const label = noteLabelOf(id);
    return { label, level: label ? accessFor(currentPolicy(), label) : 'read-write' as const };
  };
  const load = async (id: string) => {
    if (o.openDoc?.meta.id === id) return { meta: o.openDoc.meta, page: o.openDoc.page(0), open: o.openDoc };
    const meta = await o.vault.vault.readNote(id);
    if (!meta || meta.lock || !meta.document) return null;
    const pages = await o.vault.vault.readPages(meta);
    return pages[0] ? { meta, page: pages[0], pages, open: null } : null;
  };
  return {
    async readDocument(id) {
      const a = access(id);
      if (a.level === 'none') return null;
      const n = await load(id);
      if (!n || !n.meta.document) return null;
      const body = documentBody(n.page);
      if (!body) return null;
      if (a.label) o.run?.see(a.label);
      return { title: n.meta.title, markdown: body.text, pageId: n.page.id, textId: body.id };
    },
    async writeDocument(id, expected, next) {
      const a = access(id);
      if (a.level === 'none') return 'missing';
      if (a.level !== 'read-write') throw new Error(`“${a.label?.title ?? 'This document'}” is read-only for the assistant (AI policy). Tell the user what you would change instead.`);
      const n = await load(id);
      const body = n && documentBody(n.page);
      if (!n || !body) return 'missing';
      if (body.text !== expected) return 'changed';
      if (n.open) {
        n.open.upsertText(0, { ...body, text: next }, 'AI edited the document');
        return 'written';
      }
      // Version history keeps the document as it was before the assistant changed it.
      snapshotBeforeAgentEdit(o.vault, n.meta, n.pages!);
      const page = { ...n.page, texts: (n.page.texts ?? []).map((t) => (t.id === body.id ? { ...t, text: next } : t)) };
      const meta = { ...n.meta, updatedAt: Date.now() };
      await o.vault.vault.saveNote(meta, [page, ...n.pages!.slice(1)], { changedPageIds: [page.id] });
      await noteChanged(id);
      return 'written';
    },
  };
}

/** Tools and the prompt section for one assistant run. */
export function documentAgentTools(o: DocumentAgentOptions): { tools: AgentTool[]; prompt: string } {
  const tools = createDocumentTools(documentToolHost(o), { record: o.record });
  return { tools: o.write ? tools : tools.filter((t) => t.name === 'read_document'), prompt: DOCUMENT_TOOLS_PROMPT };
}
