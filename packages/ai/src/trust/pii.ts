/**
 * The privacy firewall: finds personal data and secrets in text before it goes to a cloud model,
 * swaps each one for a stable placeholder (`⟦EMAIL_1⟧`), and puts the real values back into the
 * model's answer and tool calls on this device. The model never sees the value, and the user
 * never sees the placeholder.
 *
 * Detection is rules first, in the spirit of Microsoft Presidio's recognizers: a pattern finds a
 * candidate, then a validator (Luhn, IBAN mod-97, Verhoeff, SSN ranges, entropy, context words)
 * decides. Validators are what keep precision high — a 16-digit order number that fails Luhn is
 * not a card, a git SHA is not an API key. Names are the hard case: rules catch names in
 * recognisable contexts (titles, greetings, sign-offs, "meeting with …"), and an optional
 * `NameDetector` (an on-device NER model) can add more. docs/TRUST.md publishes the measured
 * precision and recall per kind from `packages/ai/evals/trust.eval.ts`.
 *
 * What it cannot do: read text inside images (page images go to vision models as pixels — route
 * vision to the device if that matters), or know that a number is sensitive without a pattern.
 */
import type { PiiKind, PrivacyAction, PrivacyPolicy } from './policy.ts';

export interface PiiSpan {
  kind: PiiKind;
  start: number;
  end: number;
  value: string;
  /** Which recognizer found it (for the redaction log and tests). */
  rule: string;
}

/** An extra recognizer for names (or anything else), e.g. an on-device NER model. */
export type NameDetector = (text: string) => Promise<Array<Pick<PiiSpan, 'start' | 'end'> & { kind?: PiiKind }>>;

// ---- Validators ------------------------------------------------------------------------------------

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** IBAN lengths by country (ISO 13616 registry; the common ones). Unknown countries need 15–34. */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28,
  IE: 22, IL: 23, IS: 26, IT: 27, KW: 30, KZ: 20, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PK: 24, PL: 28, PT: 25, QA: 29, RO: 24, SA: 24,
  SE: 24, SI: 19, SK: 24, SM: 27, TR: 26, UA: 29,
};

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const want = IBAN_LENGTHS[s.slice(0, 2)];
  if (want ? s.length !== want : s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff checksum (India's Aadhaar numbers). */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---- Recognizers -----------------------------------------------------------------------------------

interface Recognizer {
  kind: PiiKind;
  rule: string;
  re: RegExp;
  /** Which capture group is the value (default the whole match). */
  group?: number;
  validate?: (value: string, text: string, start: number) => boolean;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');
const before = (text: string, start: number, n = 40) => text.slice(Math.max(0, start - n), start).toLowerCase();

const SECRET_PREFIXES: Array<[string, RegExp]> = [
  ['anthropic', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g],
  ['openai', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g],
  ['gitlab', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['slack', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g],
  ['huggingface', /\bhf_[A-Za-z0-9]{30,}/g],
  ['npm', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['sendgrid', /\bSG\.[\w-]{16,}\.[\w-]{30,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
];

const STREET = '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Circle|Cir|Highway|Hwy|Square|Sq)';
const HONORIFIC = '(?:Mr|Mrs|Ms|Mx|Dr|Prof|Professor|Sir|Dame|Madam|Mme|Herr|Frau|Señor|Señora)';
const CAP = "[A-Z][a-zà-öø-ÿ'’-]+";
/** Capitalised words that are not names even after "meeting with" or "Hi". */
const NOT_NAMES = new Set([
  'The', 'This', 'That', 'There', 'Team', 'Everyone', 'All', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February',
  'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Today', 'Tomorrow', 'Yesterday', 'Thanks', 'Thank', 'Best',
  'Regards', 'Cheers', 'Sales', 'Marketing', 'Engineering', 'Support', 'Legal', 'Finance', 'Product', 'Design', 'Customer', 'Customers', 'Client', 'Clients',
  'Google', 'Microsoft', 'Apple', 'Amazon', 'Claude', 'Gemini', 'ChatGPT', 'Notion', 'Slack', 'Zoom', 'Teams', 'Inkstone', 'Professor', 'Doctor', 'Mom', 'Dad',
  'Hello', 'Hey', 'Hi', 'Dear', 'Please', 'Sincerely', 'Warmly', 'Love', 'Yours', 'Kind', 'Q1', 'Q2', 'Q3', 'Q4', 'PM', 'AM', 'Board', 'Staff', 'Faculty',
]);

function looksLikeName(words: string): boolean {
  const parts = words.trim().split(/\s+/);
  return parts.length > 0 && parts.every((w) => !NOT_NAMES.has(w.replace(/[.,]$/, '')) && w.length > 1);
}

const RECOGNIZERS: Recognizer[] = [
  // Secrets: known prefixes first; they are certain.
  ...SECRET_PREFIXES.map(([name, re]): Recognizer => ({ kind: 'secret', rule: `secret:${name}`, re })),
  {
    kind: 'secret',
    rule: 'secret:url-credentials',
    // scheme://user:password@host — only the password is the secret, but the user name goes too.
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:@/]{1,64}:[^\s@/]{3,128})@/g,
    group: 1,
  },
  {
    kind: 'secret',
    rule: 'secret:assignment',
    re: /\b(?:password|passwd|pwd|passcode|secret|client[_-]?secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|private[_-]?key)\b["']?\s*(?:[:=]|is)\s*["']?([^\s"'`,;]{6,200})/gi,
    group: 1,
    validate: (v) => !/^(?:required|optional|null|none|undefined|true|false|string|\*+|x+|<[^>]*>|\$\{[^}]*\}|your[_-]?\w*)$/i.test(v),
  },
  {
    kind: 'secret',
    rule: 'secret:entropy',
    re: /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{28,200}(?![A-Za-z0-9+/_=-])/g,
    validate: (v, text, start) => {
      if (/base64,\s*$/.test(before(text, start, 12))) return false; // data: URLs (images)
      if (/^[0-9a-f-]+$/i.test(v) || /^[0-9A-F-]+$/.test(v)) return false; // hex: hashes, UUIDs, ids
      if (/^[0-9A-HJKMNP-TV-Z]{22,32}$/.test(v)) return false; // Crockford base32 ids (Inkstone's own)
      const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length;
      if (classes < 3) return false;
      if (/[/_-]/.test(v) && v.split(/[/_-]/).every((p) => /^[a-zA-Z]*$/.test(p) || /^\d+$/.test(p))) return false; // paths and slugs
      return entropy(v) >= 4.2;
    },
  },
  { kind: 'email', rule: 'email', re: /\b[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g },
  {
    kind: 'card',
    rule: 'card:luhn',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (v) => {
      const d = digitsOf(v);
      if (d.length < 13 || d.length > 19 || !luhnValid(d) || /^(\d)\1+$/.test(d)) return false;
      return /^(?:4|5[1-5]|2[2-7]|3[47]|3[0689]|6(?:011|5|4[4-9]|22)|35|62|81)/.test(d);
    },
  },
  { kind: 'iban', rule: 'iban:mod97', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, validate: (v) => ibanValid(v) },
  {
    kind: 'gov_id',
    rule: 'gov_id:us-ssn',
    re: /\b(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}\b/g,
    // 123-45-6789 is the textbook example and real-looking; dates and phone fragments never match 3-2-4.
  },
  {
    kind: 'gov_id',
    rule: 'gov_id:us-ssn-context',
    re: /\b(?:ssn|social security(?: number| no\.?)?)\s*(?:#|:|is)?\s*((?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4})\b/gi,
    group: 1,
  },
  {
    kind: 'gov_id',
    rule: 'gov_id:uk-nino',
    re: /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  },
  { kind: 'gov_id', rule: 'gov_id:in-aadhaar', re: /\b[2-9]\d{3} \d{4} \d{4}\b/g, validate: (v) => verhoeffValid(digitsOf(v)) },
  { kind: 'gov_id', rule: 'gov_id:in-pan', re: /\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b/g },
  { kind: 'gov_id', rule: 'gov_id:ca-sin', re: /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g, validate: (v, text, start) => luhnValid(digitsOf(v)) && /\b(?:sin|social insurance)\b/.test(before(text, start)) },
  {
    kind: 'gov_id',
    rule: 'gov_id:passport-context',
    re: /\b(?:passport|driver'?s? licen[cs]e|licen[cs]e)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9]{6,12})\b/gi,
    group: 1,
    validate: (v) => /\d/.test(v),
  },
  {
    kind: 'phone',
    rule: 'phone:intl',
    re: /(?<![\w+])\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,4}\b/g,
    validate: (v) => { const n = digitsOf(v).length; return n >= 8 && n <= 15; },
  },
  {
    kind: 'phone',
    rule: 'phone:nanp',
    re: /(?<![\w+-])(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
    validate: (v) => /^[2-9]/.test(digitsOf(v)),
  },
  {
    kind: 'phone',
    rule: 'phone:context',
    re: /\b(?:phone|tel|mobile|cell|call|text|whatsapp)\b\.?\s*(?:me\s*(?:at|on)\s*|#|:|no\.?)?\s*(\d[\d\s.-]{6,16}\d)\b/gi,
    group: 1,
    validate: (v) => { const n = digitsOf(v).length; return n >= 7 && n <= 15; },
  },
  {
    kind: 'ip',
    rule: 'ip:v4',
    re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\w|\.\d)/g,
    validate: (_v, text, start) => !/\bv(?:ersion)?\s*$/i.test(before(text, start, 9)),
  },
  {
    kind: 'address',
    rule: 'address:street',
    re: new RegExp(`\\b\\d{1,6}[A-Za-z]?\\s+(?:(?:[NSEW]|North|South|East|West)\\.?\\s+)?(?:${CAP}\\s+){1,3}${STREET}\\b\\.?(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?\\s*[\\w-]+)?(?:,\\s*${CAP}(?:\\s+${CAP})*,?\\s+[A-Z]{2}\\s+\\d{5}(?:-\\d{4})?)?`, 'g'),
  },
  {
    kind: 'address',
    rule: 'address:de-street',
    re: /\b[A-ZÄÖÜ][a-zäöüß]+(?:straße|strasse|str\.|weg|platz|allee|gasse|ring)\s+\d{1,4}[a-z]?\b(?:,\s*\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+)?/g,
  },
  { kind: 'address', rule: 'address:uk-postcode', re: /\b(?:GIR 0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/g },
  { kind: 'name', rule: 'name:honorific', re: new RegExp(`\\b${HONORIFIC}\\.?\\s+((?:${CAP})(?:\\s+${CAP}){0,2})`, 'g'), group: 1, validate: (v) => looksLikeName(v) },
  {
    kind: 'name',
    rule: 'name:introduced',
    re: new RegExp(`\\b(?:my name is|I am|I'm|this is|name:)\\s+(${CAP}\\s+${CAP}(?:\\s+${CAP})?)`, 'gi'),
    group: 1,
    validate: (v) => /^[A-Z]/.test(v) && v.split(/\s+/).every((w) => /^[A-Z]/.test(w)) && looksLikeName(v),
  },
  {
    kind: 'name',
    rule: 'name:greeting',
    re: new RegExp(`(?:^|\\n)\\s*(?:Dear|Hi|Hello|Hey)\\s+(${CAP}(?:\\s+${CAP})?)\\s*[,!:]`, 'g'),
    group: 1,
    validate: (v) => looksLikeName(v),
  },
  {
    kind: 'name',
    rule: 'name:signoff',
    re: new RegExp(`(?:Best|Regards|Kind regards|Best regards|Thanks|Thank you|Cheers|Sincerely|Warmly|Love),?\\s*\\n\\s*(${CAP}(?:\\s+${CAP})?)\\s*(?:\\n|$)`, 'g'),
    group: 1,
    validate: (v) => looksLikeName(v),
  },
  {
    kind: 'name',
    rule: 'name:with',
    // "meeting with Priya Raman", "call Jonas Weber", "email from Ana Souza": two capitalised words after a people verb.
    re: new RegExp(`\\b(?:with|from|to|call|called|email|emailed|text|texted|ask|asked|tell|told|met|meet|cc|ping)\\s+(${CAP}\\s+${CAP})\\b`, 'g'),
    group: 1,
    validate: (v) => looksLikeName(v),
  },
];

// Group recognizers need capture offsets (`d`); every recognizer is global.
for (const r of RECOGNIZERS) if (r.group && !r.re.flags.includes('d')) r.re = new RegExp(r.re.source, `${r.re.flags}d`);

/** Higher wins when two findings overlap. */
const PRIORITY: Record<PiiKind, number> = { secret: 9, card: 8, iban: 7, gov_id: 6, email: 5, phone: 4, ip: 3, address: 2, name: 1 };

/** Finds personal data and secrets with the built-in recognizers. Overlaps are resolved by kind priority, then length. */
export function detectPii(text: string, opts: { kinds?: ReadonlySet<PiiKind>; allowList?: readonly string[] } = {}): PiiSpan[] {
  const found: PiiSpan[] = [];
  const allow = new Set((opts.allowList ?? []).map((s) => s.toLowerCase()));
  for (const r of RECOGNIZERS) {
    if (opts.kinds && !opts.kinds.has(r.kind)) continue;
    r.re.lastIndex = 0;
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      if (m[0].length === 0) { r.re.lastIndex++; continue; }
      const value = r.group ? m[r.group] : m[0];
      if (!value) continue;
      // `d` flag: exact offsets of the capture group.
      const s = r.group ? (m as RegExpExecArray & { indices: Array<[number, number]> }).indices[r.group]![0] : m.index;
      if (r.validate && !r.validate(value, text, s)) continue;
      if (allow.has(value.toLowerCase())) continue;
      found.push({ kind: r.kind, start: s, end: s + value.length, value, rule: r.rule });
    }
  }
  return resolveOverlaps(found);
}

export function resolveOverlaps(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: PiiSpan[] = [];
  for (const s of sorted) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}

// ---- Redaction -------------------------------------------------------------------------------------

const TAG: Record<PiiKind, string> = { email: 'EMAIL', phone: 'PHONE', card: 'CARD', iban: 'IBAN', gov_id: 'ID', secret: 'SECRET', address: 'ADDRESS', name: 'NAME', ip: 'IP' };
const TAGS = Object.values(TAG).join('|');
/** Placeholders as written, and the ASCII forms models sometimes normalise them to. */
const PLACEHOLDER_RE = new RegExp(`(?:⟦|\\[\\[?)(${TAGS})_(\\d{1,4})(?:⟧|\\]\\]?)`, 'g');

/** What the firewall did to one request (for the per-request redaction log; values are never logged). */
export interface RedactionReport {
  counts: Partial<Record<PiiKind, number>>;
  /** Kinds that the policy blocks and that were found (the call is then refused). */
  blocked: PiiKind[];
  rules: string[];
}

export class PrivacyBlockError extends Error {
  readonly code = 'policy_blocked';
  readonly reason = 'privacy' as const;
  constructor(readonly kinds: PiiKind[]) {
    super(`This request contains ${kinds.map((k) => KIND_PHRASE[k]).join(' and ')}, which your AI policy does not allow to leave this device. Remove it, or route this work to the device in Settings › AI › Routing & privacy.`);
    this.name = 'PolicyBlockedError';
  }
}

const KIND_PHRASE: Record<PiiKind, string> = {
  email: 'an email address', phone: 'a phone number', card: 'a payment card number', iban: 'a bank account number', gov_id: 'a government ID number',
  secret: 'an API key or password', address: 'a street address', name: 'a person’s name', ip: 'an IP address',
};

/**
 * One conversation's redactor. The same value always gets the same placeholder within a session,
 * so a multi-turn agent run stays coherent ("⟦EMAIL_1⟧" in turn 1 is still that person in turn 5),
 * and `rehydrate` can restore any placeholder the model writes back.
 */
export class Redactor {
  private byValue = new Map<string, string>();
  private byPlaceholder = new Map<string, string>();
  private next: Partial<Record<PiiKind, number>> = {};
  readonly report: RedactionReport = { counts: {}, blocked: [], rules: [] };
  private actions: Partial<Record<PiiKind, PrivacyAction>>;

  constructor(private policy: PrivacyPolicy, private names?: NameDetector) {
    this.actions = policy.mode === 'off' ? {} : policy.kinds;
  }

  /** Kinds this session looks for. */
  get activeKinds(): Set<PiiKind> {
    return new Set((Object.entries(this.actions) as Array<[PiiKind, PrivacyAction]>).filter(([, a]) => a !== 'allow').map(([k]) => k));
  }

  /** Replaces findings in `text`. Throws `PrivacyBlockError` when a blocked kind is present. */
  async redact(text: string): Promise<string> {
    const kinds = this.activeKinds;
    if (!kinds.size || !text) return text;
    let spans = detectPii(text, { kinds, allowList: this.policy.allowList });
    if (this.names && kinds.has('name')) {
      const extra = await this.names(text).catch(() => []);
      spans = resolveOverlaps([...spans, ...extra.map((e) => ({ kind: e.kind ?? 'name', start: e.start, end: e.end, value: text.slice(e.start, e.end), rule: 'name:model' }) as PiiSpan)]);
    }
    const blocked = [...new Set(spans.filter((s) => this.actions[s.kind] === 'block').map((s) => s.kind))];
    if (blocked.length) {
      for (const k of blocked) if (!this.report.blocked.includes(k)) this.report.blocked.push(k);
      throw new PrivacyBlockError(blocked);
    }
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + this.placeholderFor(s);
      at = s.end;
    }
    return out + text.slice(at);
  }

  private placeholderFor(s: PiiSpan): string {
    const key = `${s.kind}\u0000${s.value}`;
    let ph = this.byValue.get(key);
    if (!ph) {
      const n = (this.next[s.kind] = (this.next[s.kind] ?? 0) + 1);
      ph = `⟦${TAG[s.kind]}_${n}⟧`;
      this.byValue.set(key, ph);
      this.byPlaceholder.set(`${TAG[s.kind]}_${n}`, s.value);
    }
    this.report.counts[s.kind] = (this.report.counts[s.kind] ?? 0) + 1;
    if (!this.report.rules.includes(s.rule)) this.report.rules.push(s.rule);
    return ph;
  }

  /** Puts real values back where the model wrote placeholders. Unknown placeholders are left as written. */
  rehydrate(text: string): string {
    if (!this.byPlaceholder.size || !text) return text;
    return text.replace(PLACEHOLDER_RE, (m, tag: string, n: string) => this.byPlaceholder.get(`${tag}_${n}`) ?? m);
  }

  /** Rehydrates every string inside a JSON value (tool-call arguments). */
  rehydrateValue<T>(v: T): T {
    if (typeof v === 'string') return this.rehydrate(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.rehydrateValue(x)) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.rehydrateValue(x)])) as T;
    return v;
  }

  /**
   * A rehydrator for streamed text: placeholders can arrive split across deltas, so a possible
   * placeholder prefix at the end of a delta is held back until the next one (or `flush`).
   */
  streamRehydrator(): { push(delta: string): string; flush(): string } {
    let pending = '';
    return {
      push: (delta) => {
        const s = pending + delta;
        const cut = s.search(/(?:⟦|\[\[?)[A-Z_\d]*(?:⟧|\])?$/);
        if (cut >= 0 && s.length - cut <= 16) {
          pending = s.slice(cut);
          return this.rehydrate(s.slice(0, cut));
        }
        pending = '';
        return this.rehydrate(s);
      },
      flush: () => {
        const s = this.rehydrate(pending);
        pending = '';
        return s;
      },
    };
  }

  get redactedCount(): number {
    return Object.values(this.report.counts).reduce((a, b) => a + (b ?? 0), 0);
  }
}
