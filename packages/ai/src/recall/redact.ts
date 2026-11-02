/**
 * Redaction before storage for the memory timeline. Everything a capture holds — the recognised
 * text, the window title and the page address — goes through the trust layer's privacy firewall
 * (`detectPii`, the same recognizers and validators that guard every AI request, docs/TRUST.md)
 * before a byte is written. Unlike the firewall's reversible placeholders (`⟦EMAIL_1⟧`, restored
 * in the model's answer), redaction here is one-way: the value is never stored anywhere, only
 * its kind (`[email]`) and a count per kind.
 */
import { newId, type Capture, type CaptureKind } from '@inkwright/core';
import { detectPii, type PiiSpan } from '../trust/pii.ts';
import { PII_KINDS, type PiiKind } from '../trust/policy.ts';

/** What the capture loop recognised, before redaction. */
export interface RawCapture {
  at: number;
  end?: number;
  kind: CaptureKind;
  app?: string;
  title?: string;
  url?: string;
  text: string;
  engine?: string;
  device?: string;
}

export interface RedactOptions {
  /** Kinds to redact (default: every kind the firewall knows). */
  kinds?: readonly PiiKind[];
  /** Values never redacted (the trust policy's allow list, e.g. your own company name). */
  allowList?: readonly string[];
}

const LABEL: Record<PiiKind, string> = {
  email: '[email]', phone: '[phone]', card: '[card number]', iban: '[bank account]', gov_id: '[ID number]', secret: '[secret]', address: '[address]', name: '[name]', ip: '[IP address]',
};

/** Replaces personal data and secrets in `text`; returns the text and how many of each kind went. */
export function redactText(text: string, opts: RedactOptions = {}): { text: string; counts: Partial<Record<PiiKind, number>> } {
  const counts: Partial<Record<PiiKind, number>> = {};
  if (!text) return { text, counts };
  const kinds = new Set(opts.kinds ?? PII_KINDS);
  if (!kinds.size) return { text, counts };
  const spans: PiiSpan[] = detectPii(text, { kinds, allowList: opts.allowList });
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + LABEL[s.kind];
    at = s.end;
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  }
  return { text: out + text.slice(at), counts };
}

/**
 * Keeps a page address's origin and path; drops the query and fragment, where sign-in tokens,
 * session ids and search terms live. User info (`user:pass@`) is dropped too.
 */
export function sanitizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return undefined;
  }
}

/** Normalises OCR output: trims lines, drops empty and one-character noise lines, collapses spaces. */
export function cleanRecognisedText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => l.length > 1 && /[\p{L}\p{N}]/u.test(l))
    .join('\n');
}

/**
 * Turns a raw capture into what is stored: cleaned, redacted text, title and address, with
 * per-kind counts and a fresh id. Returns null when nothing worth keeping is left.
 */
export function redactCapture(raw: RawCapture, opts: RedactOptions = {}, makeId: () => string = () => newId()): Capture | null {
  const body = redactText(cleanRecognisedText(raw.text), opts);
  const title = raw.title ? redactText(raw.title.trim(), opts) : null;
  const url = sanitizeUrl(raw.url);
  const urlR = url ? redactText(url, opts) : null;
  if (!body.text && !title?.text) return null;
  const counts: Record<string, number> = {};
  for (const r of [body, title, urlR]) for (const [k, n] of Object.entries(r?.counts ?? {})) counts[k] = (counts[k] ?? 0) + (n ?? 0);
  const c: Capture = { id: makeId(), at: raw.at, kind: raw.kind, text: body.text };
  if (raw.end != null) c.end = raw.end;
  if (raw.app) c.app = raw.app.trim().slice(0, 120);
  if (title?.text) c.title = title.text.slice(0, 300);
  if (urlR?.text) c.url = urlR.text.slice(0, 500);
  if (Object.keys(counts).length) c.redacted = counts;
  if (raw.engine) c.engine = raw.engine;
  if (raw.device) c.device = raw.device;
  return c;
}

/**
 * True when a new capture would add nothing to the previous one of the same window: same app and
 * title, and its text is the same (or its lines are all already there).
 */
export function isRepeat(prev: Pick<Capture, 'app' | 'title' | 'text'> | null, next: Pick<Capture, 'app' | 'title' | 'text'>): boolean {
  if (!prev || prev.app !== next.app || prev.title !== next.title) return false;
  if (prev.text === next.text) return true;
  const had = new Set(prev.text.split('\n'));
  return next.text.split('\n').every((l) => had.has(l));
}
