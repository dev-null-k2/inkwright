/**
 * OneNote. OneNote keeps notebooks in a binary format (`.one`, MS-ONESTORE; `.onepkg` is a
 * cabinet of them) that has no complete public reader, so Inkwright imports what OneNote itself
 * exports (support.microsoft.com, "Export a copy of a page, section, or notebook"):
 *
 * - **Word document (`.docx`)** — OneNote for Windows: File › Export › Page or Section › Word
 *   Document. Paragraph styles carry headings (`Heading1`…`Heading6`, `Title`), `w:numPr` marks
 *   list items, runs carry bold/italic, tables are kept, pictures are `a:blip r:embed` references
 *   resolved through `word/_rels/document.xml.rels` to `word/media/…`.
 * - **Single File Web Page (`.mht`/`.mhtml`)** — the same Export menu. A MIME
 *   `multipart/related` message: an HTML part plus each picture as its own part with a
 *   `Content-Location`, base64- or quoted-printable-encoded.
 * - **Web page (`.html`/`.htm`)** saved alongside its `_files` folder.
 * - **PDF** — every OneNote (Windows, Mac, the web app via print) can make one; it goes through
 *   the PDF notebook importer (`pdfnotebook.ts`).
 *
 * Not supported, and said so: `.one`/`.onepkg` files themselves, ink drawn in OneNote (a `.docx`
 * export flattens it to a picture, which is kept), and OneNote's free-floating page layout (the
 * export is already linear).
 */
import { decodeEntities, htmlToMarkdown } from './html.ts';
import { uniqueNames, type ImportedAttachment, type ImportedNote } from './vaultfiles.ts';

const dec = new TextDecoder();

// ---- .docx --------------------------------------------------------------------------------------

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Plain text of one `w:p`, with bold/italic runs as Markdown. */
function runsText(p: string): string {
  let out = '';
  for (const r of p.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>|<w:hyperlink[^>]*>|<\/w:hyperlink>/g)) {
    const body = r[1];
    if (body == null) continue;
    const rpr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body)?.[1] ?? '';
    const on = (k: string) => new RegExp(`<w:${k}(?:\\s+w:val="(?:true|1|on)")?\\s*/>`).test(rpr);
    let t = '';
    for (const x of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) t += x[1] != null ? decodeEntities(x[1]) : x[0].startsWith('<w:tab') ? '\t' : '\n';
    if (!t) continue;
    const esc = t.replace(/([\\`*_[\]])/g, '\\$1');
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(esc)!;
    const wrap = on('b') && on('i') ? '***' : on('b') ? '**' : on('i') ? '_' : '';
    out += wrap && m[2] ? `${m[1]}${wrap}${m[2]}${wrap}${m[3]}` : esc;
  }
  return out;
}

export interface DocxEntry {
  path: string;
  bytes: Uint8Array;
}

/**
 * A Word document (its zip entries) as Markdown plus the pictures it shows. Used for OneNote's
 * Word export; also reads ordinary Word files.
 */
export function docxToMarkdown(entries: readonly DocxEntry[]): { markdown: string; images: ImportedAttachment[]; title?: string } {
  const get = (p: string) => entries.find((e) => e.path.replace(/^\/+/, '').toLowerCase() === p.toLowerCase());
  const doc = get('word/document.xml');
  if (!doc) throw new Error('This is not a Word document (word/document.xml is missing).');
  const xml = dec.decode(doc.bytes);
  const rels = new Map<string, string>();
  const relsXml = get('word/_rels/document.xml.rels');
  if (relsXml) for (const m of dec.decode(relsXml.bytes).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `word/${target}`);
  }
  const core = get('docProps/core.xml');
  const coreTitle = core ? decodeEntities(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(dec.decode(core.bytes))?.[1] ?? '').trim() || undefined : undefined;
  const mediaNames: string[] = [];
  const mediaBytes: Uint8Array[] = [];
  const mediaIndex = new Map<string, number>();
  const image = (relId: string): string | null => {
    const path = rels.get(relId);
    const e = path ? get(path.replace(/\/\.\//g, '/')) : undefined;
    if (!e) return null;
    if (!mediaIndex.has(path!)) { mediaIndex.set(path!, mediaNames.length); mediaNames.push(path!.split('/').pop()!); mediaBytes.push(e.bytes); }
    return path!;
  };
  const lines: string[] = [];
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  // OneNote puts the page title first, in the Title style: it is the note's title, not a heading.
  let styledTitle: string | undefined;
  const paragraph = (p: string): string => {
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(p)?.[1] ?? '';
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1] ?? '';
    if (/^Title$/i.test(style) && styledTitle === undefined && !lines.some(Boolean)) {
      styledTitle = runsText(p).replace(/\\([\\`*_[\]])/g, '$1').trim();
      if (styledTitle) return '';
    }
    const h = /^(?:Heading|heading\s?)(\d)$/.exec(style)?.[1] ?? (/^Title$/i.test(style) ? '1' : null);
    const list = /<w:numPr>[\s\S]*?<w:ilvl\s+w:val="(\d+)"/.exec(pPr);
    const imgs = [...p.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)].map((m) => image(m[1]!)).filter((x): x is string => !!x);
    let text = runsText(p).trim();
    if (h && text) text = `${'#'.repeat(Math.min(6, Number(h)))} ${text}`;
    else if (list && text) text = `${'  '.repeat(Number(list[1]))}- ${text}`;
    const pics = imgs.map((path) => `![](<@media:${path}>)`);
    return [text, ...pics].filter(Boolean).join('\n\n');
  };
  for (const m of body.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    if (m[1] != null) {
      const rows = [...m[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((r) => [...r[1]!.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) => [...c[1]!.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((x) => paragraph(x[0])).join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()));
      const cols = Math.max(0, ...rows.map((r) => r.length));
      if (cols === 1) rows.forEach((r) => lines.push(r[0] ?? '', ''));
      else if (cols > 1) {
        const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')];
        lines.push(`| ${pad(rows[0]!).join(' | ')} |`, `|${' --- |'.repeat(cols)}`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`), '');
      }
      continue;
    }
    const para = paragraph(m[0]);
    const isList = /^\s*- /.test(para);
    if (!para) { if (lines[lines.length - 1] !== '') lines.push(''); continue; }
    lines.push(para);
    if (!isList) lines.push('');
  }
  const names = uniqueNames(mediaNames);
  let markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  for (const [path, i] of mediaIndex) markdown = markdown.split(`<@media:${path}>`).join(`<${names[i]}>`);
  const title = coreTitle ?? styledTitle;
  return { markdown, images: names.map((name, i) => ({ name, bytes: mediaBytes[i]! })), ...(title ? { title } : {}) };
}

// ---- MHTML --------------------------------------------------------------------------------------

interface MimePart {
  headers: Record<string, string>;
  body: Uint8Array;
}

function decodeQuotedPrintable(s: string): Uint8Array {
  const out: number[] = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '=' && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else { const code = t.charCodeAt(i); if (code < 128) out.push(code); else out.push(...new TextEncoder().encode(c)); }
  }
  return new Uint8Array(out);
}

function base64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseHeaders(block: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

/** Splits a MIME `multipart/related` message (an `.mht` file) into its decoded parts. */
export function parseMhtml(text: string): MimePart[] {
  const split = /\r?\n\r?\n/.exec(text);
  if (!split) throw new Error('This is not a web archive (.mht): it has no MIME headers.');
  const top = parseHeaders(text.slice(0, split.index));
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(top['content-type'] ?? '')?.[1];
  if (!boundary) throw new Error('This is not a web archive (.mht): there is no multipart boundary.');
  const parts: MimePart[] = [];
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith('--')) break;
    const s = /\r?\n\r?\n/.exec(chunk);
    if (!s) continue;
    const headers = parseHeaders(chunk.slice(0, s.index).replace(/^\r?\n/, ''));
    const raw = chunk.slice(s.index + s[0].length).replace(/\r?\n$/, '');
    const te = (headers['content-transfer-encoding'] ?? '').toLowerCase();
    const body = te === 'base64' ? base64(raw) : te === 'quoted-printable' ? decodeQuotedPrintable(raw) : new TextEncoder().encode(raw);
    parts.push({ headers, body });
  }
  return parts;
}

const charsetOf = (ct: string | undefined) => /charset="?([\w-]+)"?/i.exec(ct ?? '')?.[1] ?? 'utf-8';
const decodeAs = (b: Uint8Array, charset: string) => { try { return new TextDecoder(charset).decode(b); } catch { return dec.decode(b); } };

/** HTML (from an .mht or a saved page) as Markdown with its pictures, title from `<title>`. */
export function htmlPageToNote(html: string, resolve: (src: string) => { name: string; bytes: Uint8Array } | null): { title?: string; markdown: string; images: ImportedAttachment[] } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim() || undefined;
  const found: { src: string; name: string; bytes: Uint8Array }[] = [];
  const md0 = htmlToMarkdown(html, {
    image: (src) => {
      const known = found.find((f) => f.src === src);
      if (known) return `@img:${found.indexOf(known)}`;
      const r = resolve(src);
      if (!r) return null;
      found.push({ src, ...r });
      return `@img:${found.length - 1}`;
    },
  });
  const names = uniqueNames(found.map((f) => f.name));
  let markdown = md0;
  found.forEach((_, i) => { markdown = markdown.split(`<@img:${i}>`).join(`<${names[i]}>`); });
  return { ...(title ? { title } : {}), markdown, images: found.map((f, i) => ({ name: names[i]!, bytes: f.bytes })) };
}

/** An `.mht` export as one note (its HTML part, with pictures from the other parts). */
export function mhtmlToNote(text: string): { title?: string; markdown: string; images: ImportedAttachment[] } {
  const parts = parseMhtml(text);
  const htmlPart = parts.find((p) => /text\/html/i.test(p.headers['content-type'] ?? ''));
  if (!htmlPart) throw new Error('This web archive has no HTML page in it.');
  const html = decodeAs(htmlPart.body, charsetOf(htmlPart.headers['content-type']));
  const byLocation = new Map<string, MimePart>();
  for (const p of parts) {
    const loc = p.headers['content-location'];
    if (loc) { byLocation.set(loc, p); byLocation.set(loc.split('/').pop()!, p); }
    const cid = p.headers['content-id']?.replace(/^<|>$/g, '');
    if (cid) byLocation.set(`cid:${cid}`, p);
  }
  return htmlPageToNote(html, (src) => {
    const p = byLocation.get(src) ?? byLocation.get(src.split('/').pop() ?? '');
    if (!p || !/^image\//i.test(p.headers['content-type'] ?? '')) return null;
    const ext = (p.headers['content-type'] ?? '').split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'bin';
    const base = (src.split('/').pop() ?? 'image').replace(/[?#].*$/, '');
    return { name: /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`, bytes: p.body };
  });
}

export interface OneNoteFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * OneNote exports as notes: `.docx`, `.mht`/`.mhtml` and `.html` files (with their `_files`
 * folders); a folder's name becomes the notebook (OneNote exports a section as one file named
 * after it, so a section file's pages land in one note). `unzip` reads a `.docx`.
 */
export function oneNoteToNotes(files: readonly OneNoteFile[], unzip: (bytes: Uint8Array) => DocxEntry[], notebook = 'OneNote'): { items: ImportedNote[]; warnings: string[] } {
  const items: ImportedNote[] = [];
  const warnings: string[] = [];
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  for (const f of files) {
    const name = f.path.split('/').pop()!;
    const base = name.replace(/\.[^.]+$/, '');
    try {
      if (/\.docx$/i.test(name)) {
        const r = docxToMarkdown(unzip(f.bytes));
        items.push({ folder: notebook, title: r.title || base, body: r.markdown, attachments: r.images });
      } else if (/\.mht(ml)?$/i.test(name)) {
        const r = mhtmlToNote(dec.decode(f.bytes));
        items.push({ folder: notebook, title: base || r.title || 'OneNote page', body: r.markdown, attachments: r.images });
      } else if (/\.html?$/i.test(name)) {
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
        const r = htmlPageToNote(decodeAs(f.bytes, charsetOf(/<meta[^>]+charset="?([\w-]+)/i.exec(dec.decode(f.bytes.subarray(0, 2048)))?.[0])), (src) => {
          if (/^[a-z]+:/i.test(src)) return null;
          const hit = byPath.get(`${dir}${decodeURIComponent(src)}`.toLowerCase());
          return hit ? { name: hit.path.split('/').pop()!, bytes: hit.bytes } : null;
        });
        items.push({ folder: notebook, title: r.title || base, body: r.markdown, attachments: r.images });
      } else if (/\.(one|onepkg|onetoc2)$/i.test(name)) {
        warnings.push(`${name}: OneNote’s own files can’t be read. In OneNote for Windows use File › Export and choose Word Document or Single File Web Page; on a Mac or the web, export or print to PDF.`);
      }
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { items, warnings };
}
