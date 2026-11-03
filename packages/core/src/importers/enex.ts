/**
 * Evernote export (`.enex`). Evernote exports one notebook per file (File › Export notebook, or
 * a selection of notes) as XML:
 *
 *   <en-export export-date="20261101T120000Z" application="Evernote" version="10.x">
 *     <note>
 *       <title>…</title>
 *       <created>20250102T030405Z</created> <updated>…</updated>
 *       <tag>…</tag>*
 *       <note-attributes><source-url>…</source-url><author>…</author>…</note-attributes>
 *       <content><![CDATA[<?xml …?><!DOCTYPE en-note …><en-note>ENML…</en-note>]]></content>
 *       <resource>*
 *         <data encoding="base64">…</data> <mime>image/png</mime>
 *         <resource-attributes><file-name>scan.png</file-name></resource-attributes>
 *       </resource>
 *     </note>
 *   </en-export>
 *
 * ENML is XHTML plus `<en-media hash="<md5 of the resource bytes>" type="…"/>` for attachments
 * and `<en-todo checked="true"/>` for checkboxes. Newer exports may also carry `<task>` elements
 * (Evernote 10 tasks); their titles are appended as a to-do list. Encrypted text
 * (`<en-crypt>`) cannot be read without the passphrase and is reported, not imported.
 */
import { decodeEntities, htmlToMarkdown } from './html.ts';
import { md5Hex } from './md5.ts';
import { uniqueNames, type ImportReportBase, type ImportedNote } from './vaultfiles.ts';

export interface EnexResource {
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  hash: string;
}

export interface EnexNote {
  title: string;
  created?: number;
  updated?: number;
  tags: string[];
  sourceUrl?: string;
  author?: string;
  /** ENML as exported. */
  enml: string;
  resources: EnexResource[];
  tasks: { title: string; done: boolean }[];
}

/** `20250102T030405Z` → epoch ms. */
export function enexDate(s: string | undefined): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s?.trim() ?? '');
  if (!m) return undefined;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

/** The text of the first `<name>…</name>` in `xml` (entities decoded, CDATA unwrapped). */
function field(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? unwrap(m[1]!) : undefined;
}

function fields(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => unwrap(m[1]!));
}

const unwrap = (s: string) => {
  const c = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return c ? c[1]! : decodeEntities(s);
};

function base64Bytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(clean, 'base64'));
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/amr': 'amr', 'text/plain': 'txt' };

/** Reads every note of an `.enex` file. Throws when the file is not an Evernote export. */
export function parseEnex(xml: string): EnexNote[] {
  if (!/<en-export[\s>]/i.test(xml)) throw new Error('This is not an Evernote export (.enex): there is no <en-export> element.');
  const notes: EnexNote[] = [];
  for (const m of xml.matchAll(/<note>([\s\S]*?)<\/note>/gi)) {
    const n = m[1]!;
    // Resources first: their bodies are large and must not be searched for other fields.
    const resources: EnexResource[] = [];
    const rest = n.replace(/<resource>([\s\S]*?)<\/resource>/gi, (_all, r: string) => {
      const data = /<data(?:\s[^>]*)?>([\s\S]*?)<\/data>/i.exec(r)?.[1] ?? '';
      const bytes = base64Bytes(data);
      const mime = field(r, 'mime')?.trim() || 'application/octet-stream';
      const name = field(r, 'file-name')?.trim() || `attachment-${resources.length + 1}.${EXT[mime] ?? 'bin'}`;
      resources.push({ fileName: name, mime, bytes, hash: md5Hex(bytes) });
      return '';
    });
    const attrs = field(rest, 'note-attributes') ?? '';
    const tasks = [...rest.matchAll(/<task>([\s\S]*?)<\/task>/gi)].map((t) => ({ title: field(t[1]!, 'title')?.trim() ?? '', done: /<taskStatus>\s*completed\s*<\/taskStatus>/i.test(t[1]!) })).filter((t) => t.title);
    notes.push({
      title: field(rest.replace(/<task>[\s\S]*?<\/task>/gi, ''), 'title')?.trim() || 'Untitled',
      created: enexDate(field(rest, 'created')),
      updated: enexDate(field(rest, 'updated')),
      tags: fields(rest, 'tag').map((t) => t.trim()).filter(Boolean),
      ...(field(attrs, 'source-url') ? { sourceUrl: field(attrs, 'source-url')!.trim() } : {}),
      ...(field(attrs, 'author') ? { author: field(attrs, 'author')!.trim() } : {}),
      enml: field(rest, 'content') ?? '',
      resources,
      tasks,
    });
  }
  return notes;
}

export interface EnexImport extends ImportReportBase {
  notes: number;
  items: ImportedNote[];
}

/**
 * An `.enex` file as notes in one notebook (named after the file, as Evernote names exports
 * after the notebook). Attachments referenced from the note become images or embedded PDFs where
 * they are; others are listed at the end of the note with their names.
 */
export function enexToNotes(fileName: string, xml: string): EnexImport {
  const notebook = fileName.replace(/^.*[\\/]/, '').replace(/\.enex$/i, '') || 'Evernote';
  const warnings: string[] = [];
  const items: ImportedNote[] = [];
  let attachments = 0;
  for (const n of parseEnex(xml)) {
    const names = uniqueNames(n.resources.map((r) => (/\.[a-z0-9]{1,8}$/i.test(r.fileName) ? r.fileName : `${r.fileName}.${EXT[r.mime] ?? 'bin'}`)));
    const byHash = new Map(n.resources.map((r, i) => [r.hash, names[i]!]));
    const placed = new Set<string>();
    if (/<en-crypt[\s>]/i.test(n.enml)) warnings.push(`“${n.title}” has encrypted text, which was left out (decrypt it in Evernote before exporting).`);
    let body = htmlToMarkdown(n.enml.replace(/<en-crypt[\s\S]*?<\/en-crypt>/gi, '<p>[Encrypted text left out]</p>'), {
      image: (src) => {
        if (!src.startsWith('en-media:')) return null;
        const name = byHash.get(src.slice(9).toLowerCase());
        if (name) placed.add(name);
        return name ?? null;
      },
    });
    // Attachments the note body never shows (Evernote lists them under the note): pictures and
    // PDFs go at the end where they can be seen; other files are named.
    const unplaced = names.filter((x) => !placed.has(x));
    const showable = unplaced.filter((x) => /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(x));
    const other = unplaced.filter((x) => !showable.includes(x));
    if (showable.length) body += `\n\n${showable.map((x) => `![${x}](<${x}>)`).join('\n\n')}\n`;
    if (other.length) body += `\n\nAttachments not shown: ${other.join(', ')}\n`;
    if (n.tasks.length) body += `\n\n## Tasks\n${n.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.title}`).join('\n')}\n`;
    attachments += n.resources.length;
    items.push({
      folder: notebook,
      title: n.title,
      body,
      tags: n.tags,
      ...(n.created ? { created: n.created } : {}),
      ...(n.updated ? { updated: n.updated } : {}),
      properties: { ...(n.sourceUrl ? { source: n.sourceUrl } : {}), ...(n.author ? { author: n.author } : {}) },
      attachments: n.resources.map((r, i) => ({ name: names[i]!, bytes: r.bytes })),
    });
  }
  return { notes: items.length, attachments, warnings, items };
}
