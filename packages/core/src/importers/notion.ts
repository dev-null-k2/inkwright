/**
 * Notion export ("Export › Markdown & CSV", with "Include subpages" and files). The zip holds:
 *
 * - each page as `Title <32 hex id>.md` (first line `# Title`, then the page's properties as
 *   `Key: value` lines, then the content), and its subpages and files in a folder of the same
 *   name (`Title <id>/`);
 * - each database as `Name <id>.csv` (the default view) and, in newer exports, `Name <id>_all.csv`
 *   (every row), with its row pages in `Name <id>/`;
 * - links between pages and to files as relative, URL-encoded Markdown links
 *   (`[Sub](Title%20<id>/Sub%20<id>.md)`, `![](Title%20<id>/image.png)`);
 * - large workspaces as several `Export-…-Part-N.zip` files inside the outer zip (the app unzips
 *   those before calling this).
 *
 * This turns it into a plain Markdown vault: ids are stripped from every path and link, pages
 * keep their nesting (a page with subpages becomes a notebook), the duplicated `# Title` line
 * goes (the note's title says it), a `Tags:` property becomes tags, and each database becomes a
 * note with a table whose first column links to its row pages.
 */
import type { VaultFile } from '../obsidian.ts';
import { obsidianFileName } from '../obsidian.ts';
import type { ImportReportBase } from './vaultfiles.ts';

const ID = /\s+[0-9a-f]{32}(?=$|\.|_all\.csv$)/i;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** "Plan 0123…cdef.md" → "Plan.md" (segment by segment; file-name-safe). */
export function stripNotionIds(path: string): string {
  return path.split('/').map((seg) => {
    const ext = /\.[a-z0-9]{1,8}$/i.exec(seg)?.[0] ?? '';
    const bare = seg.slice(0, seg.length - ext.length).replace(/\s+[0-9a-f]{32}$/i, '').replace(/\s+[0-9a-f]{32}_all$/i, '_all');
    return (obsidianFileName(bare) || 'Untitled') + ext;
  }).join('/');
}

/** Parses CSV (RFC 4180: quotes, doubled quotes, newlines inside quotes, optional BOM). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const mdCell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

export interface NotionImport extends ImportReportBase {
  files: VaultFile[];
}

/** A Notion export (its files, nested zips already expanded) as a Markdown vault. */
export function notionToVaultFiles(input: readonly VaultFile[]): NotionImport {
  const warnings: string[] = [];
  const files = input.filter((f) => !/\.zip$/i.test(f.path));
  const looksNotion = files.some((f) => ID.test(f.path.split('/').pop() ?? ''));
  if (!looksNotion) throw new Error('This doesn’t look like a Notion export: Notion names every page “Title <id>.md”. Export with Markdown & CSV from Notion (Settings › Export, or ••• › Export on a page).');
  const out: VaultFile[] = [];
  const taken = new Set<string>();
  const place = (path: string) => {
    let p = path;
    for (let i = 2; taken.has(p.toLowerCase()); i++) p = path.replace(/(\.[^./]+)?$/, (ext) => ` (${i})${ext}`);
    taken.add(p.toLowerCase());
    return p;
  };
  // Databases: prefer the `_all.csv` (every row) over the default view when both exist.
  const csvs = files.filter((f) => /\.csv$/i.test(f.path));
  const allBase = new Set(csvs.filter((f) => /_all\.csv$/i.test(f.path)).map((f) => f.path.replace(/_all\.csv$/i, '.csv').toLowerCase()));
  let notes = 0;
  let attachments = 0;
  for (const f of files) {
    const target = stripNotionIds(f.path);
    if (/\.(md|markdown)$/i.test(f.path)) {
      let text = dec.decode(f.bytes);
      const title = target.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
      // The first heading repeats the title.
      text = text.replace(/^﻿?#\s+(.+)\r?\n+/, (m, h: string) => (obsidianFileName(h.trim()) === title || h.trim() === title ? '' : m));
      // Leading `Key: value` property lines (until the first blank line).
      const lines = text.split('\n');
      const props: string[] = [];
      while (lines.length && /^[A-Za-z][\w ]{0,40}: .+/.test(lines[0]!)) props.push(lines.shift()!);
      const tagLine = props.find((p) => /^tags?: /i.test(p));
      const tags = tagLine ? tagLine.replace(/^tags?: /i, '').split(',').map((t) => t.trim().replace(/\s+/g, '-')).filter(Boolean) : [];
      const body = [...props.filter((p) => p !== tagLine), ...(props.length ? [''] : []), ...lines].join('\n')
        // Relative links and images: strip ids from the target, keep it relative.
        .replace(/(!?\[[^\]\n]*\]\()(<?)([^)\n>]+?)(>?)(\s+"[^"]*")?\)/g, (m, open: string, _lt: string, href: string, _gt: string, titlePart: string | undefined) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return m;
          return `${open}<${stripNotionIds(safeDecode(href))}>${titlePart ?? ''})`;
        });
      const fm = tags.length ? `---\ntags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]\n---\n\n` : '';
      out.push({ path: place(target), bytes: enc.encode(fm + body), ...(f.mtime ? { mtime: f.mtime } : {}) });
      notes++;
    } else if (/\.csv$/i.test(f.path)) {
      if (!/_all\.csv$/i.test(f.path) && allBase.has(f.path.toLowerCase())) continue;
      const rows = parseCsvRows(dec.decode(f.bytes));
      if (!rows.length) continue;
      const dbPath = target.replace(/_all\.csv$/i, '.csv').replace(/\.csv$/i, '');
      const dbName = dbPath.split('/').pop()!;
      const cols = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')];
      const rowFolder = files.some((x) => stripNotionIds(x.path).toLowerCase().startsWith(`${dbPath.toLowerCase()}/`));
      const table = [
        `| ${pad(rows[0]!).map(mdCell).join(' | ')} |`,
        `|${' --- |'.repeat(cols)}`,
        ...rows.slice(1).map((r) => `| ${pad(r).map((c, i) => (i === 0 && rowFolder && c.trim() ? `[[${obsidianFileName(c.trim())}]]` : mdCell(c))).join(' | ')} |`),
      ];
      out.push({ path: place(`${dbPath}.md`), bytes: enc.encode(`Notion database “${dbName}”, ${rows.length - 1} ${rows.length === 2 ? 'row' : 'rows'}.\n\n${table.join('\n')}\n`), ...(f.mtime ? { mtime: f.mtime } : {}) });
      notes++;
    } else {
      out.push({ path: place(target), bytes: f.bytes, ...(f.mtime ? { mtime: f.mtime } : {}) });
      attachments++;
    }
  }
  if (input.some((f) => /\.zip$/i.test(f.path))) warnings.push('A zip inside the export was not unpacked.');
  return { files: out, notes, attachments, warnings };
}
