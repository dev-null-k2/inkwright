/**
 * Obsidian interop: the vault as an Obsidian-compatible Markdown vault, and an Obsidian (or any
 * Markdown) vault as Inkstone notes. The mapping is documented in docs/OBSIDIAN.md.
 *
 * Export: one `.md` per note in a folder per notebook, YAML properties (tags, created, updated,
 * aliases, inkstone-id, anything imported), `[[links]]` kept (rewritten to file names where a
 * title can't be a file name), typed text and recognized handwriting as text, each page with ink
 * as a picture in `attachments/`, imported PDFs and recordings copied and embedded.
 *
 * Import: every `.md` becomes a typed-text note (folders → notebooks, properties → tags/dates/
 * properties, `#tags` → tags), `[[links]]` kept, Markdown links to notes turned into `[[links]]`,
 * embedded images placed on the pages, embedded PDFs turned into annotatable pages.
 */
import { exportPageSvg, pageText, wrapText } from './export.ts';
import { newId as defaultNewId } from './ids.ts';
import { formatWikiLink, liveInkLinks, normalizeTitle, parseTags, parseWikiLinks, parseWikiTarget, resolveWikiTarget } from './links.ts';
import { VAULT_FORMAT_VERSION, newPage, type ImageItem, type NoteMeta, type NotebookMeta, type PageInk, type PageSize, type PaperSpec, type TextBox } from './model.ts';
import type { Vault } from './vault.ts';
import { emitYaml, splitFrontmatter, type YamlValue } from './yaml.ts';

export interface VaultFile {
  /** POSIX path inside the exported/imported vault. */
  path: string;
  bytes: Uint8Array;
  mtime?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Characters Obsidian refuses in file names (and that break links). */
const FORBIDDEN = /[\\/:*?"<>|#^[\]\u0000-\u001f]/g;

/** A title as a file/folder name Obsidian accepts on every OS. */
export function obsidianFileName(title: string): string {
  const s = title
    .replace(/:/g, ' -')
    .replace(/[\\/]/g, '-')
    .replace(FORBIDDEN, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim();
  return s || 'Untitled';
}

/** Makes names unique (case-insensitively, like macOS/Windows file systems) by adding " 2", " 3"… */
class NameSet {
  private used = new Set<string>();
  take(name: string, ext = ''): string {
    let candidate = name;
    for (let k = 2; this.used.has((candidate + ext).toLowerCase()); k++) candidate = `${name} ${k}`;
    this.used.add((candidate + ext).toLowerCase());
    return candidate;
  }
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Keys Inkstone writes itself; imported `properties` never override them. */
const MANAGED = new Set(['tags', 'created', 'updated', 'aliases', 'inkstone-id', 'summary']);

const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

export interface ObsidianExportOptions {
  /**
   * The picture of a page. The app renders PNGs (with PDF backgrounds); the default is the page's
   * SVG, which needs no canvas (Node, tests, the MCP server).
   */
  pageImage?: (note: NoteMeta, pages: readonly PageInk[], index: number) => Promise<{ ext: string; bytes: Uint8Array } | null>;
  /** Attachments folder (default `attachments`). */
  attachments?: string;
  /** Called after each note, for progress. */
  onProgress?: (done: number, total: number) => void;
}

/** Whether a page has anything only a picture can show (ink, images, a PDF or image page). */
export function pageNeedsImage(p: PageInk): boolean {
  return p.strokes.length > 0 || (p.images?.length ?? 0) > 0 || !!p.background;
}

/** Writes the whole vault as Obsidian files (Markdown + attachments). */
export async function exportObsidianVault(vault: Vault, opts: ObsidianExportOptions = {}): Promise<VaultFile[]> {
  const att = (opts.attachments ?? 'attachments').replace(/^\/+|\/+$/g, '');
  const notes = await vault.listNotes();
  const notebooks = await vault.listNotebooks();
  const files: VaultFile[] = [];

  // Folders for notebooks (nested), unique among siblings.
  const folder = new Map<string, string>();
  const siblingNames = new Map<string, NameSet>();
  const folderOf = (id: string | undefined, seen = new Set<string>()): string => {
    if (!id) return '';
    const cached = folder.get(id);
    if (cached != null) return cached;
    const nb = notebooks.find((n) => n.id === id);
    if (!nb || seen.has(id)) return '';
    seen.add(id);
    const parent = nb.parentId && notebooks.some((n) => n.id === nb.parentId) ? folderOf(nb.parentId, seen) : '';
    let set = siblingNames.get(parent);
    if (!set) siblingNames.set(parent, (set = new NameSet()));
    const path = (parent ? parent + '/' : '') + set.take(obsidianFileName(nb.name));
    folder.set(id, path);
    return path;
  };
  for (const nb of notebooks) folderOf(nb.id);

  // File names: unique across the vault so `[[name]]` is never ambiguous in Obsidian.
  const names = new NameSet();
  names.take(att);
  const fileName = new Map<string, string>();
  for (const n of [...notes].sort((a, b) => a.createdAt - b.createdAt)) fileName.set(n.id, names.take(obsidianFileName(n.title || 'Untitled'), '.md'));
  const attNames = new NameSet();

  const linkFor = (target: string, alias: string | undefined, from: NoteMeta): string | null => {
    const r = resolveWikiTarget(target, notes, { from, notebooks });
    if (!r) return null;
    const fname = fileName.get(r.note.id)!;
    const { subpath, title } = parseWikiTarget(target);
    if (!title) return null;
    const sameName = normalizeTitle(fname) === normalizeTitle(title);
    if (sameName) return null;
    return `[[${fname}${subpath ? `#${subpath}` : ''}|${alias ?? (subpath ? `${title} › ${subpath}` : title)}]]`;
  };
  const rewrite = (text: string, from: NoteMeta) => {
    const links = parseWikiLinks(text);
    if (!links.length) return text;
    let out = '';
    let at = 0;
    for (const l of links) {
      out += text.slice(at, l.start);
      out += (l.embed ? '!' : '') + (linkFor(l.target, l.alias, from) ?? l.raw.replace(/^!/, ''));
      at = l.end;
    }
    return out + text.slice(at);
  };

  let done = 0;
  for (const note of notes) {
    const pages = await vault.readPages(note);
    const fname = fileName.get(note.id)!;
    const dir = folderOf(note.notebookId);
    const props: Record<string, YamlValue> = {};
    // Tags set by hand plus #tags written in the note (Obsidian sees those inline too).
    const tagSeen = new Set<string>();
    const tags = [...note.tags, ...parseTags(pages.map(pageText).join('\n'))].map((t) => t.replace(/^#/, '').replace(/\s+/g, '-')).filter((t) => {
      const k = t.toLowerCase();
      if (!t || tagSeen.has(k)) return false;
      tagSeen.add(k);
      return true;
    });
    if (tags.length) props.tags = tags;
    props.created = iso(note.createdAt);
    props.updated = iso(note.updatedAt);
    const aliases = new Set<string>();
    const imported = note.properties ?? {};
    if (Array.isArray(imported.aliases)) for (const a of imported.aliases) if (typeof a === 'string') aliases.add(a);
    if (normalizeTitle(fname) !== normalizeTitle(note.title)) aliases.add(note.title);
    if (aliases.size) props.aliases = [...aliases];
    if (note.summary?.trim()) props.summary = note.summary.trim();
    props['inkstone-id'] = note.id;
    for (const [k, v] of Object.entries(imported)) if (!MANAGED.has(k) && !(k in props)) props[k] = v as YamlValue;

    const body: string[] = [];
    // Imported PDFs and recordings travel along as attachments.
    const pdfs = [...new Set(pages.filter((p) => p.background?.kind === 'pdf').map((p) => p.background!.asset))];
    const pdfName = new Map<string, string>();
    for (const a of pdfs) {
      const bytes = await vault.readAsset(note.id, a);
      if (!bytes) continue;
      const name = attNames.take(`${fname}${pdfs.length > 1 ? ` ${pdfs.indexOf(a) + 1}` : ''}`, '.pdf') + '.pdf';
      pdfName.set(a, name);
      files.push({ path: `${att}/${name}`, bytes, mtime: note.updatedAt });
    }
    if (pdfName.size) body.push([...pdfName.values()].map((n) => `![[${n}]]`).join('\n'), '');

    const multi = pages.length > 1;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!;
      if (multi) body.push(`## Page ${i + 1}`, '');
      const text = pageText(p);
      if (text) body.push(rewrite(text, note), '');
      const inkLinks = liveInkLinks(p);
      if (inkLinks.length) {
        const shown = inkLinks.map((l) => {
          const parts = parseWikiTarget(l.target);
          const r = l.noteId ? notes.find((n) => n.id === l.noteId) : resolveWikiTarget(l.target, notes, { from: note, notebooks })?.note;
          if (r) return `[[${fileName.get(r.id)}${parts.subpath ? `#${parts.subpath}` : ''}${normalizeTitle(fileName.get(r.id)!) !== normalizeTitle(r.title) ? `|${r.title}` : ''}]]`;
          return formatWikiLink(parts.title || l.target, { subpath: parts.subpath });
        });
        body.push(`Linked in handwriting: ${[...new Set(shown)].join(' · ')}`, '');
      }
      if (pageNeedsImage(p)) {
        let img = opts.pageImage ? await opts.pageImage(note, pages, i) : null;
        if (!img) {
          // SVG fallback: images inside the page are copied next to it so the SVG shows them.
          const local = new Map<string, string>();
          for (const im of p.images ?? []) {
            const bytes = await vault.readAsset(note.id, im.asset);
            if (!bytes) continue;
            const ext = extOf(im.asset) || 'png';
            const n = attNames.take(`${fname} - ${im.asset.replace(/\.[^.]+$/, '')}`, `.${ext}`) + `.${ext}`;
            local.set(im.asset, n);
            files.push({ path: `${att}/${n}`, bytes, mtime: note.updatedAt });
          }
          const svgPage = p.background?.kind === 'pdf' ? { ...p, background: undefined } : p;
          img = { ext: 'svg', bytes: enc.encode(exportPageSvg(note, svgPage, { assetHref: (a) => encodeURI(local.get(a) ?? a) })) };
        }
        const name = attNames.take(`${fname} - page ${i + 1}`, `.${img.ext}`) + `.${img.ext}`;
        files.push({ path: `${att}/${name}`, bytes: img.bytes, mtime: note.updatedAt });
        body.push(`![[${name}]]`, '');
      }
    }
    for (const r of note.recordings ?? []) {
      const bytes = await vault.readAsset(note.id, r.asset);
      if (!bytes) continue;
      const ext = extOf(r.asset) || 'webm';
      const name = attNames.take(`${fname} - ${r.title ? obsidianFileName(r.title) : `recording ${new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}`}`, `.${ext}`) + `.${ext}`;
      files.push({ path: `${att}/${name}`, bytes, mtime: note.updatedAt });
      body.push(`![[${name}]]`, '');
    }
    const md = `---\n${emitYaml(props)}---\n\n${body.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
    files.push({ path: `${dir ? dir + '/' : ''}${fname}.md`, bytes: enc.encode(md), mtime: note.updatedAt });
    opts.onProgress?.(++done, notes.length);
  }
  return files;
}

// ---- Import ----------------------------------------------------------------------------------

export interface ObsidianImportOptions {
  paper: PaperSpec;
  pageSize: PageSize;
  now?: number;
  /** Page sizes of a PDF, to bring embedded PDFs in as annotatable pages (app: pdf.js). */
  pdfPageSizes?: (bytes: Uint8Array) => Promise<{ width: number; height: number }[]>;
  /** Cover colours for new notebooks, used in turn. */
  notebookColors?: readonly string[];
  /** Put everything inside this notebook (folders become notebooks under it). */
  parentNotebookId?: string;
  newId?: () => string;
  onProgress?: (done: number, total: number) => void;
}

export interface ObsidianImportReport {
  /** Ids of the notes created, in path order. */
  noteIds: string[];
  notebooksCreated: number;
  attachments: number;
  /** Files that were neither notes nor used by a note. */
  skipped: string[];
}

const DEFAULT_COLORS = ['#FF3D5A80', '#FFB8432F', '#FF3D7A5A', '#FF7A3E9D', '#FFB07D1C', '#FF2F6FB5', '#FF6B5E55', '#FFB0477A'];

/** Normalizes paths and drops what Obsidian keeps for itself (`.obsidian/`, `.trash/`, dot files). */
export function vaultFilesOf(files: readonly VaultFile[]): VaultFile[] {
  const clean = files
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '') }))
    .filter((f) => f.path && !f.path.endsWith('/') && !f.path.split('/').some((s) => s.startsWith('.') || s === '__MACOSX' || s === 'node_modules'));
  // A zip of a vault folder has one top folder; it is the vault itself, not a notebook.
  const tops = new Set(clean.map((f) => (f.path.includes('/') ? f.path.split('/')[0]! : '')));
  if (tops.size === 1 && !tops.has('')) {
    const top = [...tops][0]!;
    return clean.map((f) => ({ ...f, path: f.path.slice(top.length + 1) }));
  }
  return clean;
}

/** A piece of a note body: text, or something embedded. */
export type MdBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; file: VaultFile; width?: number }
  | { kind: 'pdf'; file: VaultFile };

/**
 * Converts Obsidian Markdown to Inkstone note text and pulls embeds out as blocks: images and PDFs
 * become blocks; note embeds and links to other `.md` files become `[[links]]`.
 */
export function markdownBlocks(body: string, findFile: (ref: string) => VaultFile | null, noteExists: (ref: string) => string | null): MdBlock[] {
  const blocks: MdBlock[] = [];
  let text = '';
  const flush = () => { if (text.trim()) blocks.push({ kind: 'text', text: text.replace(/\n{3,}/g, '\n\n').trim() }); text = ''; };
  const embedRe = /!\[\[([^[\]\n]+?)\]\]|!\[([^\]\n]*)\]\(<?([^)\n>]+?)>?(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(<?([^)\n>]+?\.md(?:#[^)\n>]*)?)>?\)/g;
  let at = 0;
  for (const m of body.matchAll(embedRe)) {
    text += body.slice(at, m.index);
    at = m.index! + m[0].length;
    if (m[1] != null) {
      // ![[file|300]] / ![[Note]] / ![[Note#Heading]]
      const [ref, size] = m[1].split('|').map((s) => s.trim());
      const ext = extOf(ref!.split('#')[0]!);
      const f = ext ? findFile(ref!.split('#')[0]!) : null;
      if (f && IMAGE_EXT.has(ext)) { flush(); blocks.push({ kind: 'image', file: f, width: size && /^\d+/.test(size) ? parseInt(size, 10) : undefined }); }
      else if (f && ext === 'pdf') { flush(); blocks.push({ kind: 'pdf', file: f }); }
      else if (!ext || ext === 'md') text += `[[${ref!.replace(/\.md(?=#|$)/i, '')}]]`;
      else text += `[[${ref}]]`;
    } else if (m[3] != null) {
      // ![alt](path)
      const ref = safeDecode(m[3]);
      if (/^[a-z]+:/i.test(ref)) { text += m[0]; continue; }
      const ext = extOf(ref.split('#')[0]!);
      const f = findFile(ref);
      if (f && IMAGE_EXT.has(ext)) { flush(); blocks.push({ kind: 'image', file: f }); }
      else if (f && ext === 'pdf') { flush(); blocks.push({ kind: 'pdf', file: f }); }
      else text += m[2] ? `${m[2]}` : '';
    } else {
      // [label](Other note.md#heading) → [[Other note#heading|label]]
      const ref = safeDecode(m[5]!);
      if (/^[a-z]+:/i.test(ref)) { text += m[0]; continue; }
      const [path, sub] = ref.split('#');
      const name = noteExists(path!) ?? path!.split('/').pop()!.replace(/\.md$/i, '');
      text += `[[${name}${sub ? `#${sub}` : ''}${m[4] && normalizeTitle(m[4]) !== normalizeTitle(name) ? `|${m[4]}` : ''}]]`;
    }
  }
  text += body.slice(at);
  flush();
  return blocks;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Pixel size of a PNG, JPEG, GIF, WebP, BMP or SVG from its bytes; null when unknown. */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | null {
  const u16 = (o: number, le = false) => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
  const u32 = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32(16), height: u32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16(6, true), height: u16(8, true) };
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(new DataView(b.buffer, b.byteOffset).getInt32(18, true)), height: Math.abs(new DataView(b.buffer, b.byteOffset).getInt32(22, true)) };
  if (b.length > 30 && dec.decode(b.subarray(0, 4)) === 'RIFF' && dec.decode(b.subarray(8, 12)) === 'WEBP') {
    const kind = dec.decode(b.subarray(12, 16));
    if (kind === 'VP8 ') return { width: u16(26, true) & 0x3fff, height: u16(28, true) & 0x3fff };
    if (kind === 'VP8L') { const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16(o + 7), height: u16(o + 5) };
      o += 2 + len;
    }
    return null;
  }
  const head = dec.decode(b.subarray(0, Math.min(b.length, 2048)));
  if (/<svg[\s>]/i.test(head)) {
    const tag = /<svg[^>]*>/i.exec(head)?.[0] ?? '';
    const num = (k: string) => { const m = new RegExp(`\\s${k}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(tag); return m ? Number(m[1]) : NaN; };
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    const w = num('width'), h = num('height');
    if (w > 0 && h > 0) return { width: w, height: h };
    if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  }
  return null;
}

/** How tall a typed text box will be on the page (matches the renderer's 1.35 line height). */
function textHeight(text: string, width: number, fontSize: number): number {
  let h = 0;
  for (const line of text.split('\n')) {
    const hm = /^(#{1,6})\s+/.exec(line);
    const size = hm ? fontSize * Math.max(1.1, 1.7 - hm[1]!.length * 0.15) : fontSize;
    h += Math.max(1, wrapText(line, width, size).length) * size * 1.35;
  }
  return h * 1.06;
}

export interface LayoutContext {
  pageSize: PageSize;
  now: number;
  newId: () => string;
  fontSize?: number;
  margin?: number;
  /** Writes an embedded file into the note; returns its asset name. */
  asset: (file: VaultFile) => Promise<string>;
  pdfPageSizes?: (bytes: Uint8Array) => Promise<{ width: number; height: number }[]>;
}

/** Lays text and embeds out on pages, top to bottom, starting a new page when one is full. */
export async function layoutBlocks(blocks: readonly MdBlock[], ctx: LayoutContext): Promise<PageInk[]> {
  const fontSize = ctx.fontSize ?? 16;
  const margin = ctx.margin ?? 72;
  const W = Math.max(200, ctx.pageSize.width - margin * 2);
  const H = Math.max(200, ctx.pageSize.height - margin * 2);
  const pages: PageInk[] = [];
  let page = newPage(ctx.newId());
  let y = margin;
  const used = () => (page.texts?.length ?? 0) + (page.images?.length ?? 0) > 0;
  const nextPage = () => { pages.push(page); page = newPage(ctx.newId()); y = margin; };
  const addText = (text: string) => {
    const box: TextBox = { id: ctx.newId(), x: margin, y, width: W, text, fontSize, color: '#FF1B1F24', font: 'sans', createdAt: ctx.now };
    page.texts = [...(page.texts ?? []), box];
    y += textHeight(text, W, fontSize) + fontSize;
  };
  for (const b of blocks) {
    if (b.kind === 'text') {
      // Fill the page line by line; a paragraph that doesn't fit continues on the next page.
      let chunk: string[] = [];
      for (const line of b.text.split('\n')) {
        const h = textHeight([...chunk, line].join('\n'), W, fontSize);
        if (y + h > margin + H && (chunk.length || used())) {
          if (chunk.length) addText(chunk.join('\n'));
          nextPage();
          chunk = [];
        }
        chunk.push(line);
      }
      if (chunk.join('').trim()) addText(chunk.join('\n'));
    } else if (b.kind === 'image') {
      const dim = imageDimensions(b.file.bytes) ?? { width: 600, height: 400 };
      const want = b.width ?? dim.width;
      const k = Math.min(1, W / want, (H * 0.8) / (dim.height * (want / dim.width))) * (want / dim.width);
      const w = dim.width * k, h = dim.height * k;
      if (y + h > margin + H && used()) nextPage();
      const im: ImageItem = { id: ctx.newId(), x: margin, y, width: w, height: h, asset: await ctx.asset(b.file), rotation: 0, createdAt: ctx.now };
      page.images = [...(page.images ?? []), im];
      y += h + fontSize;
    } else if (b.kind === 'pdf' && ctx.pdfPageSizes) {
      let sizes: { width: number; height: number }[] = [];
      try { sizes = await ctx.pdfPageSizes(b.file.bytes); } catch { sizes = []; }
      const asset = await ctx.asset(b.file);
      if (!sizes.length) { addText(`[[${b.file.path.split('/').pop()}]]`); continue; }
      if (used()) nextPage();
      sizes.forEach((s, i) => {
        page.size = { name: 'PDF', width: s.width, height: s.height };
        page.background = { kind: 'pdf', asset, pageNumber: i + 1 };
        nextPage();
      });
    } else if (b.kind === 'pdf') {
      await ctx.asset(b.file);
      addText(`PDF: ${b.file.path.split('/').pop()}`);
    }
  }
  if (used() || !pages.length || page.background) pages.push(page);
  return pages;
}

const asString = (v: YamlValue | undefined): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

function dateOf(v: YamlValue | undefined): number | null {
  const s = asString(v);
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return Number.isFinite(t) ? t : null;
}

function tagsOf(v: YamlValue | undefined): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return list.map((x) => asString(x as YamlValue)?.replace(/^#/, '').trim() ?? '').filter(Boolean);
}

/** Imports Markdown files (an Obsidian vault folder or zip) as notes. */
export async function importObsidianVault(vault: Vault, input: readonly VaultFile[], opts: ObsidianImportOptions): Promise<ObsidianImportReport> {
  const files = vaultFilesOf(input);
  const now = opts.now ?? Date.now();
  const id = opts.newId ?? (() => defaultNewId(now));
  const colors = opts.notebookColors?.length ? opts.notebookColors : DEFAULT_COLORS;
  const mdFiles = files.filter((f) => /\.(md|markdown)$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const byName = new Map<string, VaultFile>();
  for (const f of files) {
    const k = f.path.split('/').pop()!.toLowerCase();
    if (!byName.has(k)) byName.set(k, f);
  }
  const noteNames = new Map<string, string>();
  for (const f of mdFiles) noteNames.set(f.path.toLowerCase().replace(/\.(md|markdown)$/i, ''), f.path.split('/').pop()!.replace(/\.(md|markdown)$/i, ''));
  const usedFiles = new Set<VaultFile>();

  // Folders → notebooks (reusing existing notebooks with the same name in the same place).
  const existing = await vault.listNotebooks();
  const nbFor = new Map<string, string | undefined>([['', opts.parentNotebookId]]);
  let created = 0;
  const notebookFor = async (dir: string): Promise<string | undefined> => {
    if (nbFor.has(dir)) return nbFor.get(dir);
    const slash = dir.lastIndexOf('/');
    const parentId = await notebookFor(slash < 0 ? '' : dir.slice(0, slash));
    const name = dir.slice(slash + 1);
    let nb: NotebookMeta | undefined = existing.find((n) => n.name.toLowerCase() === name.toLowerCase() && (n.parentId ?? undefined) === parentId);
    if (!nb) {
      nb = { id: id(), name, color: colors[(existing.length + created) % colors.length]!, parentId, createdAt: now, formatVersion: VAULT_FORMAT_VERSION };
      if (!parentId) delete nb.parentId;
      await vault.writeNotebook(nb);
      existing.push(nb);
      created++;
    }
    nbFor.set(dir, nb.id);
    return nb.id;
  };

  const noteIds: string[] = [];
  let attachments = 0;
  let done = 0;
  for (const f of mdFiles) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const title = f.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
    const { data, body } = splitFrontmatter(dec.decode(f.bytes));
    const findFile = (ref: string): VaultFile | null => {
      const clean = ref.replace(/^\.\//, '').replace(/^\/+/, '');
      const rel = dir && !clean.startsWith('/') ? `${dir}/${clean}` : clean;
      const hit = byPath.get(normalizePathish(rel).toLowerCase()) ?? byPath.get(clean.toLowerCase()) ?? byName.get(clean.split('/').pop()!.toLowerCase()) ?? null;
      if (hit) usedFiles.add(hit);
      return hit;
    };
    const noteExists = (ref: string): string | null => {
      const clean = ref.replace(/^\.\//, '').replace(/\.(md|markdown)$/i, '');
      const rel = normalizePathish(dir ? `${dir}/${clean}` : clean).toLowerCase();
      return noteNames.get(rel) ?? noteNames.get(clean.toLowerCase()) ?? null;
    };
    const blocks = markdownBlocks(body, findFile, noteExists);
    const noteId = id();
    const assetNames = new Map<VaultFile, string>();
    const pages = await layoutBlocks(blocks, {
      pageSize: opts.pageSize, now, newId: id, pdfPageSizes: opts.pdfPageSizes,
      asset: async (file) => {
        const known = assetNames.get(file);
        if (known) return known;
        const ext = extOf(file.path).replace('jpeg', 'jpg') || 'bin';
        const name = await vault.writeAsset(noteId, `${id()}.${ext}`, file.bytes);
        assetNames.set(file, name);
        attachments++;
        return name;
      },
    });
    const allText = blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n');
    const inline = parseTags(allText);
    const fmTags = tagsOf(data.tags ?? data.tag);
    const seen = new Set<string>();
    const tags = [...fmTags, ...inline].filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const createdAt = dateOf(data.created ?? data['date created'] ?? data.date) ?? f.mtime ?? now;
    const updatedAt = Math.max(createdAt, dateOf(data.updated ?? data.modified ?? data['date modified']) ?? f.mtime ?? now);
    const properties: Record<string, YamlValue> = {};
    for (const [k, v] of Object.entries(data)) if (!['tags', 'tag', 'created', 'updated', 'modified', 'inkstone-id'].includes(k)) properties[k] = v;
    const note: NoteMeta = {
      id: noteId,
      title,
      kind: 'paged',
      paper: opts.paper,
      pageSize: opts.pageSize,
      pageIds: pages.map((p) => p.id),
      notebookId: await notebookFor(dir),
      tags,
      createdAt,
      updatedAt,
      pinned: false,
      formatVersion: VAULT_FORMAT_VERSION,
    };
    if (!note.notebookId) delete note.notebookId;
    if (inline.length) note.inlineTags = inline;
    const summary = asString(data.summary);
    if (summary) note.summary = summary;
    if (Object.keys(properties).length) note.properties = properties;
    await vault.saveNote(note, pages);
    noteIds.push(noteId);
    opts.onProgress?.(++done, mdFiles.length);
  }
  const skipped = files.filter((f) => !/\.(md|markdown)$/i.test(f.path) && !usedFiles.has(f)).map((f) => f.path);
  return { noteIds, notebooksCreated: created, attachments, skipped };
}

/** Resolves `a/b/../c` style paths (no escaping above the root). */
function normalizePathish(p: string): string {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}
