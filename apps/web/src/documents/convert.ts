/**
 * HTML → stored Markdown through the editor's own schema, so whatever comes in (an imported
 * .html or .docx file) is reduced to exactly what a document can hold before it is saved.
 * Part of the lazily loaded document chunk (it needs Tiptap).
 */
import { Editor } from '@tiptap/core';
import { documentExtensions } from './extensions.ts';
import { prepareHtml, toMarkdown, type AssetResolver, type PMNode } from './markdown.ts';

export function htmlToMarkdown(html: string, resolve?: AssetResolver): string {
  const e = new Editor({ extensions: documentExtensions(), content: prepareHtml(html, resolve) });
  try {
    return toMarkdown(e.getJSON() as PMNode);
  } finally {
    e.destroy();
  }
}

export interface ImportedDocument {
  title: string;
  /** Editor HTML (images refer to `data-asset` names in `images`). */
  html: string;
  images: { name: string; bytes: Uint8Array; mime: string }[];
}

/** Reads a .docx, .md/.markdown/.txt or .html file for a document. */
export async function readDocumentFile(file: File, assetPrefix: string): Promise<ImportedDocument> {
  const name = file.name.replace(/\.[^.]+$/, '') || 'Document';
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { fromDocx } = await import('./docx.ts');
    const r = fromDocx(new Uint8Array(await file.arrayBuffer()), assetPrefix);
    return { title: r.title ?? name, html: r.html, images: r.images };
  }
  const text = await file.text();
  if (ext === 'html' || ext === 'htm' || file.type === 'text/html') {
    const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text)?.[1] ?? text;
    return { title: title || name, html: body, images: [] };
  }
  if (['md', 'markdown', 'txt', 'text'].includes(ext) || file.type.startsWith('text/')) {
    const { markdownToHtml } = await import('./markdown.ts');
    const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    return { title: h1 || name, html: markdownToHtml(text), images: [] };
  }
  throw new Error(`${file.name} isn't a Word, Markdown or HTML file.`);
}

/** What the import pickers accept. */
export const DOCUMENT_FILES = '.docx,.md,.markdown,.txt,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/html,text/plain';
