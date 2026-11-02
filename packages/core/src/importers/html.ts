/**
 * HTML (and Evernote's ENML, OneNote's exported web pages) to Markdown, without a DOM.
 *
 * Importers run in the browser, in Node (the CLI, tests) and in workers, so this is a small
 * tolerant tokenizer rather than `DOMParser`: it never builds or renders a document, never runs
 * scripts, never fetches anything, and treats every attribute as text. What it keeps is what a
 * note can show: headings, paragraphs, line breaks, bold/italic/code, links, lists (nested, and
 * Evernote's to-do checkboxes), block quotes, preformatted code, simple tables and images. What it
 * drops: scripts, styles, comments, forms, frames, and every attribute but `href`/`src`/`alt`.
 *
 * Images are resolved by the caller (`image`), which maps an `src` (or Evernote's `en-media`
 * hash) to a file path in the vault being built; an unresolved image becomes its alt text.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  laquo: '«', raquo: '»', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', check: '✓', shy: '',
};

/** Decodes character references (`&amp;`, `&#233;`, `&#x1F600;`); unknown names stay as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v ?? m;
  });
}

interface Tag {
  name: string;
  close: boolean;
  selfClose: boolean;
  attrs: Record<string, string>;
}

type Token = { t: 'text'; v: string } | ({ t: 'tag' } & Tag);

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
/** Elements whose content is never text for a note. */
const DROP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'select', 'textarea', 'button', 'form', 'nav', 'canvas', 'audio', 'video']);

/** Splits HTML into text and tags. Comments, doctypes, CDATA markers and processing instructions vanish. */
export function tokenizeHtml(html: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out.push({ t: 'text', v: html.slice(i) }); break; }
    if (lt > i) out.push({ t: 'text', v: html.slice(i, lt) });
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (html.startsWith('<![CDATA[', lt)) { const e = html.indexOf(']]>', lt + 9); out.push({ t: 'text', v: escapeText(html.slice(lt + 9, e < 0 ? n : e)) }); i = e < 0 ? n : e + 3; continue; }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/?)>/.exec(html.slice(lt, lt + 4096));
    if (!m) { out.push({ t: 'text', v: '<' }); i = lt + 1; continue; }
    const name = m[2]!.toLowerCase();
    const attrs: Record<string, string> = {};
    if (!m[1]) for (const a of m[3]!.matchAll(ATTR)) attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    i = lt + m[0].length;
    if (!m[1] && DROP.has(name) && !m[4]) {
      // Skip to the matching close tag (these never nest in practice).
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      const e = close < 0 ? n : html.indexOf('>', close);
      i = e < 0 ? n : e + 1;
      continue;
    }
    out.push({ t: 'tag', name, close: !!m[1], selfClose: !!m[4], attrs });
  }
  return out;
}

/** Text that would be read as HTML again (CDATA content is literal). */
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Characters that would turn plain text into Markdown syntax at the start of a line or inline. */
/**
 * Percent-encodes one character for a Markdown link target. `encodeURIComponent` leaves `(` and
 * `)` alone, and those end a Markdown link early.
 */
export const pctEncode = (c: string) => [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

const escapeMd = (s: string) => s.replace(/([\\`*_[\]])/g, '\\$1');

export interface HtmlToMarkdownOptions {
  /** Maps an image `src` (or `en-media` hash, as `en-media:<hash>`) to a vault path; null keeps the alt text. */
  image?: (src: string, alt: string) => string | null;
  /** Rewrites link targets (e.g. a OneNote page link to a [[wiki link]]); null keeps the text only. */
  link?: (href: string, text: string) => string | null;
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'address', 'center', 'en-note', 'body', 'html', 'dl', 'dt', 'dd', 'details', 'summary']);
const HEADING = /^h([1-6])$/;

interface ListFrame { ordered: boolean; n: number }

/**
 * Converts HTML to Markdown. Whitespace collapses as in a browser except inside `<pre>`; block
 * elements become paragraphs; nesting depth of lists is kept with two-space indents.
 */
export function htmlToMarkdown(html: string, o: HtmlToMarkdownOptions = {}): string {
  const tokens = tokenizeHtml(html);
  const lines: string[] = [];
  let cur = '';
  let pre = 0;
  let quote = 0;
  const lists: ListFrame[] = [];
  const links: { href: string; start: number }[] = [];
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;

  const prefix = () => '> '.repeat(quote);
  const emit = (s: string) => {
    if (cell != null) { cell += s; return; }
    cur += s;
  };
  const endLine = () => {
    if (cell != null) { cell += ' '; return; }
    const t = cur.replace(/[ \t]+$/g, '');
    // Leading spaces go (HTML collapses them) except in <pre> and before a nested list marker.
    if (t.trim()) lines.push(prefix() + t.replace(/^\s+/, (m) => (pre || /^\s+(?:-|\d+\.) /.test(t) ? m : '')));
    cur = '';
  };
  const paragraph = () => {
    endLine();
    if (cell == null && lines.length && lines[lines.length - 1] !== '' && !lists.length) lines.push(quote ? prefix().trimEnd() : '');
  };
  const listIndent = () => '  '.repeat(Math.max(0, lists.length - 1));

  for (const tok of tokens) {
    if (tok.t === 'text') {
      const raw = decodeEntities(tok.v);
      if (pre) { emit(raw.replace(/\r\n?/g, '\n').split('\n').join(`\n${prefix()}`)); continue; }
      const text = raw.replace(/\s+/g, ' ');
      if (!text.trim() && (!cur || cur.endsWith(' '))) continue;
      emit(escapeMd(cur || cell ? text : text.replace(/^ /, '')));
      continue;
    }
    const { name, close, attrs } = tok;
    const h = HEADING.exec(name);
    if (h) {
      if (!close) { paragraph(); emit(`${'#'.repeat(Number(h[1]))} `); } else paragraph();
      continue;
    }
    switch (name) {
      case 'br': if (pre) emit('\n'); else endLine(); break;
      case 'hr': paragraph(); lines.push('---', ''); break;
      case 'b': case 'strong': emit('**'); break;
      case 'i': case 'em': case 'cite': emit('_'); break;
      case 's': case 'strike': case 'del': emit('~~'); break;
      case 'code': case 'kbd': case 'samp': if (!pre) emit('`'); break;
      case 'pre':
        if (!close) { paragraph(); emit('```'); endLine(); pre++; } else { endLine(); pre = Math.max(0, pre - 1); lines.push(`${prefix()}\`\`\``, ''); }
        break;
      case 'blockquote':
        paragraph();
        quote = Math.max(0, quote + (close ? -1 : 1));
        break;
      case 'ul': case 'ol':
        if (!close) { endLine(); lists.push({ ordered: name === 'ol', n: Number(attrs.start) || 1 }); } else { endLine(); lists.pop(); if (!lists.length) paragraph(); }
        break;
      case 'li': {
        endLine();
        if (close) break;
        const l = lists[lists.length - 1];
        const marker = l?.ordered ? `${l.n++}.` : '-';
        emit(`${listIndent()}${marker} `);
        break;
      }
      case 'en-todo': emit(attrs.checked === 'true' ? '[x] ' : '[ ] '); break;
      case 'input': if (attrs.type === 'checkbox') emit('checked' in attrs ? '[x] ' : '[ ] '); break;
      case 'a':
        if (!close) links.push({ href: attrs.href ?? '', start: cell != null ? cell.length : cur.length });
        else {
          const l = links.pop();
          if (!l) break;
          const target: string = cell != null ? cell : cur;
          const text: string = target.slice(l.start);
          const href = l.href.trim();
          let rep: string | null = text;
          if (href && !/^(javascript|data|vbscript):/i.test(href)) {
            const custom: string | null | undefined = o.link?.(href, text.replace(/\\(.)/g, '$1'));
            rep = custom !== undefined ? (custom ?? text) : /^(https?|mailto|tel):/i.test(href) ? `[${text || href}](${href.replace(/[()\s<>]/g, pctEncode)})` : text;
          }
          if (cell != null) cell = cell.slice(0, l.start) + rep; else cur = cur.slice(0, l.start) + rep;
        }
        break;
      case 'img': case 'en-media': {
        if (close) break;
        const src = name === 'en-media' ? `en-media:${attrs.hash ?? ''}` : attrs.src ?? '';
        const alt = (attrs.alt ?? attrs.title ?? '').replace(/[[\]\n]/g, ' ').trim();
        const path = src ? o.image?.(src, alt) : null;
        if (path) { endLine(); emit(`![${alt}](<${path}>)`); endLine(); } else if (alt) emit(escapeMd(alt));
        break;
      }
      case 'table': if (!close) { paragraph(); table = []; } else if (table) { flushTable(table, lines, prefix()); table = null; lines.push(''); } break;
      case 'tr': if (!close && table) row = []; else if (close && table && row) { table.push(row); row = null; } break;
      case 'td': case 'th':
        if (!close && table) { row ??= []; cell = ''; } else if (close && cell != null) { (row ??= []).push(cell.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')); cell = null; }
        break;
      default:
        if (BLOCK.has(name)) { if (lists.length) endLine(); else paragraph(); }
    }
  }
  endLine();
  if (table) flushTable(table, lines, prefix());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '') + '\n';
}

function flushTable(rows: string[][], lines: string[], prefix: string): void {
  const body = rows.filter((r) => r.some((c) => c));
  if (!body.length) return;
  const cols = Math.max(...body.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')];
  // A one-column table is how Evernote and OneNote lay out pages; it reads better as paragraphs.
  if (cols === 1) { for (const r of body) lines.push(prefix + r[0], ''); return; }
  lines.push(`${prefix}| ${pad(body[0]!).join(' | ')} |`, `${prefix}|${' --- |'.repeat(cols)}`);
  for (const r of body.slice(1)) lines.push(`${prefix}| ${pad(r).join(' | ')} |`);
}
