import type { LayoutRow, MathSymbol } from './types.ts';

/**
 * The decoder: picks one label per symbol so that the whole reading is valid maths and as likely
 * as possible. A beam search over the symbols in reading order, scored by
 *   Σ log(candidate weight) + label prior + small grammar costs,
 * where invalid sequences (an operator after an operator, ")" with nothing open, "." not between
 * digits, two "=" in one line…) are dropped outright. This is where context resolves what shape
 * alone cannot: "2x3" is 2 × 3 but "2x+1" has a variable; "l" between digits is a 1; a "t" between
 * two numbers is a plus.
 */

type Struct = 'sup' | 'sub' | 'frac-num' | 'frac-den' | 'sqrt';

type Slot =
  | { k: 'sym'; sym: MathSymbol }
  | { k: 'open'; s: Struct }
  | { k: 'close'; s: Struct }
  | { k: 'newline' };

/** Reading order of a parsed page: symbols with structure markers between them. */
export function linearize(lines: readonly LayoutRow[]): Slot[] {
  const out: Slot[] = [];
  const row = (r: LayoutRow) => {
    for (const n of r.items) {
      if (n.k === 'sym') out.push({ k: 'sym', sym: n.sym });
      else if (n.k === 'frac') {
        out.push({ k: 'open', s: 'frac-num' }); row(n.num); out.push({ k: 'close', s: 'frac-num' });
        out.push({ k: 'open', s: 'frac-den' }); row(n.den); out.push({ k: 'close', s: 'frac-den' });
      } else {
        out.push({ k: 'open', s: 'sqrt' }); row(n.body); out.push({ k: 'close', s: 'sqrt' });
      }
      if (n.k === 'sym' && n.sub) { out.push({ k: 'open', s: 'sub' }); row(n.sub); out.push({ k: 'close', s: 'sub' }); }
      if (n.sup) { out.push({ k: 'open', s: 'sup' }); row(n.sup); out.push({ k: 'close', s: 'sup' }); }
    }
  };
  lines.forEach((l, i) => { if (i) out.push({ k: 'newline' }); row(l); });
  return out;
}

/** Token of the decoded reading. */
export type Tok = { t: 'sym'; v: string; symId?: string } | { t: 'open'; s: Struct } | { t: 'close'; s: Struct } | { t: 'newline' };

type Prev = 'start' | 'operand' | 'binop' | 'unary' | 'open' | 'eq' | 'dot';

interface Beam {
  score: number;
  toks: Tok[];
  prev: Prev;
  /** Last symbol class, for implicit multiplication and number building. */
  last: 'digit' | 'letter' | 'close' | 'const' | 'other' | 'none';
  hasDot: boolean;
  stack: string[];
  eqs: number;
  letters: string;
  /** Sum of log weights of chosen candidates and how many (for confidence). */
  logp: number;
  n: number;
  weakest: number;
}

const FUNCTIONS = ['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'sqrt', 'abs'];
const COMMON = 'xyzabcnktm';

function prior(label: string): number {
  if (/^[0-9]$/.test(label)) return 0;
  if (label === 'x' || label === 'y') return -0.15;
  if (/^[a-z]$/.test(label)) return COMMON.includes(label) ? -0.6 : -1.6;
  if (/^[A-Z]$/.test(label)) return -2.2;
  if (label === '%' || label === '!' || label === '^' || label === ',') return -1;
  if (label === '<' || label === '>') return -3;
  return 0;
}

/** Applies one label to a beam; null when the grammar forbids it. */
function step(b: Beam, label: string, symId: string | undefined, logw: number): Beam | null {
  const n: Beam = { ...b, toks: b.toks, stack: b.stack };
  let cost = logw + prior(label);
  const operandBefore = b.prev === 'operand';
  const endLetters = () => {
    if (n.letters.length >= 2) cost += FUNCTIONS.includes(n.letters) ? 1.2 : -0.35 * (n.letters.length - 1);
    n.letters = '';
  };
  if (/^[0-9]$/.test(label)) {
    if (b.prev === 'dot') { n.prev = 'operand'; n.last = 'digit'; }
    else {
      if (operandBefore && b.last !== 'digit') cost -= b.last === 'letter' ? 1.6 : 0.8; // "x2", ")2" are unusual
      if (operandBefore && b.last === 'digit' && b.letters) cost -= 0;
      if (!(operandBefore && b.last === 'digit')) n.hasDot = false;
      n.prev = 'operand'; n.last = 'digit';
    }
    endLetters();
  } else if (label === '.' || label === ',') {
    if (!(operandBefore && b.last === 'digit') || b.hasDot) return null;
    if (label === ',') cost -= 0.6;
    n.prev = 'dot'; n.hasDot = true; n.last = 'other';
    endLetters();
  } else if (/^[a-zA-Z]$/.test(label)) {
    if (b.prev === 'dot') return null;
    if (operandBefore && b.last === 'close') cost -= 0.3;
    if (b.last === 'letter') n.letters = b.letters + label; else { endLetters(); n.letters = label; }
    n.prev = 'operand'; n.last = 'letter';
  } else if (label === 'π') {
    if (b.prev === 'dot') return null;
    endLetters();
    n.prev = 'operand'; n.last = 'const';
  } else if (label === '+' || label === '-') {
    if (b.prev === 'dot') return null;
    if (!operandBefore) {
      if (b.prev === 'unary') return null;
      if (label === '+') cost -= 1.2;
      // "3×-5" is legal but rare; "3x-5" is what people write.
      if (b.prev === 'binop') cost -= 1.0;
      n.prev = 'unary';
    } else n.prev = 'binop';
    endLetters();
    n.last = 'other';
  } else if (label === '×' || label === '÷' || label === '·' || label === '/' || label === '^') {
    if (!operandBefore) return null;
    endLetters();
    n.prev = 'binop'; n.last = 'other';
  } else if (label === '=') {
    if (!operandBefore || b.stack.length || b.eqs >= 1) return null;
    endLetters();
    n.eqs = b.eqs + 1; n.prev = 'eq'; n.last = 'other';
  } else if (label === '(') {
    if (b.prev === 'dot') return null;
    if (operandBefore && b.last === 'letter' && !FUNCTIONS.includes(b.letters)) cost -= 0.1;
    endLetters();
    n.stack = [...b.stack, '(']; n.prev = 'open'; n.last = 'other';
  } else if (label === ')') {
    if (!operandBefore || b.stack[b.stack.length - 1] !== '(') return null;
    endLetters();
    n.stack = b.stack.slice(0, -1); n.prev = 'operand'; n.last = 'close';
  } else if (label === '!' || label === '%') {
    if (!operandBefore) return null;
    endLetters();
    n.prev = 'operand'; n.last = 'close';
  } else if (label === '√') {
    if (b.prev === 'dot') return null;
    endLetters();
    n.prev = 'unary'; n.last = 'other';
  } else return null;
  n.score = b.score + cost;
  n.logp = b.logp + logw;
  n.n = b.n + 1;
  n.weakest = Math.min(b.weakest, Math.exp(logw));
  n.toks = [...b.toks, { t: 'sym', v: label, symId }];
  return n;
}

function structural(b: Beam, slot: Exclude<Slot, { k: 'sym' }>): Beam | null {
  const n: Beam = { ...b };
  if (slot.k === 'newline') {
    if (b.stack.length || !(b.prev === 'operand' || b.prev === 'eq')) return null;
    if (b.letters.length >= 2) n.score += FUNCTIONS.includes(b.letters) ? 1.2 : -0.35 * (b.letters.length - 1);
    Object.assign(n, { prev: 'start', last: 'none', eqs: 0, letters: '', hasDot: false });
    n.toks = [...b.toks, { t: 'newline' }];
    return n;
  }
  if (slot.k === 'open') {
    if (slot.s === 'sup' || slot.s === 'sub') { if (b.prev !== 'operand') return null; }
    else if (b.prev === 'dot') return null;
    if (b.letters.length >= 2 && slot.s !== 'sub') n.score += FUNCTIONS.includes(b.letters) ? 1.2 : -0.35 * (b.letters.length - 1);
    Object.assign(n, { stack: [...b.stack, slot.s], prev: 'open', last: 'none', letters: slot.s === 'sub' ? b.letters : '', hasDot: false });
    n.toks = [...b.toks, { t: 'open', s: slot.s }];
    return n;
  }
  if (b.stack[b.stack.length - 1] !== slot.s || b.prev !== 'operand') return null;
  if (b.letters.length >= 2) n.score += FUNCTIONS.includes(b.letters) ? 1.2 : -0.35 * (b.letters.length - 1);
  Object.assign(n, { stack: b.stack.slice(0, -1), prev: 'operand', last: 'close', letters: '', hasDot: false });
  if (slot.s === 'frac-num') n.prev = 'binop'; // the denominator must follow
  n.toks = [...b.toks, { t: 'close', s: slot.s }];
  return n;
}

export interface Decoded {
  toks: Tok[];
  confidence: number;
  weakest: number;
}

/** The most likely valid reading, or null when no choice of labels makes valid maths. */
export function decode(slots: readonly Slot[], width = 96): Decoded | null {
  let beams: Beam[] = [{ score: 0, toks: [], prev: 'start', last: 'none', hasDot: false, stack: [], eqs: 0, letters: '', logp: 0, n: 0, weakest: 1 }];
  for (const slot of slots) {
    const next: Beam[] = [];
    for (const b of beams) {
      if (slot.k !== 'sym') { const n = structural(b, slot); if (n) next.push(n); continue; }
      for (const c of slot.sym.cands.slice(0, 8)) {
        const chars = [...c.label];
        const logw = Math.log(Math.max(1e-4, c.p));
        let cur: Beam | null = b;
        // A multi-character reading of one group ("12") is a sequence; its weight counts once.
        chars.forEach((ch, i) => { if (cur) cur = step(cur, ch, slot.sym.id, i === 0 ? logw : 0); });
        if (cur) next.push(cur);
      }
    }
    if (!next.length) return null;
    // Keep distinct readings only (the same labels via different candidate routes collapse).
    const seen = new Set<string>();
    beams = next.sort((a, b) => b.score - a.score).filter((b) => {
      const key = b.toks.map((t) => (t.t === 'sym' ? t.v : t.t === 'newline' ? '\n' : `${t.t}${t.s}`)).join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, width);
  }
  const done = beams
    .filter((b) => !b.stack.length && (b.prev === 'operand' || b.prev === 'eq'))
    .map((b) => ({ b, s: b.score + (b.letters.length >= 2 ? (FUNCTIONS.includes(b.letters) ? 1.2 : -0.35 * (b.letters.length - 1)) : 0) + systemConsistency(b.toks) }))
    .sort((a, b) => b.s - a.s);
  const best = done[0]?.b;
  if (!best) return null;
  return { toks: best.toks, confidence: best.n ? Math.exp(best.logp / best.n) : 0, weakest: best.weakest };
}

/**
 * Equations written one under the other are a system in the same unknowns: a reading where one
 * line has x and y but the next only y is likelier a misread letter than a different problem.
 */
function systemConsistency(toks: readonly Tok[]): number {
  const lines: Set<string>[] = [new Set()];
  let eqs = 0, withEq = 0;
  for (const t of toks) {
    if (t.t === 'newline') { if (eqs) withEq++; eqs = 0; lines.push(new Set()); continue; }
    if (t.t === 'sym' && /^[a-z]$/.test(t.v)) lines[lines.length - 1]!.add(t.v);
    if (t.t === 'sym' && t.v === '=') eqs++;
  }
  if (eqs) withEq++;
  if (lines.length < 2 || withEq < lines.length) return 0;
  const all = new Set(lines.flatMap((l) => [...l]));
  let missing = 0;
  for (const l of lines) for (const v of all) if (!l.has(v)) missing++;
  return -1.5 * missing;
}

// ---- Output ------------------------------------------------------------------------------------------

const PLAIN: Record<string, string> = { '×': '*', '·': '*', '÷': '/', 'π': 'pi', '√': 'sqrt ' };
const LATEX: Record<string, string> = { '×': '\\times ', '·': '\\cdot ', '÷': '\\div ', 'π': '\\pi ', '√': '\\sqrt ', '%': '\\%' };

/** Splits a token list into nested groups so structures can be printed recursively. */
function readGroup(toks: Tok[], i: number, until?: Struct): [Tok[], number] {
  const out: Tok[] = [];
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.t === 'close' && t.s === until) return [out, i + 1];
    out.push(t);
    i++;
  }
  return [out, i];
}

/** ASCII the solver parses: "2*x+3=7", "(1)/(2)", "x^(2)", "sqrt(16)". */
export function toPlain(toks: Tok[]): string {
  return printPlain(toks).replace(/\n+$/, '');
}

function isAtom(s: string) { return /^[0-9.]+$/.test(s) || /^[a-zA-Z]$/.test(s) || s === 'pi'; }

function printPlain(toks: Tok[]): string {
  let out = '';
  let prevKind: 'digit' | 'letter' | 'operand' | 'other' = 'other';
  for (let i = 0; i < toks.length;) {
    const t = toks[i]!;
    if (t.t === 'newline') { out += '\n'; prevKind = 'other'; i++; continue; }
    if (t.t === 'sym') {
      const v = t.v;
      if (/^[0-9]$/.test(v) && prevKind === 'letter') out += '*';
      if (v === '%') { out += '%'; prevKind = 'operand'; i++; continue; }
      if ((v === 'π' || v === '√') && (prevKind === 'digit' || prevKind === 'letter' || prevKind === 'operand')) out += '*';
      out += PLAIN[v] ?? (v === '-' ? '-' : v);
      prevKind = /^[0-9.]$/.test(v) ? 'digit' : /^[a-zA-Z]$/.test(v) ? 'letter' : v === ')' || v === 'π' || v === '!' ? 'operand' : 'other';
      i++;
      continue;
    }
    if (t.t === 'open') {
      if (t.s === 'frac-num') {
        const [num, j] = readGroup(toks, i + 1, 'frac-num');
        const [den, k] = readGroup(toks, j + 1, 'frac-den');
        const a = printPlain(num), b = printPlain(den);
        const frac = `${isAtom(a) ? a : `(${a})`}/${isAtom(b) ? b : `(${b})`}`;
        const next = toks[k];
        const wrap = prevKind !== 'other' || (next?.t === 'open' && next.s === 'sup') || (next?.t === 'sym' && /^[0-9a-zA-Z(π]$/.test(next.v));
        if (prevKind !== 'other') out += '*';
        out += wrap ? `(${frac})` : frac;
        prevKind = 'operand';
        i = k;
        continue;
      }
      const [inner, j] = readGroup(toks, i + 1, t.s);
      const body = printPlain(inner);
      if (t.s === 'sup') out += /^[0-9]$|^[a-z]$/.test(body) ? `^${body}` : `^(${body})`;
      else if (t.s === 'sub') out += /^[0-9a-z]+$/.test(body) ? body : `_(${body})`;
      else { if (prevKind !== 'other') out += '*'; out += `sqrt(${body})`; }
      prevKind = 'operand';
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

export function toLatex(toks: Tok[]): string {
  return printLatex(toks).replace(/\s+/g, ' ').replace(/\s*\\\\\s*$/, '').trim();
}

function printLatex(toks: Tok[]): string {
  let out = '';
  for (let i = 0; i < toks.length;) {
    const t = toks[i]!;
    if (t.t === 'newline') { out += ' \\\\ '; i++; continue; }
    if (t.t === 'sym') { out += LATEX[t.v] ?? t.v; i++; continue; }
    if (t.t === 'open') {
      if (t.s === 'frac-num') {
        const [num, j] = readGroup(toks, i + 1, 'frac-num');
        const [den, k] = readGroup(toks, j + 1, 'frac-den');
        out += `\\frac{${printLatex(num)}}{${printLatex(den)}}`;
        i = k;
        continue;
      }
      const [inner, j] = readGroup(toks, i + 1, t.s);
      const body = printLatex(inner);
      out += t.s === 'sup' ? `^{${body}}` : t.s === 'sub' ? `_{${body}}` : `\\sqrt{${body}}`;
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

export type { Slot };
