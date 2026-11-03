/**
 * The memory timeline's file format: what was on screen (and, optionally, said near the
 * microphone) as redacted text, kept in the vault so it is plain, inspectable and deletable.
 *
 *   recall/config.json                          RecallConfig (synced settings shared by devices)
 *   recall/<YYYY-MM-DD>/<HH>-<device>.jsonl     captures, one JSON object per line
 *
 * Day and hour are the capturing device's local time; every line also carries its exact epoch
 * time, so readers never depend on the folder name for ordering. One file per device per hour
 * keeps writes small (appending rewrites at most an hour of text) and means two devices never
 * write the same file. Only text is stored, never screenshots: personal data in text can be
 * redacted before it is written (packages/ai `redactCapture`), pixels cannot.
 *
 * docs/VAULT_FORMAT.md § Memory timeline and docs/MEMORY_TIMELINE.md describe it for people.
 */
import { dayKey, parseDayKey } from '../daily.ts';

export const RECALL_DIR = 'recall';
export const RECALL_CONFIG_PATH = 'recall/config.json';
export const RECALL_FORMAT_VERSION = 1;

export type CaptureKind = 'screen' | 'audio';

/** One moment: the text of the window in front (screen) or a stretch of speech (audio). */
export interface Capture {
  /** Unique id (`newId()`), so sync can merge files line by line. */
  id: string;
  /** When it was captured (screen) or when the speech started (audio), epoch ms. */
  at: number;
  /** End of the speech (audio), epoch ms. */
  end?: number;
  kind: CaptureKind;
  /** Application in front ("Terminal", "Firefox"), as the OS names it. */
  app?: string;
  /** Window title (redacted). */
  title?: string;
  /** Page address for browsers that report it: origin and path only, never query or fragment. */
  url?: string;
  /** Recognised text, redacted. Lines are kept (they are what search shows). */
  text: string;
  /** How many items of each kind of personal data were replaced (`{ email: 2 }`); never values. */
  redacted?: Record<string, number>;
  /** Which recognizer produced the text ("tesseract.js 7 · eng", "device:moonshine-base"). */
  engine?: string;
  /** Short id of the device that captured it. */
  device?: string;
}

/** Settings every device shares (synced with the vault). Capturing itself is switched on per device. */
export interface RecallConfig {
  formatVersion: 1;
  /** Captures older than this are deleted (by whichever device runs the app first). */
  retentionDays: number;
  /** Seconds between screen captures when the screen keeps changing (it slows down when it doesn't). */
  intervalSec: number;
  /** Applications never captured, by name or bundle id (case-insensitive, matched as a substring). */
  excludedApps: string[];
  /** Window titles never captured (case-insensitive substrings), e.g. "bank", "private". */
  excludedTitles: string[];
  /** Also transcribe the microphone, on this device only. */
  microphone: boolean;
  updatedAt: number;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  formatVersion: 1,
  retentionDays: 14,
  intervalSec: 20,
  excludedApps: [],
  excludedTitles: [],
  microphone: false,
  updatedAt: 0,
};

export const RETENTION_CHOICES = [1, 3, 7, 14, 30, 90] as const;

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean).slice(0, 200) : []);

/** Parses `recall/config.json`; anything missing or malformed falls back to the defaults. */
export function decodeRecallConfig(json: string | null): RecallConfig {
  if (!json) return { ...DEFAULT_RECALL_CONFIG };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_RECALL_CONFIG };
  }
  return {
    formatVersion: 1,
    retentionDays: clampInt(raw.retentionDays, 1, 3650, DEFAULT_RECALL_CONFIG.retentionDays),
    intervalSec: clampInt(raw.intervalSec, 5, 600, DEFAULT_RECALL_CONFIG.intervalSec),
    excludedApps: strings(raw.excludedApps),
    excludedTitles: strings(raw.excludedTitles),
    microphone: raw.microphone === true,
    updatedAt: clampInt(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function encodeRecallConfig(c: RecallConfig): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

// ---- Captures ------------------------------------------------------------------------------------

/** A device id usable in a file name. */
export function safeDeviceId(id: string): string {
  const s = id.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 24);
  return s || 'device';
}

/** `recall/<day>/<HH>-<device>.jsonl` for a capture taken at `at` (local time). */
export function capturePath(at: number, device: string): string {
  const d = new Date(at);
  return `${RECALL_DIR}/${dayKey(d)}/${String(d.getHours()).padStart(2, '0')}-${safeDeviceId(device)}.jsonl`;
}

/** The day folder of a capture file path, or null when the path isn't one. */
export function dayOfCapturePath(path: string): string | null {
  const m = /^recall\/(\d{4}-\d{2}-\d{2})\/\d{2}-[0-9A-Za-z_-]{1,24}\.jsonl$/.exec(path);
  return m && parseDayKey(m[1]!) ? m[1]! : null;
}

export const isCaptureFile = (path: string) => dayOfCapturePath(path) !== null;

function decodeCapture(v: unknown): Capture | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  if (o.kind !== 'screen' && o.kind !== 'audio') return null;
  const c: Capture = { id: o.id, at: o.at, kind: o.kind, text: typeof o.text === 'string' ? o.text : '' };
  if (typeof o.end === 'number' && Number.isFinite(o.end)) c.end = o.end;
  for (const k of ['app', 'title', 'url', 'engine', 'device'] as const) if (typeof o[k] === 'string' && o[k]) c[k] = o[k] as string;
  if (o.redacted && typeof o.redacted === 'object') {
    const r: Record<string, number> = {};
    for (const [k, n] of Object.entries(o.redacted as Record<string, unknown>)) if (typeof n === 'number' && n > 0) r[k] = n;
    if (Object.keys(r).length) c.redacted = r;
  }
  return c;
}

/** Parses a capture file. Malformed lines are skipped (a torn write never hides the rest). */
export function decodeCaptures(text: string): Capture[] {
  const out: Capture[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = decodeCapture(JSON.parse(line));
      if (c) out.push(c);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function encodeCaptures(cs: readonly Capture[]): string {
  return cs.map((c) => JSON.stringify(c)).join('\n') + (cs.length ? '\n' : '');
}

/** Sorts by time, then id (stable across devices). */
export function sortCaptures<C extends Pick<Capture, 'at' | 'id'>>(cs: C[]): C[] {
  return cs.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- Erasure records -----------------------------------------------------------------------------

/**
 * A record that moments were erased, kept in `recall/erased-<device>.jsonl` (one per line, each
 * device appending only to its own file).
 *
 * Why records and not just deleting files: sync lets an edit beat a deletion (it never loses
 * content), so when one device erases a day while another is still appending to that hour's
 * file, the appending device's copy would bring the erased moments back. Readers therefore hide
 * every capture a record covers, and pruning removes such resurrected lines for good. A record
 * expires with the retention period: by then everything it covers is past retention anyway.
 */
export interface Erasure {
  /** When it was erased (epoch ms). */
  at: number;
  /** Erased moments, by id… */
  ids?: string[];
  /** …or every moment captured in `[from, to)` (a day, or everything up to the erase). */
  from?: number;
  to?: number;
}

export const erasurePath = (device: string) => `${RECALL_DIR}/erased-${safeDeviceId(device)}.jsonl`;
export const isErasureFile = (path: string) => /^recall\/erased-[0-9A-Za-z_-]{1,24}\.jsonl$/.test(path);

/** Parses an erasure file; malformed lines are skipped. */
export function decodeErasures(text: string): Erasure[] {
  const out: Erasure[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.at !== 'number' || !Number.isFinite(o.at)) continue;
      const e: Erasure = { at: o.at };
      if (Array.isArray(o.ids)) e.ids = o.ids.filter((x): x is string => typeof x === 'string' && !!x);
      if (typeof o.from === 'number' && typeof o.to === 'number' && Number.isFinite(o.from) && Number.isFinite(o.to) && o.from < o.to) {
        e.from = o.from;
        e.to = o.to;
      }
      if (e.ids?.length || e.from !== undefined) out.push(e);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function encodeErasures(es: readonly Erasure[]): string {
  return es.map((e) => JSON.stringify(e)).join('\n') + (es.length ? '\n' : '');
}

/** The erasure records of every device, as one test: is this capture erased? */
export class Erasures {
  private ids = new Set<string>();
  private ranges: Array<[number, number]> = [];

  constructor(records: readonly Erasure[] = []) {
    for (const e of records) {
      for (const id of e.ids ?? []) this.ids.add(id);
      if (e.from !== undefined && e.to !== undefined) this.ranges.push([e.from, e.to]);
    }
  }

  get empty(): boolean {
    return this.ids.size === 0 && this.ranges.length === 0;
  }

  covers(c: Pick<Capture, 'id' | 'at'>): boolean {
    return this.ids.has(c.id) || this.ranges.some(([from, to]) => c.at >= from && c.at < to);
  }
}

/** Local midnight of the day `at` falls on, and of the next day. */
export function dayBounds(day: string): { from: number; to: number } | null {
  const d = parseDayKey(day);
  if (!d) return null;
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return { from: d.getTime(), to: next.getTime() };
}

/** Captures grouped by local hour (0–23) for the timeline's hour strip. */
export function capturesByHour(cs: readonly Capture[]): Map<number, Capture[]> {
  const m = new Map<number, Capture[]>();
  for (const c of cs) {
    const h = new Date(c.at).getHours();
    let list = m.get(h);
    if (!list) m.set(h, (list = []));
    list.push(c);
  }
  return m;
}
