import type { GroupShape } from './segment.ts';
import type { RawCandidate, SymbolCandidate } from './types.ts';

/**
 * The maths alphabet and how recognizer output maps onto it.
 *
 * Text recognizers answer in text: ML Kit's English model reads a lone "+" as "t" now and then,
 * "×" as "x" or "X", "0" as "o", "1" as "l" or "|", "√" as "V", "π" as "TT" or "n". Rather than
 * trusting the top answer, every answer expands into the maths symbols it could stand for, each
 * with a weight; the decoder (decode.ts) then picks the reading that is also valid maths.
 */

export const DIGITS = '0123456789';
export const OPERATORS = new Set(['+', '-', '×', '÷', '·', '/', '=', '^']);
/** Letters people use as variables, most common first; others are allowed but less likely. */
export const COMMON_VARIABLES = 'xyzabcnktmpqrsuvw';

/** Text → maths symbols it may mean, with how plausible each reading is (1 = certainly). */
const ALIASES: Record<string, [string, number][]> = {
  '−': [['-', 1]], '–': [['-', 1]], '—': [['-', 0.95]], '_': [['-', 0.8]], '~': [['-', 0.6]], '‐': [['-', 1]], '¯': [['-', 0.8]],
  '*': [['×', 0.9]], '✕': [['×', 1]], '✖': [['×', 1]], '⨯': [['×', 1]],
  x: [['x', 1], ['×', 0.55]], X: [['x', 0.75], ['×', 0.65]], '×': [['×', 1], ['x', 0.6]],
  '+': [['+', 1]], t: [['+', 0.7], ['t', 0.55]], T: [['+', 0.45], ['π', 0.35]], f: [['f', 0.4], ['+', 0.35]], '†': [['+', 0.8]], '±': [['+', 0.3]],
  ':': [['÷', 0.75]], '÷': [['÷', 1]],
  '·': [['·', 1]], '•': [['·', 1]], '∙': [['·', 1]], '⋅': [['·', 1]], '.': [['.', 1], ['·', 0.8]], ',': [[',', 1], ['.', 0.5]], "'": [['·', 0.4], [',', 0.3]], '`': [['·', 0.4]],
  '=': [['=', 1]], '≡': [['=', 0.8]], '二': [['=', 0.9]], '〓': [['=', 0.6]],
  '(': [['(', 1]], '[': [['(', 0.8]], '{': [['(', 0.7]], C: [['(', 0.45], ['C', 0.2]], c: [['c', 0.6], ['(', 0.35]], '<': [['<', 0.5], ['(', 0.4]], '‹': [['(', 0.5]],
  ')': [[')', 1]], ']': [[')', 0.8]], '}': [[')', 0.7]], '>': [['>', 0.5], [')', 0.4]], '›': [[')', 0.5]], J: [[')', 0.25], ['√', 0.2]],
  '1': [['1', 1]], l: [['1', 0.9]], I: [['1', 0.85]], '|': [['1', 0.9]], i: [['1', 0.3], ['i', 0.4]], '!': [['!', 0.8], ['1', 0.3]], '/': [['/', 1], ['1', 0.4]], '\\': [['1', 0.2]],
  '0': [['0', 1]], o: [['0', 0.9], ['o', 0.15]], O: [['0', 0.9]], D: [['0', 0.4]], Q: [['0', 0.4]], '°': [['0', 0.4]],
  '5': [['5', 1]], s: [['5', 0.6], ['s', 0.45]], S: [['5', 0.8], ['s', 0.2]], $: [['5', 0.6]],
  '2': [['2', 1]], z: [['2', 0.6], ['z', 0.6]], Z: [['2', 0.8], ['z', 0.4]],
  '9': [['9', 1]], g: [['9', 0.6], ['g', 0.35]], q: [['9', 0.55], ['q', 0.35]],
  '6': [['6', 1]], b: [['6', 0.55], ['b', 0.5]], G: [['6', 0.6]],
  '8': [['8', 1]], B: [['8', 0.7]], '&': [['8', 0.5]],
  '4': [['4', 1]], A: [['4', 0.35]], y: [['y', 1], ['4', 0.1]], h: [['h', 0.6], ['4', 0.2]],
  '7': [['7', 1]], '3': [['3', 1]],
  V: [['√', 0.6], ['v', 0.3]], v: [['v', 0.7], ['√', 0.5]], '✓': [['√', 0.9]], '✔': [['√', 0.9]], '√': [['√', 1]],
  π: [['π', 1]], Π: [['π', 0.9]], TT: [['π', 0.85]], n: [['n', 0.8], ['π', 0.25]], Tt: [['π', 0.6]], tt: [['π', 0.5]], '11': [['π', 0.2]],
  '^': [['^', 1]], '%': [['%', 1]],
};

/** Every label the decoder may produce: maths symbols, digits and Latin letters. */
export function isKnownLabel(label: string): boolean {
  return label.length === 1 && (/[0-9a-zA-Z]/.test(label) || '+-×÷·=().,/^%!√π<>'.includes(label));
}

/** One text (possibly several characters) → its symbol readings. Multi-character texts stay sequences. */
export function aliasesOf(text: string): [string, number][] {
  const t = text.replace(/\s+/g, '');
  if (!t) return [];
  const direct = ALIASES[t];
  if (direct) return direct;
  if ([...t].length === 1) return isKnownLabel(t) ? [[t, /[a-z]/.test(t) ? 1 : 0.8]] : [];
  // Several characters: the group probably holds several symbols ("12"); map each character to
  // its best reading and keep the sequence (the decoder splits it).
  const chars = [...t].map((c) => ALIASES[c]?.[0]?.[0] ?? (isKnownLabel(c) ? c : null));
  if (chars.some((c) => c == null)) return [];
  return [[chars.join(''), 0.9]];
}

/**
 * An engine's ranked answers → weighted symbol candidates. Weights combine rank (always
 * meaningful) with the engine's scores when it gives them (ML Kit: lower = likelier, unknown
 * scale; so a softmax of the negated differences, mixed with a rank prior so a strange scale
 * can't make the ranking meaningless).
 */
export function fromRanked(raw: readonly RawCandidate[]): SymbolCandidate[] {
  if (!raw.length) return [];
  const scored = raw.every((r) => typeof r.score === 'number' && Number.isFinite(r.score));
  const rankPrior = raw.map((_, i) => 0.62 * Math.pow(0.45, i));
  let w = rankPrior;
  if (scored) {
    const s0 = raw[0]!.score as number;
    const soft = raw.map((r) => Math.exp(-Math.max(0, (r.score as number) - s0)));
    const total = soft.reduce((a, b) => a + b, 0);
    w = raw.map((_, i) => 0.5 * rankPrior[i]! + 0.5 * (soft[i]! / total) * 0.95);
  }
  const out = new Map<string, number>();
  raw.forEach((r, i) => {
    for (const [label, f] of aliasesOf(r.text)) {
      // Readings of the same symbol add up (noisy-OR), so "x" then "X" both support x.
      const prev = out.get(label) ?? 0;
      out.set(label, 1 - (1 - prev) * (1 - w[i]! * f));
    }
  });
  return [...out.entries()].map(([label, p]) => ({ label, p })).sort((a, b) => b.p - a.p);
}

/** What the geometry alone says a group is. */
const SHAPE_CANDS: Partial<Record<GroupShape, { cands: SymbolCandidate[]; trust: number }>> = {
  dot: { cands: [{ label: '.', p: 0.9 }, { label: '·', p: 0.85 }], trust: 0.9 },
  hline: { cands: [{ label: '-', p: 0.95 }], trust: 0.85 },
  equals: { cands: [{ label: '=', p: 0.97 }], trust: 0.9 },
  divide: { cands: [{ label: '÷', p: 0.95 }], trust: 0.9 },
  radical: { cands: [{ label: '√', p: 0.95 }], trust: 0.85 },
  plus: { cands: [{ label: '+', p: 0.9 }], trust: 0.6 },
  cross: { cands: [{ label: 'x', p: 0.75 }, { label: '×', p: 0.75 }], trust: 0.55 },
  vline: { cands: [{ label: '1', p: 0.85 }], trust: 0.4 },
  slash: { cands: [{ label: '/', p: 0.6 }, { label: '1', p: 0.5 }], trust: 0.3 },
};

/** Merges a recognizer's candidates with what the group's geometry says. */
export function fuseWithShape(cands: SymbolCandidate[], shape: GroupShape | undefined): SymbolCandidate[] {
  const geo = shape ? SHAPE_CANDS[shape] : undefined;
  if (!geo) return cands;
  const out = new Map<string, number>();
  for (const c of cands) out.set(c.label, c.p * (1 - geo.trust));
  for (const c of geo.cands) out.set(c.label, (out.get(c.label) ?? 0) + c.p * geo.trust);
  return [...out.entries()].map(([label, p]) => ({ label, p: Math.min(1, p) })).sort((a, b) => b.p - a.p);
}
