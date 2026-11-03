import { DOCUMENT_EDIT_OPS, applyDocumentEdit, documentOutline, documentWords, type DocumentEdit } from '@inkwright/core';
import type { AgentTool } from '../agent.ts';
import type { NewActivityOp } from '../activity.ts';

/**
 * The assistant's tools for document notes (typed, formatted notes: see `richdoc.ts` in core).
 *
 * `read_note` already returns a document's Markdown like any typed text; these add the structure
 * (outline, word count) and precise edits — append, replace exact text, replace or extend a
 * section — so the assistant changes a report the way a person would, instead of rewriting it.
 * Every edit is recorded as `text_replaced` in AI activity, so it can be undone without touching
 * anything the user wrote since.
 */
export interface DocumentToolHost {
  /** The document's Markdown and where it lives, or null when the note isn't a document (or isn't visible to AI). */
  readDocument(noteId: string): Promise<{ title: string; markdown: string; pageId: string; textId: string } | null>;
  /**
   * Replaces the body with `next` while it still holds `expected` (otherwise 'changed': someone
   * edited it meanwhile). Hosts check the AI policy's write permission here.
   */
  writeDocument(noteId: string, expected: string, next: string): Promise<'written' | 'changed' | 'missing'>;
}

export interface DocumentToolOptions {
  /** Records the change for AI activity and undo. */
  record?: (op: NewActivityOp) => void;
  /** Characters of Markdown returned by read_document (default 24k). */
  maxChars?: number;
}

const OP_HELP =
  'append: add markdown at the end. prepend: add at the start. replace_all: replace the whole document (only when asked to rewrite it). ' +
  'replace_text: replace the exact text in find (copy it from read_document, Markdown included; set all for every occurrence). ' +
  'replace_section: replace everything under the heading named in heading, up to the next heading of the same level. ' +
  'append_to_section: add markdown at the end of that section.';

export const DOCUMENT_TOOLS_PROMPT =
  'Some notes are documents (read_note shows kind "document"): typed, formatted text in Markdown — headings, **bold**, lists, "- [ ] " checklists, tables, ' +
  '<u>underline</u>, and <div class="page-break"></div> for a page break. Use read_document to see one with its outline, and edit_document to change it ' +
  'precisely (prefer replace_text or the section operations to replace_all). append_to_note does not work on documents.';

function notADocument(id: string): Error {
  return new Error(`Note "${id}" is not a document (or you can't see it). Use read_note for handwritten and ordinary notes.`);
}

export function createDocumentTools(host: DocumentToolHost, opts: DocumentToolOptions = {}): AgentTool[] {
  const max = opts.maxChars ?? 24_000;
  return [
    {
      name: 'read_document',
      description: 'Read a document note: its Markdown, outline (headings) and word count. Use it before edit_document so edits match the exact text.',
      parameters: { type: 'object', properties: { note_id: { type: 'string', description: 'The document\'s note id.' } }, required: ['note_id'], additionalProperties: false },
      readOnly: true,
      async execute(a: { note_id: string }) {
        const d = await host.readDocument(a.note_id);
        if (!d) throw notADocument(a.note_id);
        const markdown = d.markdown.length > max ? `${d.markdown.slice(0, max)}…[truncated]` : d.markdown;
        return { note_id: a.note_id, title: d.title, words: documentWords(d.markdown), outline: documentOutline(d.markdown).map((h) => `${'#'.repeat(h.level)} ${h.text}`), markdown };
      },
    },
    {
      name: 'edit_document',
      description: `Change a document note. ${OP_HELP} The user can undo it from AI activity.`,
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'The document\'s note id.' },
          operation: { type: 'string', enum: [...DOCUMENT_EDIT_OPS], description: 'What to do.' },
          markdown: { type: 'string', description: 'The new Markdown (append, prepend, replace_all, replace_section, append_to_section).' },
          find: { type: 'string', description: 'replace_text: the exact text to replace.' },
          replace: { type: 'string', description: 'replace_text: what to put instead (may be empty to delete).' },
          all: { type: 'boolean', description: 'replace_text: change every occurrence.' },
          heading: { type: 'string', description: 'replace_section / append_to_section: the heading\'s text.' },
        },
        required: ['note_id', 'operation'],
        additionalProperties: false,
      },
      async execute(a: { note_id: string; operation: DocumentEdit['op']; markdown?: string; find?: string; replace?: string; all?: boolean; heading?: string }) {
        const d = await host.readDocument(a.note_id);
        if (!d) throw notADocument(a.note_id);
        const need = (v: string | undefined, name: string) => {
          if (v == null) throw new Error(`${a.operation} needs ${name}.`);
          return v;
        };
        let edit: DocumentEdit;
        switch (a.operation) {
          case 'replace_text': edit = { op: 'replace_text', find: need(a.find, 'find'), replace: a.replace ?? '', all: a.all }; break;
          case 'replace_section':
          case 'append_to_section': edit = { op: a.operation, heading: need(a.heading, 'heading'), markdown: need(a.markdown, 'markdown') }; break;
          case 'append':
          case 'prepend':
          case 'replace_all': edit = { op: a.operation, markdown: need(a.markdown, 'markdown') }; break;
          default: throw new Error(`Unknown operation "${String(a.operation)}". Use one of: ${DOCUMENT_EDIT_OPS.join(', ')}.`);
        }
        const next = applyDocumentEdit(d.markdown, edit);
        if (next === d.markdown) return { changed: false, note_id: a.note_id };
        const r = await host.writeDocument(a.note_id, d.markdown, next);
        if (r === 'missing') throw notADocument(a.note_id);
        if (r === 'changed') throw new Error('The document changed while you were editing it. Read it again and retry.');
        opts.record?.({ kind: 'text_replaced', tool: 'edit_document', noteId: a.note_id, title: d.title, pageId: d.pageId, textId: d.textId, before: d.markdown, after: next, summary: `Edited the document “${d.title}” (${a.operation.replace(/_/g, ' ')})` });
        return { changed: true, note_id: a.note_id, words: documentWords(next) };
      },
    },
  ];
}
