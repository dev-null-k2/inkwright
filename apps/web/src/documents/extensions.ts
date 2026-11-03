/**
 * The document editor's schema: Tiptap (ProseMirror, MIT) with the nodes and marks that map onto
 * the stored Markdown (markdown.ts). Loaded only when a document is opened (DocumentEditor is a
 * lazy chunk), so the library and the ink editor never pay for it.
 */
import { Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: {
      /** Inserts a manual page break (printing and PDF export start a new page there). */
      setPageBreak: () => ReturnType;
    };
  }
}

/** `<div class="page-break"></div>`: where printing and PDF/DOCX export start a new page. */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div.page-break' }, { tag: 'hr.page-break' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { class: 'page-break', 'data-label': 'Page break' })],
  addCommands() {
    return {
      setPageBreak: () => ({ chain }) => chain().insertContent({ type: this.name }).createParagraphNear().run(),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
  },
});

/** Images remember which of the note's files they show (`data-asset`), so Markdown stores `assets/<name>`. */
export const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      asset: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-asset'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.asset ? { 'data-asset': attrs.asset } : {}),
      },
    };
  },
});

/** Everything the document editor uses. `placeholder` shows on an empty document. */
export function documentExtensions(placeholder = 'Start writing…'): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    DocImage.configure({ inline: false, allowBase64: false }),
    PageBreak,
    Placeholder.configure({ placeholder }),
  ];
}
