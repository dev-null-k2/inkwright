import type { MathNode } from '@inkwright/core';

/**
 * Worked steps, computed — not generated. Exact rational arithmetic (BigInt fractions) over the
 * parsed problem, so "1/2 + 1/3" shows the common denominator and ends at 5/6, not 0.8333.
 * Covers what school maths writes most: arithmetic with the order of operations, fractions,
 * integer powers, linear and quadratic equations in one unknown, and 2 × 2 linear systems.
 * Anything else returns null and the solver answers without steps.
 */

// ---- Exact rationals --------------------------------------------------------------------------------

const babs = (a: bigint) => (a < 0n ? -a : a);
function gcd(a: bigint, b: bigint): bigint { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a || 1n; }

export class Q {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new RangeError('Division by zero');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  static of(v: number): Q | null {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return Number.isSafeInteger(v) ? new Q(BigInt(v)) : null;
    const s = String(v);
    if (/e/i.test(s)) return null;
    const [i, f = ''] = s.split('.');
    return new Q(BigInt(`${i}${f}`.replace('-', '')) * (v < 0 ? -1n : 1n), 10n ** BigInt(f.length));
  }
  add(o: Q) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Q) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Q) { return new Q(this.n * o.n, this.d * o.d); }
  div(o: Q) { return new Q(this.n * o.d, this.d * o.n); }
  neg() { return new Q(-this.n, this.d); }
  pow(k: number): Q | null {
    if (!Number.isInteger(k) || Math.abs(k) > 64) return null;
    const p = (b: bigint) => b ** BigInt(Math.abs(k));
    return k >= 0 ? new Q(p(this.n), p(this.d)) : new Q(p(this.d), p(this.n));
  }
  /** Exact square root when numerator and denominator are perfect squares. */
  sqrt(): Q | null {
    if (this.n < 0n) return null;
    const r = (x: bigint) => { const s = BigInt(Math.round(Math.sqrt(Number(x)))); return s * s === x ? s : null; };
    const a = r(this.n), b = r(this.d);
    return a != null && b != null ? new Q(a, b) : null;
  }
  isInt() { return this.d === 1n; }
  isZero() { return this.n === 0n; }
  sign() { return this.n < 0n ? -1 : this.n > 0n ? 1 : 0; }
  value() { return Number(this.n) / Number(this.d); }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
}

const show = (q: Q) => q.toString().replace(/^-/, '−');
const tooBig = (q: Q) => babs(q.n) > 10n ** 15n || q.d > 10n ** 12n;

// ---- Arithmetic, step by step ----------------------------------------------------------------------

type E = { t: 'q'; q: Q; frac?: boolean } | { t: 'op'; op: '+' | '-' | '*' | '/' | '^'; a: E; b: E } | { t: 'neg'; a: E } | { t: 'sqrt'; a: E };

/** The problem as an exact expression, or null if it has variables, functions or inexact parts. */
function toE(n: MathNode): E | null {
  switch (n.t) {
    case 'num': { const q = Q.of(n.v); return q ? { t: 'q', q } : null; }
    case 'neg': { const a = toE(n.a); return a && { t: 'neg', a }; }
    case 'bin': { const a = toE(n.a), b = toE(n.b); return a && b && { t: 'op', op: n.op, a, b }; }
    case 'call': { if (n.fn !== 'sqrt' || n.args.length !== 1) return null; const a = toE(n.args[0]!); return a && { t: 'sqrt', a }; }
    default: return null;
  }
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
const SYM: Record<string, string> = { '+': '+', '-': '−', '*': '×', '/': '÷', '^': '^' };

function fmt(e: E, parent = 0, right = false): string {
  if (e.t === 'q') {
    const s = show(e.q);
    return (e.q.d !== 1n || e.q.sign() < 0) && parent > 0 ? `(${s})` : s;
  }
  if (e.t === 'neg') return parent > 1 ? `(−${fmt(e.a, 3)})` : `−${fmt(e.a, 3)}`;
  if (e.t === 'sqrt') return `√${e.a.t === 'q' && e.a.q.isInt() && e.a.q.sign() >= 0 ? fmt(e.a, 4) : `(${fmt(e.a)})`}`;
  const p = PREC[e.op]!;
  const s = `${fmt(e.a, p)} ${SYM[e.op]} ${fmt(e.b, p, true)}`;
  return p < parent || (p === parent && right && e.op !== '^') ? `(${s})` : s;
}

const VERB: Record<string, string> = { '+': 'Add', '-': 'Subtract', '*': 'Multiply', '/': 'Divide', '^': 'Power' };

/** One reduction (the highest-precedence ready operation, leftmost), with a description. */
function reduce(e: E): { e: E; note: string } | null {
  type Ready = { path: (E)[]; node: E; prec: number };
  const ready: Ready[] = [];
  const walk = (n: E, path: E[]) => {
    if (n.t === 'q') return;
    if (n.t === 'op') {
      if (n.a.t === 'q' && n.b.t === 'q') ready.push({ path, node: n, prec: PREC[n.op]! });
      walk(n.a, [...path, n]); walk(n.b, [...path, n]);
    } else {
      if (n.a.t === 'q') ready.push({ path, node: n, prec: 4 });
      walk(n.a, [...path, n]);
    }
  };
  walk(e, []);
  if (!ready.length) return null;
  // Brackets first (deepest), then powers, then × ÷, then + −; left to right.
  const pick = ready.sort((x, y) => y.path.length - x.path.length || y.prec - x.prec)[0]!;
  const top = ready.filter((r) => r.prec === Math.max(...ready.map((x) => x.prec)));
  const chosen = pick.path.length > 0 && ready.some((r) => r.path.length < pick.path.length && r.prec > pick.prec) ? top[0]! : pick;
  const n = chosen.node;
  let q: Q | null = null;
  let note = '';
  if (n.t === 'op' && n.a.t === 'q' && n.b.t === 'q') {
    const a = n.a.q, b = n.b.q;
    if ((n.op === '+' || n.op === '-') && !a.isInt() && !b.isInt() && a.d !== b.d) {
      // Fractions: show the common denominator before adding.
      const l = (a.d * b.d) / gcd(a.d, b.d);
      const A = `${a.n * (l / a.d)}/${l}`.replace(/^-/, '−'), B = `${b.n * (l / b.d)}/${l}`.replace(/^-/, '−');
      note = `Common denominator ${l}: ${A} ${SYM[n.op]} ${B}`;
    }
    if (n.op === '/' && b.isZero()) return null;
    q = n.op === '+' ? a.add(b) : n.op === '-' ? a.sub(b) : n.op === '*' ? a.mul(b) : n.op === '/' ? a.div(b) : b.isInt() ? a.pow(Number(b.n)) : null;
    if (!q) return null;
    note = note ? `${note} = ${show(q)}` : `${VERB[n.op]}: ${fmt(n)} = ${show(q)}`;
  } else if (n.t === 'neg' && n.a.t === 'q') { q = n.a.q.neg(); note = ''; }
  else if (n.t === 'sqrt' && n.a.t === 'q') { q = n.a.q.sqrt(); if (!q) return null; note = `Square root: √${show(n.a.q)} = ${show(q)}`; }
  if (!q || tooBig(q)) return null;
  const replace = (x: E): E => {
    if (x === n) return { t: 'q', q: q! };
    if (x.t === 'q') return x;
    if (x.t === 'op') return { ...x, a: replace(x.a), b: replace(x.b) };
    return { ...x, a: replace(x.a) };
  };
  return { e: replace(e), note };
}

export interface ExactValue { value: Q; steps: string[] }

/** Exact value of a number-only problem with its steps, or null (variables, √ of a non-square…). */
export function exactArithmetic(node: MathNode): ExactValue | null {
  let e = toE(node);
  if (!e) return null;
  const steps: string[] = [];
  for (let guard = 0; guard < 40 && e.t !== 'q'; guard++) {
    const r = reduce(e);
    if (!r) return null;
    e = r.e;
    if (r.note) steps.push(e.t === 'q' ? r.note : `${r.note} → ${fmt(e)}`);
  }
  if (e.t !== 'q') return null;
  // Simple sums need no steps ("2 + 2"); keep them for anything with two or more operations.
  return { value: e.q, steps: steps.length >= 2 || /Common/.test(steps[0] ?? '') ? steps.slice(0, 10) : [] };
}

// ---- Polynomials in one unknown ----------------------------------------------------------------------

/** Coefficients by degree (index = power of the unknown), exact. */
type Poly = Q[];

const trim = (p: Poly): Poly => { const q = [...p]; while (q.length > 1 && q[q.length - 1]!.isZero()) q.pop(); return q; };
const padd = (a: Poly, b: Poly, s = 1): Poly => trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => { const x = a[i] ?? new Q(0n), y = b[i] ?? new Q(0n); return s > 0 ? x.add(y) : x.sub(y); }));
const pmul = (a: Poly, b: Poly): Poly => {
  const out: Q[] = Array.from({ length: a.length + b.length - 1 }, () => new Q(0n));
  a.forEach((x, i) => b.forEach((y, j) => { out[i + j] = out[i + j]!.add(x.mul(y)); }));
  return trim(out);
};

/** The expression as a polynomial in `v` with rational coefficients, or null. */
export function polyOf(n: MathNode, v: string): Poly | null {
  switch (n.t) {
    case 'num': { const q = Q.of(n.v); return q ? [q] : null; }
    case 'var': return n.name === v ? [new Q(0n), new Q(1n)] : null;
    case 'neg': { const a = polyOf(n.a, v); return a && a.map((x) => x.neg()); }
    case 'bin': {
      const a = polyOf(n.a, v), b = polyOf(n.b, v);
      if (!a || !b) return null;
      if (n.op === '+') return padd(a, b);
      if (n.op === '-') return padd(a, b, -1);
      if (n.op === '*') { const p = pmul(a, b); return p.length > 3 ? null : p; }
      if (n.op === '/') { if (b.length !== 1 || b[0]!.isZero()) return null; return a.map((x) => x.div(b[0]!)); }
      if (b.length !== 1 || !b[0]!.isInt()) return null;
      const k = Number(b[0]!.n);
      if (k < 0 || k > 2) return a.length === 1 ? [a[0]!.pow(k)!].filter(Boolean) as Poly : null;
      let p: Poly = [new Q(1n)];
      for (let i = 0; i < k; i++) p = pmul(p, a);
      return p.length > 3 ? null : p;
    }
    default: return null;
  }
}

/** "3x² − 2x + 1" from coefficients. */
export function showPoly(p: Poly, v: string): string {
  const parts: string[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const c = p[i]!;
    if (c.isZero() && p.length > 1) continue;
    const mag = c.sign() < 0 ? c.neg() : c;
    const coef = i > 0 && mag.n === 1n && mag.d === 1n ? '' : mag.isInt() ? `${mag}` : `(${mag})`;
    const term = i === 0 ? `${mag}` : `${coef}${v}${i === 2 ? '²' : ''}`;
    parts.push(parts.length ? `${c.sign() < 0 ? '−' : '+'} ${term}` : `${c.sign() < 0 ? '−' : ''}${term}`);
  }
  return parts.join(' ') || '0';
}

export interface EquationSteps { solutions: Q[] | null; steps: string[] }

/** Steps for a linear or quadratic equation in `v` (rational coefficients), or null. */
export function equationSteps(lhs: MathNode, rhs: MathNode, v: string): EquationSteps | null {
  const L = polyOf(lhs, v), R = polyOf(rhs, v);
  if (!L || !R) return null;
  const P = padd(L, R, -1);
  const zero = new Q(0n);
  if (P.length === 2) {
    // a·v + b = 0 → v = −b/a, shown the way it's done by hand.
    const a = P[1]!, b = P[0]!;
    const steps: string[] = [];
    const La = L[1] ?? zero, Lb = L[0] ?? zero, Ra = R[1] ?? zero, Rb = R[0] ?? zero;
    steps.push(`Expand both sides: ${showPoly(L, v)} = ${showPoly(R, v)}`);
    if (!Ra.isZero() || !Lb.isZero()) steps.push(`Collect ${v} on the left, numbers on the right: ${showPoly([zero, La.sub(Ra)], v)} = ${show(Rb.sub(Lb))}`);
    const x = b.neg().div(a);
    if (!(a.n === 1n && a.d === 1n)) steps.push(`Divide both sides by ${show(a)}: ${v} = ${show(x)}`);
    return { solutions: [x], steps: dedupe(steps) };
  }
  if (P.length === 3) {
    const [c, b, a] = P as [Q, Q, Q];
    const D = b.mul(b).sub(new Q(4n).mul(a).mul(c));
    const steps = [`Bring everything to one side: ${showPoly(P, v)} = 0`, `Discriminant: b² − 4ac = ${show(D)}`];
    if (D.sign() < 0) { steps.push('It is negative, so there is no real solution'); return { solutions: [], steps }; }
    const r = D.sqrt();
    const two = new Q(2n).mul(a);
    if (r) {
      const x1 = b.neg().sub(r).div(two), x2 = b.neg().add(r).div(two);
      const sols = D.isZero() ? [x1] : [x1, x2].sort((p, q) => p.value() - q.value());
      const factor = (s: Q) => (s.sign() < 0 ? `(${v} + ${show(s.neg())})` : s.isZero() ? v : `(${v} − ${show(s)})`);
      steps.push(`√${show(D)} = ${show(r)}, so ${v} = (${show(b.neg())} ± ${show(r)}) / ${show(two)}`);
      if (a.n === 1n && a.d === 1n) steps.push(`Factored: ${sols.length === 1 ? `${factor(sols[0]!)}²` : sols.map(factor).join('')} = 0`);
      steps.push(`${v} = ${sols.map(show).join(' or ')}`);
      return { solutions: sols, steps };
    }
    steps.push(`${v} = (${show(b.neg())} ± √${show(D)}) / ${show(two)}`);
    return { solutions: null, steps };
  }
  return null;
}

/** Steps for two linear equations in two unknowns (elimination), or null. */
export function systemSteps(eqs: [MathNode, MathNode][], vars: [string, string]): { solution: [Q, Q] | null; steps: string[] } | null {
  if (eqs.length !== 2) return null;
  const [x, y] = vars;
  const rows: [Q, Q, Q][] = [];
  for (const [l, r] of eqs) {
    // a·x + b·y + c (as l − r): read a, b, c from three exact evaluations.
    const f = (xv: Q, yv: Q) => evalAt(l, { [x]: xv, [y]: yv })?.sub(evalAt(r, { [x]: xv, [y]: yv }) ?? new Q(0n));
    const z = new Q(0n), o = new Q(1n);
    const c = f(z, z), ax = f(o, z), by = f(z, o), both = f(o, o), two = f(new Q(2n), new Q(3n));
    if (!c || !ax || !by || !both || !two) return null;
    const a = ax.sub(c), b = by.sub(c);
    // Linear check: f(1,1) and f(2,3) must agree with the plane.
    if (!both.sub(a).sub(b).sub(c).isZero() || !two.sub(a.mul(new Q(2n))).sub(b.mul(new Q(3n))).sub(c).isZero()) return null;
    rows.push([a, b, c.neg()]);
  }
  const [[a1, b1, c1], [a2, b2, c2]] = rows as [[Q, Q, Q], [Q, Q, Q]];
  const det = a1.mul(b2).sub(a2.mul(b1));
  const line = (a: Q, b: Q, c: Q) => `${showPoly([new Q(0n), a], x)} ${b.sign() < 0 ? '−' : '+'} ${showPoly([new Q(0n), b.sign() < 0 ? b.neg() : b], y)} = ${show(c)}`;
  const steps = [`Write both as a·${x} + b·${y} = c: ${line(a1, b1, c1)}; ${line(a2, b2, c2)}`];
  if (det.isZero()) { steps.push('The equations are parallel: no single solution'); return { solution: null, steps }; }
  const xv = c1.mul(b2).sub(c2.mul(b1)).div(det);
  const yv = a1.mul(c2).sub(a2.mul(c1)).div(det);
  steps.push(`Eliminate ${y}: multiply the first by ${show(b2)} and the second by ${show(b1)}, subtract: ${show(det)}${x} = ${show(c1.mul(b2).sub(c2.mul(b1)))}`);
  steps.push(`${x} = ${show(xv)}`);
  steps.push(`Put ${x} = ${show(xv)} back into an equation: ${y} = ${show(yv)}`);
  return { solution: [xv, yv], steps };
}

function evalAt(n: MathNode, env: Record<string, Q>): Q | null {
  switch (n.t) {
    case 'num': return Q.of(n.v);
    case 'var': return env[n.name] ?? null;
    case 'neg': { const a = evalAt(n.a, env); return a && a.neg(); }
    case 'bin': {
      const a = evalAt(n.a, env), b = evalAt(n.b, env);
      if (!a || !b) return null;
      try {
        return n.op === '+' ? a.add(b) : n.op === '-' ? a.sub(b) : n.op === '*' ? a.mul(b) : n.op === '/' ? a.div(b) : b.isInt() ? a.pow(Number(b.n)) : null;
      } catch { return null; }
    }
    default: return null;
  }
}

function dedupe(xs: string[]): string[] {
  return xs.filter((s, i) => xs.indexOf(s) === i);
}
