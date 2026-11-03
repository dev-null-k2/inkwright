/**
 * The web clipper: a bookmarklet that extracts a page's readable text in the browser, on the page
 * itself, and opens Inkwright with it in the URL fragment; and the app side that asks the person
 * and saves it as a note. No server is involved at any point: the extraction runs in the page,
 * the fragment never leaves the browser, and the app decodes it locally (core `decodeClip`, which
 * treats it as untrusted: size limits, http(s) only, plain text).
 */
import { CLIP_LIMITS, clipToMarkdown, decodeClip, type WebClip } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { askConfirm } from '../ui/prompts.tsx';
import { takePendingClip } from './stash.ts';

/**
 * Readable text of a document: the selection if there is one, else the main content — `article`,
 * `main` or `[role=main]`, or the block with the most paragraph text and the fewest links — with
 * headings as `#` lines, list items as `- `, code kept, and navigation, forms and scripts skipped.
 *
 * Self-contained on purpose (no imports, no outer names): the bookmarklet is this function's
 * source text, run in the clipped page.
 */
export function extractReadable(doc: Document, limit: number): { title: string; text: string; byline?: string; site?: string } {
  const meta = (sel: string) => (doc.querySelector(sel) as HTMLMetaElement | null)?.content?.trim() || undefined;
  const title = (meta('meta[property="og:title"]') || doc.title || '').replace(/\s+/g, ' ').trim();
  const byline = meta('meta[name="author"]') || (doc.querySelector('[rel="author"], .byline, .author') as HTMLElement | null)?.innerText?.trim().slice(0, 200) || undefined;
  const site = meta('meta[property="og:site_name"]');
  const sel = doc.defaultView?.getSelection?.();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 20) return { title, text: sel.toString().trim().slice(0, limit), ...(byline ? { byline } : {}), ...(site ? { site } : {}) };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|NAV|ASIDE|FOOTER|HEADER|FORM|BUTTON|SVG|IFRAME|TEMPLATE|SELECT|INPUT|TEXTAREA)$/;
  const textLen = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
  const linkLen = (el: Element) => [...el.querySelectorAll('a')].reduce((n, a) => n + textLen(a), 0);
  let root: Element | null = doc.querySelector('article') ?? doc.querySelector('main, [role="main"]');
  if (!root) {
    let best = 0;
    for (const el of doc.querySelectorAll('div, section, td')) {
      const ps = el.querySelectorAll(':scope > p');
      if (!ps.length) continue;
      const len = [...ps].reduce((n, p) => n + textLen(p), 0);
      const score = len * (1 - Math.min(0.9, linkLen(el) / Math.max(1, textLen(el))));
      if (score > best) { best = score; root = el; }
    }
  }
  root ??= doc.body;
  const out: string[] = [];
  let size = 0;
  const push = (s: string) => {
    const t = s.replace(/[ \t]+/g, ' ').trim();
    if (!t || size > limit) return;
    out.push(t);
    size += t.length + 2;
  };
  const walk = (el: Element) => {
    for (const c of el.children) {
      if (SKIP.test(c.tagName) || (c as HTMLElement).hidden || c.getAttribute('aria-hidden') === 'true') continue;
      const tag = c.tagName;
      const text = () => (c as HTMLElement).innerText ?? c.textContent ?? '';
      if (/^H[1-6]$/.test(tag)) push(`${'#'.repeat(Number(tag[1]))} ${text().replace(/\s+/g, ' ')}`);
      else if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION') push(`${tag === 'BLOCKQUOTE' ? '> ' : ''}${text().replace(/\s+/g, ' ')}`);
      else if (tag === 'PRE') { const t = c.textContent ?? ''; if (t.trim() && size <= limit) { out.push(`\`\`\`\n${t.replace(/\n+$/, '')}\n\`\`\``); size += t.length; } }
      else if (tag === 'UL' || tag === 'OL') { let i = 1; for (const li of c.querySelectorAll(':scope > li')) push(`${tag === 'OL' ? `${i++}.` : '-'} ${((li as HTMLElement).innerText ?? li.textContent ?? '').replace(/\s+/g, ' ')}`); }
      else if (tag === 'TABLE') { for (const tr of c.querySelectorAll('tr')) push([...tr.children].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' | ')); }
      else walk(c);
    }
  };
  walk(root);
  return { title, text: out.join('\n\n').slice(0, limit), ...(byline ? { byline } : {}), ...(site ? { site } : {}) };
}

/**
 * The bookmarklet for an app address: extract, encode as base64url JSON, open the app with the
 * clip in the fragment. Drag it to the bookmarks bar; on a phone, save it as a bookmark and pick
 * it from the address bar.
 */
export function bookmarklet(appUrl: string): string {
  const target = appUrl.replace(/#.*$/, '');
  const src = `(()=>{const r=(${extractReadable.toString()})(document,${CLIP_LIMITS.text});const c={v:1,title:r.title,url:location.href,text:r.text,savedAt:Date.now()};if(r.byline)c.byline=r.byline;if(r.site)c.site=r.site;const u=new TextEncoder().encode(JSON.stringify(c));let s='';for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));const b=btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');window.open(${JSON.stringify(target)}+'#clip='+b,'_blank');})()`;
  return `javascript:${encodeURIComponent(src)}`;
}

/** Asks, then saves a clip as a note (typed text, origin `import`, tagged #clipped) and opens it. */
export async function saveClip(c: WebClip): Promise<string | null> {
  const app = useApp.getState();
  const vault = app.vault;
  if (!vault) return null;
  const host = (() => { try { return new URL(c.url).hostname; } catch { return c.url; } })();
  const preview = c.text.trim().slice(0, 400);
  const ok = await askConfirm(`Save “${c.title}” as a note?`, `From ${host}${c.byline ? `, by ${c.byline}` : ''} · ${c.text.length.toLocaleString()} characters\n\n${preview}${c.text.length > 400 ? '…' : ''}`, 'Save note');
  if (!ok) return null;
  const { AppNoteToolHost } = await import('../lib/ai.ts');
  const note = await new AppNoteToolHost(vault, null, 'import').createNote({ title: c.title, text: clipToMarkdown(c), tags: ['clipped'] });
  app.navigate({ name: 'editor', noteId: note.id });
  return note.id;
}

/** Saves a clip carried by a fragment (`clip=…`); a damaged one is reported, not saved. */
export async function consumeClipFragment(fragment: string): Promise<void> {
  let clip: WebClip | null;
  try {
    clip = decodeClip(fragment);
  } catch (e) {
    useApp.getState().toast({ text: (e as Error).message, tone: 'error' });
    return;
  }
  if (clip) await saveClip(clip);
}

/** The web clipper module: the clip the app was opened with, and clips arriving later in this tab. */
export function startClipper(): () => void {
  const first = takePendingClip();
  if (first) void consumeClipFragment(first);
  const onHash = () => {
    if (!location.hash.startsWith('#clip=')) return;
    const frag = location.hash.slice(1);
    history.replaceState(history.state, '', location.pathname + location.search);
    void consumeClipFragment(frag);
  };
  window.addEventListener('hashchange', onHash);
  return () => window.removeEventListener('hashchange', onHash);
}
