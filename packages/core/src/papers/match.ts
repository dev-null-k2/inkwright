import { familyName, normalizeDoi, type Reference } from './model.ts';

/**
 * Matching PDFs from a dropped folder to references, the way people's files are actually named:
 *
 * 1. **DOI** — in the file name (DOIs contain "/", so files use `_`, `%2F` or `-` instead) or in
 *    the PDF's own text (`doiInText`, read by the app from the first page);
 * 2. **citation key** — `smith2020.pdf`, `smith2020 - Title.pdf` (Better BibTeX's default);
 * 3. **author–year–title** — Zotero's default "Smith - 2020 - Title of the paper.pdf" and similar:
 *    most title words present, plus the year or the first author's family name.
 *
 * Each file goes to at most one reference and each reference gets at most one file; the strongest
 * evidence wins, and ties are left unmatched rather than guessed.
 */

export interface PdfCandidate {
  name: string;
  /** DOI found in the PDF's text, when the app could read it. */
  doiInText?: string;
}

export interface PdfMatch {
  file: string;
  refId: string;
  reason: 'doi' | 'key' | 'title';
  score: number;
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'are', 'its', 'via', 'using', 'towards', 'toward', 'pdf']);

function doiFromName(name: string): string | undefined {
  const base = name.replace(/\.pdf$/i, '');
  for (const variant of [base, base.replace(/%2f/gi, '/'), base.replace(/_/g, '/'), base.replace(/^(10\.\d{4,9})[-_ ]/, '$1/')]) {
    const d = normalizeDoi(variant);
    if (d) return d;
  }
  return undefined;
}

function score(c: PdfCandidate, r: Reference): { reason: PdfMatch['reason']; score: number } | null {
  const base = c.name.replace(/\.pdf$/i, '');
  if (r.doi) {
    const docDoi = normalizeDoi(c.doiInText);
    if (docDoi && docDoi === r.doi) return { reason: 'doi', score: 1 };
    const fileDoi = doiFromName(c.name);
    // A DOI with "/" replaced by "_" can't be told apart from a real "_" in the DOI; compare both ways.
    if (fileDoi && (fileDoi === r.doi || fileDoi.replace(/\//g, '_') === r.doi.replace(/\//g, '_'))) return { reason: 'doi', score: 1 };
  }
  const head = base.split(/\s+[-–—]\s+|\s*[|]\s*/)[0]!.trim().toLowerCase();
  if (head === r.id.toLowerCase() || base.toLowerCase() === r.id.toLowerCase()) return { reason: 'key', score: 0.95 };
  const tw = words(r.title ?? '').filter((w) => !STOP.has(w));
  if (!tw.length) return null;
  const fw = new Set(words(base));
  const hit = tw.filter((w) => fw.has(w)).length / tw.length;
  const year = r.issued?.year != null && fw.has(String(r.issued.year));
  const author = !!r.author?.[0] && words(familyName(r.author[0])).some((w) => fw.has(w));
  // Zotero shortens long titles in file names: most of the first words must be there.
  const prefix = tw.slice(0, Math.min(6, tw.length));
  const prefixHit = prefix.filter((w) => fw.has(w)).length / prefix.length;
  const s = Math.max(hit, prefixHit * 0.95);
  // A one-word title is weak evidence on its own: it needs both the year and the author.
  if (s >= 0.8 && (tw.length > 1 ? year || author : year && author)) return { reason: 'title', score: 0.5 + 0.3 * s + (year ? 0.05 : 0) + (author ? 0.05 : 0) };
  return null;
}

/** Assigns files to references (best evidence first; ambiguous ties are skipped). */
export function matchPdfs(files: readonly PdfCandidate[], refs: readonly Reference[]): PdfMatch[] {
  const all: PdfMatch[] = [];
  for (const f of files) for (const r of refs) {
    const s = score(f, r);
    if (s) all.push({ file: f.name, refId: r.id, ...s });
  }
  all.sort((a, b) => b.score - a.score);
  const usedFiles = new Set<string>();
  const usedRefs = new Set<string>();
  const out: PdfMatch[] = [];
  for (const m of all) {
    if (usedFiles.has(m.file) || usedRefs.has(m.refId)) continue;
    // Another reference scores the same for this file: don't guess.
    const tie = all.some((o) => o !== m && o.file === m.file && o.score === m.score && !usedRefs.has(o.refId));
    if (tie && m.reason !== 'doi') continue;
    usedFiles.add(m.file);
    usedRefs.add(m.refId);
    out.push(m);
  }
  return out;
}

/** The first DOI in a block of text (a PDF's first page), if any. */
export function findDoi(text: string): string | undefined {
  const m = /\b(?:doi\s*[:=]?\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"<>]+)/i.exec(text);
  return m ? normalizeDoi(m[1]) : undefined;
}
