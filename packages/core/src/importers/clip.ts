/**
 * Web clips: a page's readable text saved as a note. The extraction runs in the browser on the
 * page itself (the bookmarklet; apps/web/src/importers/clipper), which then opens Inkwright with
 * the clip in the URL *fragment* (`#clip=<base64url JSON>`). Fragments are never sent to a server,
 * so no server sees the page; the app checks the payload here, asks the person, and saves it.
 *
 * The payload is untrusted (any page can open that URL): it is size-limited, its URL must be
 * http(s), its text is plain text (Markdown special characters are kept as typed, never HTML),
 * and saving always waits for the person's OK.
 */
import { pctEncode } from './html.ts';

export interface WebClip {
  v: 1;
  title: string;
  url: string;
  /** Readable text, paragraphs separated by blank lines; headings as `#` lines, list items as `- `. */
  text: string;
  byline?: string;
  site?: string;
  /** Epoch ms when it was clipped. */
  savedAt: number;
}

export const CLIP_FRAGMENT = 'clip=';
export const CLIP_LIMITS = { title: 300, url: 2048, text: 200_000, byline: 200, site: 200 } as const;

const b64url = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

/** The fragment that carries a clip (`clip=…`, without `#`). */
export function encodeClip(c: WebClip): string {
  return CLIP_FRAGMENT + b64url.encode(new TextEncoder().encode(JSON.stringify(c)));
}

/**
 * Reads a clip from a URL fragment. Returns null when the fragment carries none; throws a plain
 * message when it carries one that is malformed or too large.
 */
export function decodeClip(hash: string): WebClip | null {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith(CLIP_FRAGMENT)) return null;
  const raw = h.slice(CLIP_FRAGMENT.length);
  if (raw.length > CLIP_LIMITS.text * 3) throw new Error('This clip is too large to save.');
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(new TextDecoder().decode(b64url.decode(raw))) as Record<string, unknown>;
  } catch {
    throw new Error('This clip link is damaged; clip the page again.');
  }
  const str = (k: string, max: number, required = false): string | undefined => {
    const x = v[k];
    if (x == null || x === '') { if (required) throw new Error(`This clip has no ${k}.`); return undefined; }
    if (typeof x !== 'string') throw new Error(`This clip's ${k} is not text.`);
    return x.slice(0, max);
  };
  const url = str('url', CLIP_LIMITS.url, true)!;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('This clip has no valid page address.'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only web pages (http and https) can be clipped.');
  const text = (str('text', CLIP_LIMITS.text) ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const title = (str('title', CLIP_LIMITS.title) ?? '').replace(/\s+/g, ' ').trim() || parsed.hostname;
  const savedAt = typeof v.savedAt === 'number' && Number.isFinite(v.savedAt) ? v.savedAt : Date.now();
  const byline = str('byline', CLIP_LIMITS.byline);
  const site = str('site', CLIP_LIMITS.site);
  return { v: 1, title, url: parsed.toString(), text, savedAt, ...(byline ? { byline } : {}), ...(site ? { site } : {}) };
}

/** The note text of a clip: where it came from, then the readable text. */
export function clipToMarkdown(c: WebClip): string {
  const host = (() => { try { return new URL(c.url).hostname.replace(/^www\./, ''); } catch { return c.url; } })();
  const when = new Date(c.savedAt).toISOString().slice(0, 10);
  const meta = [`Clipped from [${(c.site || host).replace(/[[\]]/g, '')}](${c.url.replace(/[()\s<>]/g, pctEncode)}) on ${when}`, c.byline ? `by ${c.byline}` : ''].filter(Boolean).join(' · ');
  return `> ${meta}\n\n${c.text.trim()}\n`;
}
