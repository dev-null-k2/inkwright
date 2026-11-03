/**
 * Documents ↔ Markdown (the storage format: docs/VAULT_FORMAT.md › Documents).
 *
 * The editor works on a ProseMirror document (Tiptap); the vault keeps GitHub-flavoured Markdown
 * with three HTML additions for what Markdown can't say: `<u>…</u>` (underline),
 * `<div class="page-break"></div>` (a manual page break) and `<br>` inside table cells.
 *
 * - {@link toMarkdown} serialises the editor's JSON. It is deterministic: the same document
 *   always gives the same text, so saving an unchanged document changes nothing and sync's
 *   paragraph merge sees only real edits.
 * - {@link markdownToHtml} renders Markdown (marked, GFM) into the HTML the editor's schema
 *   parses: task lists get Tiptap's `data-type` markup, images in the note's `assets/` folder get
 *   `data-asset` and a displayable URL, and everything passes DOMPurify first.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** ProseMirror JSON as Tiptap's `editor.getJSON()` returns it. */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

// ---- Serialising -------------------------------------------------------------------------------

/** Mark order when several start together; code is innermost (nothing is escaped inside it). */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'code'];
const OPEN: Record<string, (attrs?: Record<string, unknown>) => string> = {
  bold: () => '**',
  italic: () => '*',
  strike: () => '~~',
  underline: () => '<u>',
  code: (a) => String(a?.delim ?? '`'),
  link: () => '[',
};
const CLOSE: Record<string, (attrs?: Record<string, unknown>) => string> = {
  bold: () => '**',
  italic: () => '*',
  strike: () => '~~',
  underline: () => '</u>',
  code: (a) => [...String(a?.delim ?? '`')].reverse().join(''),
  link: (a) => `](${escapeUrl(String(a?.href ?? ''))}${a?.title ? ` "${String(a.title).replace(/"/g, '\\"')}"` : ''})`,
};

const escapeUrl = (u: string) => u.replace(/[()\s]/g, (c) => encodeURIComponent(c));

/** Escapes characters Markdown would read as syntax inside running text. */
export function escapeText(s: string, inTable = false): string {
  let out = s.replace(/[\\`*_[\]<>~]/g, '\\$&');
  if (inTable) out = out.replace(/\|/g, '\\|');
  return out;
}

/** Escapes what would turn the start of a line into a block (heading, quote, list, rule). */
function escapeLineStart(s: string): string {
  return s
    .replace(/^(\s*)(#{1,6}\s)/, '$1\\$2')
    .replace(/^(\s*)([>+-]\s)/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)]\s)/, '$1$2\\$3')
    .replace(/^(\s*)(=+\s*$|-{3,}\s*$)/, '$1\\$2');
}

const markKey = (m: { type: string; attrs?: Record<string, unknown> }) => (m.type === 'link' ? `link:${String(m.attrs?.href ?? '')}` : m.type === 'code' ? `code:${String(m.attrs?.delim ?? '`')}` : m.type);

/** Inline content (text with marks, hard breaks, inline images) of a block as Markdown. */
export function inlineMarkdown(nodes: PMNode[] | undefined, ctx: { inTable?: boolean } = {}): string {
  let out = '';
  const open: { type: string; attrs?: Record<string, unknown> }[] = [];
  let pendingSpace = '';
  const closeTo = (depth: number) => {
    while (open.length > depth) { const m = open.pop()!; out += CLOSE[m.type]!(m.attrs); }
  };
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      closeTo(0);
      out += pendingSpace + (ctx.inTable ? '<br>' : '\\\n');
      pendingSpace = '';
      continue;
    }
    if (n.type === 'image') {
      closeTo(0);
      out += pendingSpace + imageMarkdown(n);
      pendingSpace = '';
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const marks = [...(n.marks ?? [])].filter((m) => m.type in OPEN).sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    // Keep the marks already open that this text still has (as a prefix of the open stack).
    let keep = 0;
    while (keep < open.length && keep < marks.length && markKey(open[keep]!) === markKey(marks[keep]!)) keep++;
    const isCode = marks.some((m) => m.type === 'code');
    let text = n.text;
    // Spaces at the edges go outside the marks ("** bold**" isn't bold in Markdown).
    const lead = isCode ? '' : /^\s*/.exec(text)![0];
    const trail = isCode ? '' : /\s*$/.exec(text)![0];
    text = text.slice(lead.length, text.length - trail.length || undefined);
    if (keep < open.length) { closeTo(keep); }
    out += pendingSpace + lead;
    pendingSpace = '';
    for (const m of marks.slice(keep)) {
      // Code spans holding a backtick are fenced with two, padded so they can start or end with one.
      const opened = m.type === 'code' && text.includes('`') ? { ...m, attrs: { delim: '`` ' } } : m;
      out += OPEN[opened.type]!(opened.attrs);
      open.push(opened);
    }
    out += isCode ? (ctx.inTable ? text.replace(/\|/g, '\\|') : text) : escapeText(text, ctx.inTable);
    pendingSpace = trail;
  }
  closeTo(0);
  // Spaces at the very end of a block are dropped (two would mean a line break in Markdown).
  return out;
}

function imageMarkdown(n: PMNode): string {
  const asset = n.attrs?.asset ? `assets/${String(n.attrs.asset)}` : String(n.attrs?.src ?? '');
  const alt = String(n.attrs?.alt ?? '').replace(/[[\]]/g, '');
  return `![${alt}](${escapeUrl(asset)})`;
}

const indent = (s: string, pad: string) => s.split('\n').map((l) => (l ? pad + l : l)).join('\n');

/** A list item: `marker` starts its first line; later lines are indented by `padWidth` (the list marker's width, without a task box). */
function listItem(marker: string, item: PMNode, padWidth = marker.length): string {
  const blocks = (item.content ?? []).map((c) => block(c)).filter((b) => b !== '');
  if (!blocks.length) return marker.trimEnd();
  const pad = ' '.repeat(padWidth);
  const [first, ...rest] = blocks;
  const head = marker + indent(first!, pad).slice(padWidth);
  if (!rest.length) return head;
  // A nested list follows its parent line directly; other blocks are separated by a blank line.
  return [head, ...rest.map((b, i) => ((item.content?.[i + 1]?.type ?? '').endsWith('List') ? '' : '\n') + indent(b, pad))].join('\n');
}

function tableMarkdown(n: PMNode): string {
  const rows = (n.content ?? []).map((r) => (r.content ?? []).map((cell) => (cell.content ?? []).map((p) => (p.type === 'paragraph' || p.type === 'heading' ? inlineMarkdown(p.content, { inTable: true }) : plain(p).replace(/\|/g, '\\|'))).join('<br>').replace(/\n/g, ' ')));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')];
  const line = (r: string[]) => `| ${pad(r).map((c) => c || ' ').join(' | ')} |`.replace(/ {2,}\|/g, ' |');
  return [line(rows[0]!), `| ${Array(cols).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

const plain = (n: PMNode): string => n.text ?? (n.content ?? []).map(plain).join(n.type === 'paragraph' ? '' : ' ');

/** One block node as Markdown (no trailing newline). */
export function block(n: PMNode): string {
  switch (n.type) {
    case 'paragraph': return escapeLineStart(inlineMarkdown(n.content));
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${inlineMarkdown(n.content)}`.trimEnd();
    case 'blockquote': return (n.content ?? []).map(block).join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    case 'codeBlock': {
      const code = plain(n);
      const fence = /```/.test(code) ? '~~~~' : '```';
      return `${fence}${String(n.attrs?.language ?? '') || ''}\n${code}\n${fence}`;
    }
    case 'horizontalRule': return '---';
    case 'pageBreak': return '<div class="page-break"></div>';
    case 'image': return imageMarkdown(n);
    case 'bulletList': return (n.content ?? []).map((i) => listItem('- ', i)).join('\n');
    case 'orderedList': {
      const start = Number(n.attrs?.start ?? 1) || 1;
      return (n.content ?? []).map((i, k) => listItem(`${start + k}. `, i)).join('\n');
    }
    case 'taskList': return (n.content ?? []).map((i) => listItem(`- [${i.attrs?.checked ? 'x' : ' '}] `, i, 2)).join('\n');
    case 'table': return tableMarkdown(n);
    default: return n.content ? (n.content).map(block).join('\n\n') : escapeText(n.text ?? '');
  }
}

/** The editor's document as the Markdown stored in the vault (ends with one newline; empty → ''). */
export function toMarkdown(doc: PMNode): string {
  const blocks = (doc.content ?? []).map(block);
  // Trailing empty paragraphs (the cursor's resting line) aren't content.
  while (blocks.length && blocks[blocks.length - 1] === '') blocks.pop();
  const out = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n');
  return out.trim() ? `${out}\n` : '';
}

// ---- Rendering ---------------------------------------------------------------------------------

/** Turns asset names into displayable URLs (blob: URLs of the note's files). */
export type AssetResolver = (name: string) => string | undefined;

const ASSET_SRC = /^assets\/([0-9A-Za-z_.-]{1,96})$/;

/**
 * Markdown → HTML for the editor. Raw HTML in Markdown is allowed (underline, page breaks, `<br>`)
 * but sanitised; scripts, event handlers and unknown elements never reach the page.
 */
export function markdownToHtml(md: string, resolve: AssetResolver = () => undefined): string {
  const raw = marked.parse(md, { gfm: true, breaks: false, async: false }) as string;
  return prepareHtml(raw, resolve);
}

/** Sanitises HTML (from Markdown, an imported .html or .docx file) and adapts it to the editor's schema. */
export function prepareHtml(html: string, resolve: AssetResolver = () => undefined): string {
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['data-type', 'data-checked', 'data-asset', 'start'], FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'] });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  const root = tpl.content;
  // GFM task lists: <li><input type=checkbox checked> text</li> → Tiptap's task list markup.
  for (const ul of [...root.querySelectorAll('ul')]) {
    const items = [...ul.children].filter((c) => c.tagName === 'LI');
    if (!items.length || !items.every((li) => taskCheckbox(li))) continue;
    ul.setAttribute('data-type', 'taskList');
    for (const li of items) {
      const box = taskCheckbox(li)!;
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', box.checked || box.hasAttribute('checked') ? 'true' : 'false');
      box.remove();
      // Tiptap's task item holds paragraphs: wrap loose inline content.
      if (!li.querySelector(':scope > p')) {
        const p = document.createElement('p');
        const nested = [...li.childNodes].filter((c) => c instanceof HTMLElement && /^(UL|OL)$/.test(c.tagName));
        for (const c of [...li.childNodes]) if (!nested.includes(c)) p.appendChild(c);
        p.innerHTML = p.innerHTML.replace(/^\s+/, '');
        li.prepend(p);
      }
    }
  }
  // Images stored in the note: keep the asset name, show its file.
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    const m = ASSET_SRC.exec(decodeURIComponent(src)) ?? (img.dataset.asset ? [src, img.dataset.asset] : null);
    if (m) {
      img.setAttribute('data-asset', m[1]!);
      const url = resolve(m[1]!);
      if (url) img.setAttribute('src', url);
    }
  }
  // Block images: a paragraph holding only images becomes the images themselves.
  for (const p of [...root.querySelectorAll('p')]) {
    const kids = [...p.childNodes].filter((c) => !(c.nodeType === 3 && !c.textContent!.trim()));
    if (kids.length && kids.every((c) => c instanceof HTMLImageElement)) p.replaceWith(...kids);
  }
  // marked ends code blocks with a newline that isn't part of the code.
  for (const code of [...root.querySelectorAll('pre > code')]) {
    if (code.textContent?.endsWith('\n')) code.textContent = code.textContent.slice(0, -1);
  }
  const out = document.createElement('div');
  out.appendChild(root);
  return out.innerHTML;
}

function taskCheckbox(li: Element): HTMLInputElement | null {
  const first = li.querySelector(':scope > input[type="checkbox"], :scope > p:first-child > input[type="checkbox"]');
  return first instanceof HTMLInputElement ? first : null;
}

/** Asset names an HTML string refers to (for copying images along). */
export function assetsIn(md: string): string[] {
  return [...new Set([...md.matchAll(/\]\(assets\/([0-9A-Za-z_.-]{1,96})\)/g)].map((m) => m[1]!))];
}
