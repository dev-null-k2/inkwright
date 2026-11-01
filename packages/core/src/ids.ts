import type { InkPoint } from './model.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Time-sortable unique ids: 10 chars of millisecond timestamp + 12 chars of randomness in
 * Crockford base32 (22 chars, path-safe). Sorting ids sorts by creation time.
 */
export function newId(now: number = Date.now(), random: () => number = defaultRandom): string {
  let out = '';
  let t = Math.max(0, Math.floor(now));
  const time: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ALPHABET[t % 32]!;
    t = Math.floor(t / 32);
  }
  out += time.join('');
  for (let i = 0; i < 12; i++) out += ALPHABET[Math.floor(random() * 32) & 31];
  return out;
}

function defaultRandom(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const b = new Uint32Array(1);
    c.getRandomValues(b);
    return b[0]! / 0x1_0000_0000;
  }
  return Math.random();
}

const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** Ids become path segments; refuse anything that could escape the vault. */
export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function requireSafeId(id: string): string {
  if (!isSafeId(id)) throw new Error(`Unsafe id: ${id}`);
  return id;
}

/**
 * Makes stored points safe for an ink engine: drops non-finite values and exact repeats, and
 * forces timestamps to be non-negative and non-decreasing (real devices emit both).
 */
export function sanitizePoints(points: InkPoint[]): InkPoint[] {
  const out: InkPoint[] = [];
  let lastT = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const t = Math.max(lastT, Number.isFinite(p.t) ? p.t : lastT, 0);
    const prev = out[out.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) continue;
    out.push(t === p.t ? p : { ...p, t });
    lastT = t;
  }
  return out;
}

// ---- Colors ---------------------------------------------------------------------------------

/** Parses `#AARRGGBB` / `#RRGGBB` into an unsigned ARGB number. Invalid input → opaque black. */
export function parseArgb(hex: string): number {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]+$/.test(clean)) return 0xff000000;
  if (clean.length === 8) return parseInt(clean, 16) >>> 0;
  if (clean.length === 6) return (0xff000000 | parseInt(clean, 16)) >>> 0;
  return 0xff000000;
}

export function formatArgb(argb: number): string {
  return '#' + (argb >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** `#AARRGGBB` → CSS `rgba(...)`, optionally multiplying alpha. */
export function argbToCss(hex: string, alphaMul = 1): string {
  const v = parseArgb(hex);
  const a = ((v >>> 24) & 255) / 255;
  const r = (v >>> 16) & 255;
  const g = (v >>> 8) & 255;
  const b = v & 255;
  return `rgba(${r},${g},${b},${+(a * alphaMul).toFixed(3)})`;
}

/** `#AARRGGBB` → `#RRGGBB` (for SVG fill) plus opacity. */
export function argbToHexOpacity(hex: string): { rgb: string; opacity: number } {
  const v = parseArgb(hex);
  return { rgb: '#' + (v & 0xffffff).toString(16).padStart(6, '0'), opacity: ((v >>> 24) & 255) / 255 };
}

/** CSS `#RRGGBB`/`#RRGGBBAA` → `#AARRGGBB`. */
export function cssHexToArgb(css: string): string {
  const c = css.replace('#', '');
  if (c.length === 6) return ('#FF' + c).toUpperCase();
  if (c.length === 8) return ('#' + c.slice(6) + c.slice(0, 6)).toUpperCase();
  return '#FF000000';
}
