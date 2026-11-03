/**
 * Picked files → the Markdown vault the Obsidian importer lays out (docs/IMPORTERS.md). The pure
 * converters are in @inkwright/core (importers/); this adds what needs the browser: unzipping,
 * and reading and splitting PDFs (pdf.js for the outline, pdf-lib to cut sections).
 */
import {
  enexToNotes, forMarkdownImport, notesToVaultFiles, notionToVaultFiles, oneNoteToNotes, pdfNotebookApp, planPdfSections,
  type ImportedNote, type PdfOutlineItem, type VaultFile,
} from '@inkwright/core';

export type ImporterKind = 'notion' | 'evernote' | 'onenote' | 'pdf-notebook';

export interface Converted {
  files: VaultFile[];
  notes: number;
  warnings: string[];
}

const bytesOf = async (f: File) => new Uint8Array(await f.arrayBuffer());
const isZip = (name: string) => /\.zip$/i.test(name);

/** Every file inside zips (and zips inside zips, as Notion's large exports are), with paths. */
export async function expandZips(files: readonly File[]): Promise<VaultFile[]> {
  const { readZip } = await import('@inkwright/sync');
  const out: VaultFile[] = [];
  const add = async (path: string, bytes: Uint8Array, mtime?: number, depth = 0) => {
    if (isZip(path) && depth < 2) {
      for (const e of await readZip(bytes)) await add(e.path, e.bytes, e.mtime, depth + 1);
    } else out.push({ path, bytes, ...(mtime ? { mtime } : {}) });
  };
  for (const f of files) await add((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, await bytesOf(f), f.lastModified || undefined);
  return out;
}

async function notion(files: readonly File[]): Promise<Converted> {
  const r = notionToVaultFiles(await expandZips(files));
  return { files: forMarkdownImport(r.files.map((f) => ({ ...f, path: `Notion/${f.path}` }))), notes: r.notes, warnings: r.warnings };
}

async function evernote(files: readonly File[]): Promise<Converted> {
  const items: ImportedNote[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    if (!/\.enex$/i.test(f.name)) { warnings.push(`${f.name} is not an Evernote export (.enex); skipped.`); continue; }
    const r = enexToNotes(f.name, new TextDecoder().decode(await bytesOf(f)));
    items.push(...r.items);
    warnings.push(...r.warnings);
  }
  return { files: forMarkdownImport(notesToVaultFiles(items.map((n) => ({ ...n, folder: `Evernote/${n.folder}` })))), notes: items.length, warnings };
}

async function onenote(files: readonly File[]): Promise<Converted> {
  const { readZip } = await import('@inkwright/sync');
  const all = await expandZips(files.filter((f) => !/\.docx$/i.test(f.name)));
  for (const f of files.filter((x) => /\.docx$/i.test(x.name))) all.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, bytes: await bytesOf(f) });
  // .docx files are zips themselves: read them inside the converter (readZip is async, so first).
  const unzipped = new Map<Uint8Array, { path: string; bytes: Uint8Array }[]>();
  for (const f of all) if (/\.docx$/i.test(f.path)) unzipped.set(f.bytes, (await readZip(f.bytes)).map((e) => ({ path: e.path, bytes: e.bytes })));
  const pdfs = all.filter((f) => /\.pdf$/i.test(f.path));
  const { items, warnings } = oneNoteToNotes(all.filter((f) => !/\.pdf$/i.test(f.path)), (b) => unzipped.get(b) ?? [], 'OneNote');
  const out: Converted = { files: notesToVaultFiles(items), notes: items.length, warnings };
  if (pdfs.length) {
    const p = await pdfNotebook(pdfs.map((x) => new File([x.bytes as BlobPart], x.path.split('/').pop()!, { type: 'application/pdf' })), 'OneNote');
    out.files.push(...p.files.map((f) => ({ ...f, path: f.path.replace(/^import\//, '') })));
    out.notes += p.notes;
    out.warnings.push(...p.warnings);
  }
  out.files = forMarkdownImport(out.files);
  return out;
}

/** Reads a PDF's outline (bookmarks) as top-level entries with 0-based pages, and its metadata. */
async function pdfOutline(bytes: Uint8Array): Promise<{ pages: number; outline: PdfOutlineItem[]; meta: { producer?: string; creator?: string; title?: string } }> {
  const { loadPdfJs } = await import('../canvas/assets.ts');
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const info = ((await doc.getMetadata().catch(() => null))?.info ?? {}) as { Producer?: string; Creator?: string; Title?: string };
    const raw = ((await doc.getOutline().catch(() => null)) ?? []) as Array<{ title: string; dest: unknown }>;
    const outline: PdfOutlineItem[] = [];
    for (const o of raw) {
      let page: number | null = null;
      try {
        const dest = typeof o.dest === 'string' ? await doc.getDestination(o.dest) : o.dest;
        if (Array.isArray(dest) && dest[0]) page = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
      } catch {
        page = null;
      }
      outline.push({ title: String(o.title ?? ''), page });
    }
    return { pages: doc.numPages, outline, meta: { producer: info.Producer, creator: info.Creator, title: info.Title } };
  } finally {
    await (task.destroy?.() ?? doc.destroy?.());
  }
}

/**
 * GoodNotes / Notability (and any notebook app's) PDF exports: one note per top-level outline
 * section (or one per file), each with its pages as annotatable PDF pages.
 */
async function pdfNotebook(files: readonly File[], folder = 'PDF notebooks'): Promise<Converted> {
  const { PDFDocument } = await import('pdf-lib');
  const items: ImportedNote[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) { warnings.push(`${f.name} is not a PDF; skipped.`); continue; }
    const bytes = await bytesOf(f);
    const base = f.name.replace(/\.pdf$/i, '');
    let info;
    try {
      info = await pdfOutline(bytes);
    } catch (e) {
      warnings.push(`${f.name}: ${(e as Error).message}`);
      continue;
    }
    const app = pdfNotebookApp(info.meta);
    const sections = planPdfSections(info.meta.title?.trim() || base, info.pages, info.outline);
    const tags = app ? [app] : [];
    if (sections.length <= 1) {
      items.push({ folder, title: sections[0]?.title ?? base, body: `![](<${base}.pdf>)`, tags, attachments: [{ name: `${base}.pdf`, bytes }] });
      continue;
    }
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    for (const s of sections) {
      const part = await PDFDocument.create();
      const pages = await part.copyPages(src, Array.from({ length: s.to - s.from + 1 }, (_, i) => s.from + i));
      for (const p of pages) part.addPage(p);
      const name = `${s.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'Section'}.pdf`;
      items.push({ folder: `${folder}/${base}`, title: s.title, body: `![](<${name}>)`, tags, attachments: [{ name, bytes: await part.save() }] });
    }
  }
  return { files: forMarkdownImport(notesToVaultFiles(items)), notes: items.length, warnings };
}

export async function convert(kind: ImporterKind, files: readonly File[]): Promise<Converted> {
  if (kind === 'notion') return notion(files);
  if (kind === 'evernote') return evernote(files);
  if (kind === 'onenote') return onenote(files);
  return pdfNotebook(files);
}
