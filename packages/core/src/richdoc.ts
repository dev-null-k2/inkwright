/**
 * Documents: typed, formatted notes (headings, lists, tables, images…) that can also carry ink.
 *
 * Storage (docs/VAULT_FORMAT.md › Documents). A document is an ordinary paged note with
 * `NoteMeta.document` set. Its body is one text box on the first page with `role: "document"`,
 * whose `text` is GitHub-flavoured Markdown plus a few HTML tags for what Markdown has no syntax
 * for (`<u>` underline, `<div class="page-break"></div>`). Keeping the body in a text box means
 * everything that already understands typed text — search, `note.md`, agents' `read_note`, the
 * MCP server, Obsidian export, version history, sync — works on documents unchanged; strokes on
 * the same page are ink annotations, positioned in the document's layout (`DocumentInfo.width`
 * CSS px wide).
 *
 * This module is pure: block splitting, the three-way merge sync uses for concurrent edits,
 * outline and word count, and the edits the assistant can make.
 */
import type { NoteMeta, PageInk, TextBox } from './model.ts';

/** Layout of a document note (`NoteMeta.document`). */
export interface DocumentInfo {
  /**
   * Width in CSS px of the column ink annotations were written against. Wider screens show the
   * document at this width; narrower ones scale it while annotations are shown, so ink stays on
   * the words it marks.
   */
  width: number;
}

/** The text box role that marks a document's body. */
export const DOCUMENT_ROLE = 'document';

/** Default layout width: the Razr Fold's inner screen, and a comfortable reading measure. */
export const DOCUMENT_WIDTH = 720;

/** A page size that gives library thumbnails the proportions of a printed A4 page. */
export const DOCUMENT_PAGE_SIZE = { name: 'Document', width: DOCUMENT_WIDTH, height: Math.round(DOCUMENT_WIDTH * Math.SQRT2) } as const;

/** How a manual page break is written in a document's Markdown. */
export const PAGE_BREAK_MARKDOWN = '<div class="page-break"></div>';

export function isDocumentNote(meta: Pick<NoteMeta, 'document'> | null | undefined): boolean {
  return !!meta?.document;
}

/** The body text box of a document page, if it has one. */
export function documentBody(page: Pick<PageInk, 'texts'> | null | undefined): TextBox | undefined {
  return page?.texts?.find((t) => t.role === DOCUMENT_ROLE);
}

// ---- Blocks ------------------------------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Splits Markdown into top-level blocks separated by blank lines. A fenced code block is one
 * block even when it contains blank lines. Block text is kept exactly (no trimming inside).
 */
export function splitBlocks(md: string): string[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (cur.length) out.push(cur.join('\n'));
    cur = [];
  };
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) {
      cur.push(line);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      cur.push(line);
      continue;
    }
    if (!line.trim()) flush();
    else cur.push(line);
  }
  flush();
  return out;
}

export const joinBlocks = (blocks: readonly string[]): string => blocks.join('\n\n');

// ---- Three-way merge ---------------------------------------------------------------------------

/** For each index of `a`, the index of the matching item of `b` in a longest common subsequence. */
function lcsMatch(a: readonly string[], b: readonly string[]): Int32Array {
  const n = a.length, m = b.length;
  const match = new Int32Array(n).fill(-1);
  // Common prefix and suffix first: most edits touch a few blocks of a long document.
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) { match[lo] = lo; lo++; }
  let hiA = n, hiB = m;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; match[hiA] = hiB; }
  const rows = hiA - lo, cols = hiB - lo;
  if (!rows || !cols) return match;
  const w = cols + 1;
  const dp = new Int32Array((rows + 1) * w);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i * w + j] = a[lo + i] === b[lo + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0, j = 0;
  while (i < rows && j < cols) {
    if (a[lo + i] === b[lo + j]) { match[lo + i] = lo + j; i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return match;
}

/**
 * One side's edit of `base` as an edit script: which base items it kept, and what it inserted
 * before each base position (`n` = at the end). A changed item is "removed, and something inserted
 * where it was".
 */
function editScript(base: readonly string[], side: readonly string[]): { kept: boolean[]; ins: string[][] } {
  const m = lcsMatch(base, side);
  const kept = Array.from(m, (x) => x >= 0);
  const ins: string[][] = Array.from({ length: base.length + 1 }, () => []);
  let last = -1;
  for (let s = 0; s < base.length; s++) {
    if (m[s]! < 0) continue;
    ins[s] = side.slice(last + 1, m[s]);
    last = m[s]!;
  }
  ins[base.length] = side.slice(last + 1);
  return { kept, ins };
}

/**
 * Three-way merge of sequences by combining both sides' edit scripts against the base: an item
 * stays only if neither side removed it; insertions from both sides land where they were made
 * (the same insertion once; different ones `a`'s first). A paragraph changed on both sides, in
 * different ways, is therefore kept in both versions, so no one's writing is lost; changes to
 * neighbouring paragraphs never conflict.
 */
export function mergeSequences(base: readonly string[], a: readonly string[], b: readonly string[]): string[] {
  const ea = editScript(base, a);
  const eb = editScript(base, b);
  const out: string[] = [];
  for (let s = 0; s <= base.length; s++) {
    const x = ea.ins[s]!, y = eb.ins[s]!;
    out.push(...x);
    for (const item of y) if (!x.includes(item)) out.push(item);
    if (s < base.length && ea.kept[s] && eb.kept[s]) out.push(base[s]!);
  }
  return out;
}

/**
 * Merges two edits of a document's Markdown against the version both started from (`base`;
 * null when unknown, which keeps everything from both sides). Works block by block, so edits to
 * different paragraphs on two devices both survive.
 */
export function mergeDocumentMarkdown(base: string | null, local: string, remote: string): string {
  if (local === remote) return local;
  if (base != null && local === base) return remote;
  if (base != null && remote === base) return local;
  return joinBlocks(mergeSequences(base == null ? [] : splitBlocks(base), splitBlocks(local), splitBlocks(remote)));
}

// ---- Reading -----------------------------------------------------------------------------------

export interface OutlineEntry {
  level: number;
  text: string;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Plain text of a line of inline Markdown (marks, links, inline HTML and escapes removed). */
export function inlinePlain(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|~~|\*|_|`)/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')
    .trim();
}

/** Headings in order, outside code blocks. */
export function documentOutline(md: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let fence: string | null = null;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(line);
    if (fence) { if (f && line.trim().startsWith(fence)) fence = null; continue; }
    if (f) { fence = f[1]!; continue; }
    const h = HEADING.exec(line);
    if (h) out.push({ level: h[1]!.length, text: inlinePlain(h[2]!) });
  }
  return out;
}

/** Words in a document: letters or digits separated by space, ignoring Markdown and HTML syntax. */
export function documentWords(md: string): number {
  const text = md
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/^\s*(```|~~~).*$/gm, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s+/gm, ' ')
    .replace(/[|*_~`#>]/g, ' ');
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;
}

// ---- Edits (the assistant's edit_document) ------------------------------------------------------

export type DocumentEdit =
  | { op: 'append'; markdown: string }
  | { op: 'prepend'; markdown: string }
  | { op: 'replace_all'; markdown: string }
  | { op: 'replace_text'; find: string; replace: string; all?: boolean }
  | { op: 'replace_section'; heading: string; markdown: string }
  | { op: 'append_to_section'; heading: string; markdown: string };

export const DOCUMENT_EDIT_OPS = ['append', 'prepend', 'replace_all', 'replace_text', 'replace_section', 'append_to_section'] as const;

/** A section of the document: the heading's line and where its body ends (before the next heading of the same or a higher level). */
function findSection(lines: string[], heading: string): { at: number; end: number } {
  const want = inlinePlain(heading.replace(/^#+\s*/, '')).toLowerCase();
  let fence: string | null = null;
  const heads: { line: number; level: number; text: string }[] = [];
  lines.forEach((line, n) => {
    const f = FENCE.exec(line);
    if (fence) { if (f && line.trim().startsWith(fence)) fence = null; return; }
    if (f) { fence = f[1]!; return; }
    const h = HEADING.exec(line);
    if (h) heads.push({ line: n, level: h[1]!.length, text: inlinePlain(h[2]!).toLowerCase() });
  });
  const hits = heads.filter((h) => h.text === want);
  if (!hits.length) {
    const names = heads.map((h) => `"${h.text}"`).slice(0, 12).join(', ');
    throw new Error(`No heading "${heading}" in this document.${names ? ` Its headings are: ${names}.` : ' It has no headings; use append or replace_text.'}`);
  }
  if (hits.length > 1) throw new Error(`"${heading}" is the heading of ${hits.length} sections; use replace_text with text unique to the one you mean.`);
  const h = hits[0]!;
  const next = heads.find((x) => x.line > h.line && x.level <= h.level);
  return { at: h.line, end: next ? next.line : lines.length };
}

const tidy = (md: string) => md.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '') + '\n';

/** Applies an edit to a document's Markdown, or throws an error that tells the assistant what to do instead. */
export function applyDocumentEdit(md: string, edit: DocumentEdit): string {
  const body = md.replace(/\r\n?/g, '\n');
  switch (edit.op) {
    case 'append':
      return tidy(`${body.trimEnd()}\n\n${edit.markdown.trim()}`);
    case 'prepend':
      return tidy(`${edit.markdown.trim()}\n\n${body.trimStart()}`);
    case 'replace_all':
      return tidy(edit.markdown);
    case 'replace_text': {
      if (!edit.find) throw new Error('replace_text needs the exact text to find.');
      const count = body.split(edit.find).length - 1;
      if (!count) throw new Error(`"${edit.find.slice(0, 80)}" is not in the document. Read it with read_document and copy the exact text (Markdown included).`);
      if (count > 1 && !edit.all) throw new Error(`"${edit.find.slice(0, 80)}" appears ${count} times. Include more surrounding text, or set all to true to change every one.`);
      return tidy(edit.all ? body.split(edit.find).join(edit.replace) : body.replace(edit.find, () => edit.replace));
    }
    case 'replace_section':
    case 'append_to_section': {
      const lines = body.split('\n');
      const { at, end } = findSection(lines, edit.heading);
      const add = edit.markdown.trim().split('\n');
      if (edit.op === 'replace_section') return tidy([...lines.slice(0, at + 1), '', ...add, '', ...lines.slice(end)].join('\n'));
      let last = end;
      while (last > at + 1 && !lines[last - 1]!.trim()) last--;
      return tidy([...lines.slice(0, last), '', ...add, '', ...lines.slice(end)].join('\n'));
    }
  }
}
