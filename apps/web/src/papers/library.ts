import {
  PAPER_TAG,
  detectReferenceFormat,
  findDoi,
  formatApa,
  matchPdfs,
  newId,
  newPage,
  parseBibtex,
  parseCslJson,
  referenceFromProperties,
  referenceProperties,
  sameWork,
  uniqueKey,
  type NoteMeta,
  type PageInk,
  type Reference,
  type TextBox,
} from '@inkstone/core';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { inspectPdf, loadPdfJs } from '../canvas/assets.ts';
import { noteChanged } from '../lib/actions.ts';

/**
 * The library of papers: each reference is a note in the "Papers" notebook, tagged `paper`, with
 * the reference in its front matter (`NoteMeta.properties`: citekey, authors, year, DOI… and the
 * full CSL item) and a first page showing the formatted reference and abstract. PDFs dropped
 * later are matched to their papers (DOI, citation key, author–year–title) and attached as
 * annotatable pages. Import is from files (BibTeX, CSL-JSON — Zotero's own exports): Zotero's
 * local API refuses requests from web pages by design, so the app does not use it.
 */

export const PAPERS_NOTEBOOK = 'Papers';

export interface PaperRef { ref: Reference; noteId: string }

/** References of every paper note in the library (from the loaded note list; no file reads). */
export function libraryReferences(notes: readonly NoteMeta[] = useApp.getState().notes): PaperRef[] {
  const out: PaperRef[] = [];
  for (const n of notes) {
    if (n.trashedAt || !n.properties?.citekey) continue;
    const ref = referenceFromProperties(n.properties);
    if (ref) out.push({ ref, noteId: n.id });
  }
  return out;
}

export function findReference(key: string, notes?: readonly NoteMeta[]): PaperRef | undefined {
  return libraryReferences(notes).find((r) => r.ref.id === key);
}

/** Parses an export file (format detected from the text). */
export function parseReferences(text: string): { references: Reference[]; errors: { line: number; message: string }[] } {
  const fmt = detectReferenceFormat(text);
  if (fmt === 'csl-json') return parseCslJson(text);
  if (fmt === 'bibtex') return parseBibtex(text);
  return { references: [], errors: [{ line: 1, message: 'Not a BibTeX or CSL-JSON file' }] };
}

async function papersNotebook(): Promise<string> {
  const v = useApp.getState().vault!;
  const existing = (await v.vault.listNotebooks()).find((nb) => nb.name === PAPERS_NOTEBOOK && !nb.parentId);
  if (existing) return existing.id;
  return (await v.vault.createNotebook(PAPERS_NOTEBOOK, '#FF2F5E5A')).id;
}

/** The first page of a paper note: the reference, how to cite it, and the abstract. */
export function paperPageText(r: Reference): string {
  const lines = [`# ${r.title ?? r.id}`, '', formatApa(r).markdown, '', `Cite as [@${r.id}]`];
  if (r.abstract) lines.push('', '## Abstract', r.abstract);
  if (r.keywords?.length) lines.push('', r.keywords.map((k) => `#${k.replace(/\s+/g, '-').toLowerCase()}`).join(' '));
  return lines.join('\n');
}

export interface ImportReport { added: number; updated: number; skipped: number; errors: { line: number; message: string }[] }

/**
 * Imports references as paper notes. A reference whose work is already in the library (same DOI,
 * or same title and year) updates that note's metadata instead of duplicating it; a new one
 * whose key is taken by a different work gets a suffixed key (smith2020 → smith2020a).
 */
export async function importReferences(text: string): Promise<ImportReport> {
  const app = useApp.getState();
  const v = app.vault;
  if (!v) throw new Error('The vault is not open');
  const { references, errors } = parseReferences(text);
  const lib = libraryReferences();
  const keys = new Set(lib.map((r) => r.ref.id));
  const nb = references.length ? await papersNotebook() : '';
  const s = useSettings.getState();
  let added = 0, updated = 0, skipped = 0;
  for (const raw of references) {
    const same = lib.find((x) => sameWork(x.ref, raw) || (x.ref.id === raw.id && (x.ref.title ?? '') === (raw.title ?? '')));
    if (same) {
      const merged: Reference = { ...same.ref, ...raw, id: same.ref.id };
      if (JSON.stringify(merged) === JSON.stringify(same.ref)) { skipped++; continue; }
      await v.vault.updateNote(same.noteId, (m) => ({ ...m, title: merged.title ?? m.title, properties: { ...m.properties, ...referenceProperties(merged) } }));
      updated++;
      continue;
    }
    const ref = { ...raw, id: uniqueKey(raw.id, keys) };
    keys.add(ref.id);
    const { note, pages } = await v.vault.createNote({ title: ref.title ?? ref.id, paper: { ...s.defaultPaper, style: 'blank' }, pageSize: s.defaultPageSize, notebookId: nb, tags: [PAPER_TAG] });
    const width = (note.pageSize.width || 794) - 128;
    const box: TextBox = { id: newId(), x: 64, y: 72, width, text: paperPageText(ref), fontSize: 15, color: '#FF1B1F24', font: 'serif', createdAt: Date.now(), origin: 'import' };
    const page: PageInk = { ...pages[0]!, texts: [box] };
    await v.vault.saveNote({ ...note, properties: referenceProperties(ref) }, [page]);
    lib.push({ ref, noteId: note.id });
    added++;
  }
  await app.refresh();
  if (v) await v.buildIndex();
  return { added, updated, skipped, errors };
}

/** Reads the DOI printed on a PDF's first page (pdf.js text layer), if any. */
async function doiInPdf(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const pdfjs = await loadPdfJs();
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    const text = (tc.items as { str?: string }[]).map((i) => i.str ?? '').join(' ');
    await (task.destroy?.() ?? doc.destroy?.());
    return findDoi(text);
  } catch {
    return undefined;
  }
}

export interface AttachReport { attached: { file: string; title: string; reason: string }[]; unmatched: string[] }

/** Matches dropped PDFs to papers and appends each as annotatable pages of its paper note. */
export async function attachPdfs(files: File[]): Promise<AttachReport> {
  const v = useApp.getState().vault!;
  const lib = libraryReferences();
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const bytes = new Map<string, Uint8Array>();
  const candidates = [];
  for (const f of pdfs) {
    const b = new Uint8Array(await f.arrayBuffer());
    bytes.set(f.name, b);
    candidates.push({ name: f.name, doiInText: await doiInPdf(b) });
  }
  const matches = matchPdfs(candidates, lib.map((x) => x.ref));
  const report: AttachReport = { attached: [], unmatched: pdfs.map((f) => f.name).filter((n) => !matches.some((m) => m.file === n)) };
  for (const m of matches) {
    const target = lib.find((x) => x.ref.id === m.refId)!;
    const meta = await v.vault.readNote(target.noteId);
    if (!meta) continue;
    const b = bytes.get(m.file)!;
    const info = await inspectPdf(b);
    const asset = v.newAssetName('pdf');
    await v.vault.writeAsset(meta.id, asset, b);
    const pages = await v.vault.readPages(meta);
    const added: PageInk[] = info.sizes.map((size, i) => ({ ...newPage(newId()), size: { name: 'PDF', width: size.width, height: size.height }, background: { kind: 'pdf', asset, pageNumber: i + 1 } }));
    await v.vault.saveNote({ ...meta, pageIds: [...meta.pageIds, ...added.map((p) => p.id)], properties: { ...meta.properties, pdf: asset } }, [...pages, ...added], { changedPageIds: added.map((p) => p.id) });
    await noteChanged(meta.id);
    report.attached.push({ file: m.file, title: target.ref.title ?? target.ref.id, reason: m.reason === 'doi' ? 'DOI' : m.reason === 'key' ? 'citation key' : 'title' });
  }
  return report;
}
