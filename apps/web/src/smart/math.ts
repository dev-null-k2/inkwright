import {
  asFunctionOfX, compileNode, findRoots, formatMath, formatMathNumber, normalizeMath, parseMath, variablesOf, type MathNode,
} from '@inkwright/core';
import { equationSteps, exactArithmetic, systemSteps, type Q } from './steps.ts';

/**
 * "Write an equation and it solves itself": the computer-algebra side. Works fully offline:
 *  - nerdamer-prime (MIT) for symbolic algebra: equations, systems, derivatives, integrals, limits;
 *  - mathjs (Apache-2.0) for units and conversions ("5 km/h to m/s");
 *  - Inkwright's own expression parser (core/mathexpr.ts) to read handwriting-style maths and to
 *    check every symbolic answer numerically, with a numeric root finder as the fallback.
 * Both libraries are large, so they load on first use only.
 */

export type MathKind = 'value' | 'equation' | 'system' | 'derivative' | 'integral' | 'limit' | 'units' | 'simplify' | 'function';

export interface MathSolution {
  kind: MathKind;
  /** The problem as understood, prettified ("2x + 3 = 7"). */
  problem: string;
  /** What to write on the page ("x = 2", "= 7", "≈ 1.414"). */
  result: string;
  /** Functions worth plotting (y = …, f(x) = …, an expression in x). */
  plot?: { expr: string; label: string }[];
  /** Worked steps, computed exactly on this device (steps.ts); absent when there is no short way to show them. */
  steps?: string[];
}

/** "15%" → (15/100), "20% of 50" → (20/100)*50: percentages as people write them. */
export function expandPercent(s: string): string {
  return s.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/gi, '($1/100)*').replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');
}

const showQ = (q: Q) => q.toString().replace(/^-/, '−');

let nerdamerP: Promise<any> | null = null;
/** nerdamer with the Algebra, Calculus and Solve add-ons (the all-in-one ES build). */
function cas(): Promise<any> {
  nerdamerP ??= import('nerdamer-prime').then((m: any) => m.default ?? m);
  return nerdamerP;
}
let mathjsP: Promise<any> | null = null;
function mathjs(): Promise<any> {
  mathjsP ??= import('mathjs').then((m: any) => m);
  return mathjsP;
}

/** nerdamer's log is natural; in school maths `log` is base 10 and `ln` natural. */
const TO_CAS: Record<string, string> = { log: 'log10', ln: 'log', arcsin: 'asin', arccos: 'acos', arctan: 'atan' };
const toCas = (n: MathNode) => formatMath(n, TO_CAS);

/** Display form of an ASCII maths string: √, superscripts, ·, π, a real minus sign. */
export function prettyMath(s: string): string {
  return s
    .replace(/\blog10\(/g, 'log(')
    .replace(/\blog\(/g, (m, i: number, all: string) => (all.slice(i - 2, i) === '10' ? m : 'ln('))
    .replace(/\bpi\b/g, 'π')
    .replace(/\^2(?![\d.])/g, '²').replace(/\^3(?![\d.])/g, '³')
    .replace(/(^|[^\w.])(\d+(?:\.\d+)?)\*(?=[a-zA-Zπ(])/g, '$1$2')
    .replace(/\bsqrt\(([^()]+)\)/g, (_, a: string) => (/^[\w.]+$/.test(a) ? `√${a}` : `√(${a})`))
    .replace(/\bsqrt\(/g, '√(')
    .replace(/\)\*\(/g, ')(')
    .replace(/\*/g, '·')
    .replace(/([^\s(,=])([+=])(?=[^\s])/g, '$1 $2 ')
    .replace(/([^\s(,=e^])-(?=[^\s])/g, '$1 − ')
    .replace(/-/g, '−')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reorders a sum so the highest power of `v` comes first ("2+3*x^2" → "3*x^2+2"), the way
 * people write polynomials. Leaves anything it cannot split cleanly unchanged.
 */
export function orderTerms(expr: string, v = 'x'): string {
  const terms: string[] = [];
  let depth = 0, cur = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if ((ch === '+' || ch === '-') && depth === 0 && i > 0 && !'^*/e('.includes(expr[i - 1]!)) { terms.push(cur); cur = ch; } else cur += ch;
  }
  terms.push(cur);
  if (terms.length < 2) return expr;
  const re = new RegExp(`(?<![a-z])${v}(?![a-z])(?:\\^(\\d+(?:\\.\\d+)?))?`, 'g');
  const deg = (t: string) => { let d = 0; for (const m of t.matchAll(re)) d = Math.max(d, m[1] ? Number(m[1]) : 1); return d; };
  const sorted = terms.map((t, i) => ({ t: t.startsWith('+') ? t.slice(1) : t, d: deg(t), i })).sort((a, b) => b.d - a.d || a.i - b.i);
  return sorted.map((x, i) => (i === 0 || x.t.startsWith('-') ? x.t : `+${x.t}`)).join('');
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

/** A numeric value close to a simple fraction p/q (q ≤ 100), or null. */
export function asFraction(v: number): [number, number] | null {
  if (!Number.isFinite(v) || Number.isInteger(v)) return null;
  for (let q = 2; q <= 100; q++) {
    const p = Math.round(v * q);
    if (Math.abs(p / q - v) < 1e-10) return [p, q];
  }
  return null;
}

const evalNumber = (n: MathNode) => compileNode(n)({});

/** Is a symbolic answer readable on a page (short, no huge rational approximations)? */
const readable = (s: string) => s.length <= 40 && !/\d{7,}/.test(s) && !/\bi\b/.test(s);

/**
 * Solves or evaluates what was written. Throws with a short, user-facing message when the
 * input cannot be read as maths.
 */
export async function solveMath(src: string): Promise<MathSolution> {
  const lines = src.split(/\s*(?:\r?\n|;)\s*/).map((l) => expandPercent(normalizeMath(l)).replace(/\s*=\s*\??\s*$/, '').trim()).filter(Boolean);
  if (!lines.length) throw new Error('Nothing to solve');
  if (lines.length > 1 && lines.every((l) => l.includes('='))) return solveSystem(lines);
  let s = lines.join(' ');

  if (/^d\/d[a-z]/i.test(s) || /^diff\(/i.test(s) || /^\(.+\)'$/.test(s)) return derivative(s);
  if (/^(∫|integrate\(|int\b)/i.test(s)) return integral(s);
  if (/^lim/i.test(s)) return limit(s);

  if (/[a-z]{2,}/i.test(s) && !s.includes('=') && (await looksLikeUnits(s))) return units(s);

  // Words that are neither maths nor units: this is prose, not a problem to solve.
  const stray = (s.replace(/^(lim|integrate|diff|int)\b/i, '').match(/[a-z]{3,}/gi) ?? []).filter((w) => !MATH_WORDS.test(w));
  if (stray.length) throw new Error('That doesn\u2019t look like maths');

  if (s.includes('=')) {
    const parts = s.split('=');
    if (parts.length !== 2) throw new Error('Write one "=" per equation');
    const fn = asFunctionOfX(s);
    if (fn && /^\s*(y|[a-z]\s*\(\s*x\s*\))\s*$/i.test(parts[0]!)) return functionOf(fn.expr, fn.label);
    return equation(parts[0]!.trim(), parts[1]!.trim());
  }

  const node = parseMath(s);
  const vars = variablesOf(node);
  if (!vars.size) {
    // Exactly, with steps, when it is rational arithmetic ("1/2 + 1/3" is 5/6, not 0.8333).
    const exact = exactArithmetic(node);
    if (exact) {
      const q = exact.value, dec = q.value();
      const terminating = (() => { let d = q.d; for (const p of [2n, 5n]) while (d % p === 0n) d /= p; return d === 1n; })();
      const decimal = formatMathNumber(dec);
      const result = q.isInt() ? `= ${showQ(q)}`
        : /[/÷]/.test(src) ? `= ${showQ(q)} ${terminating && decimal === String(dec) ? '=' : '≈'} ${decimal.replace(/^-/, '−')}`
          : `= ${terminating && decimal === String(dec) ? decimal.replace(/^-/, '−') : `${showQ(q)} ≈ ${decimal.replace(/^-/, '−')}`}`;
      return { kind: 'value', problem: prettyMath(toCas(node)), result, steps: exact.steps.length ? exact.steps : undefined };
    }
    const v = evalNumber(node);
    if (!Number.isFinite(v)) throw new Error('That has no finite value');
    const frac = s.includes('/') ? asFraction(v) : null;
    return { kind: 'value', problem: prettyMath(toCas(node)), result: frac ? `= ${frac[0]}/${frac[1]} ≈ ${formatMathNumber(v)}` : `= ${formatMathNumber(v)}` };
  }
  if (vars.size === 1 && vars.has('x')) return functionOf(s, 'y');
  const n = await cas();
  const simp = n(`simplify(expand(${toCas(node)}))`).toString();
  return { kind: 'simplify', problem: prettyMath(toCas(node)), result: `= ${prettyMath(orderTerms(simp, [...vars].sort()[0]))}` };
}

const MATH_WORDS = /^(sin|cos|tan|asin|acos|atan|arcsin|arccos|arctan|sinh|cosh|tanh|sec|csc|cot|exp|ln|log|log10|log2|sqrt|cbrt|abs|floor|ceil|round|sign|min|max|pi|tau)$/i;

/** A conversion ("… to mph") or a word that mathjs knows as a unit ("3 km + 200 m"). */
async function looksLikeUnits(s: string): Promise<boolean> {
  const words = (s.match(/[a-z]{2,}/gi) ?? []).filter((w) => !MATH_WORDS.test(w) && w !== 'to' && w !== 'in');
  if (!words.length) return false;
  const m = await mathjs();
  return words.some((w) => { try { return m.Unit.isValuelessUnit(w); } catch { return false; } });
}

async function units(s: string): Promise<MathSolution> {
  const m = await mathjs();
  let r: any;
  try { r = m.evaluate(s.replace(/\bin\b/g, 'to')); } catch (e) { throw new Error(`Couldn't read that: ${(e as Error).message}`); }
  const text = typeof r === 'number' ? formatMathNumber(r) : m.format(r, { precision: 6 });
  return { kind: 'units', problem: s, result: `= ${text}` };
}

async function functionOf(expr: string, label: string): Promise<MathSolution> {
  const node = parseMath(expr);
  const f = compileNode(node);
  const g = (x: number) => f({ x });
  const roots = findRoots(g, -100, 100, 8000).filter((r) => Math.abs(r) < 100);
  const y0 = g(0);
  const bits: string[] = [];
  if (roots.length) bits.push(`x-intercept${roots.length > 1 ? 's' : ''} ${roots.slice(0, 5).map(formatMathNumber).join(', ')}`);
  if (Number.isFinite(y0)) bits.push(`y-intercept ${formatMathNumber(y0)}`);
  return { kind: 'function', problem: `${label} = ${prettyMath(toCas(node))}`, result: bits.join('; ') || 'no intercepts in view', plot: [{ expr: toCas(node), label }] };
}

async function equation(lhs: string, rhs: string): Promise<MathSolution> {
  const a = parseMath(lhs), b = parseMath(rhs);
  const vars = new Set([...variablesOf(a), ...variablesOf(b)]);
  const problem = `${prettyMath(toCas(a))} = ${prettyMath(toCas(b))}`;
  if (!vars.size) {
    const ok = Math.abs(evalNumber(a) - evalNumber(b)) < 1e-9 * Math.max(1, Math.abs(evalNumber(a)));
    return { kind: 'equation', problem, result: ok ? 'true' : `false (${formatMathNumber(evalNumber(a))} ≠ ${formatMathNumber(evalNumber(b))})` };
  }
  const v = vars.has('x') ? 'x' : [...vars].sort()[0]!;
  const diff = compileNode({ t: 'bin', op: '-', a, b });
  const others = [...vars].filter((x) => x !== v);
  // Linear and quadratic equations with rational coefficients: exact answer and steps.
  const worked = others.length ? null : equationSteps(a, b, v);
  if (worked?.solutions) {
    const result = worked.solutions.length ? `${v} = ${worked.solutions.map(showQ).join(', ')}` : `no real solution for ${v}`;
    return { kind: 'equation', problem, result, steps: worked.steps };
  }
  const steps = worked?.steps;
  const n = await cas();
  let symbolic: string[] = [];
  try {
    const out = n.solve(`${toCas(a)}=${toCas(b)}`, v).toString();
    symbolic = splitTop(out.replace(/^\[|\]$/g, '')).filter(Boolean);
  } catch { /* fall back to numeric */ }
  if (others.length) {
    // Literal equations ("solve for x"): keep the symbolic answer.
    const sols = symbolic.filter(readable);
    if (!sols.length) throw new Error(`Couldn't solve for ${v}`);
    return { kind: 'equation', problem, result: `${v} = ${sols.map(prettyMath).join(', ')}` };
  }
  const f = (x: number) => diff({ [v]: x });
  // Keep symbolic solutions that check out numerically (and are readable).
  const exact: { text: string; value: number }[] = [];
  for (const sol of symbolic) {
    let value = NaN;
    try { value = Number(n(sol).evaluate().text('decimals')); } catch { /* not numeric */ }
    if (!Number.isFinite(value) || Math.abs(f(value)) > 1e-6 * Math.max(1, Math.abs(value))) continue;
    exact.push({ text: readable(sol) ? sol : formatMathNumber(value), value });
  }
  if (exact.length) {
    exact.sort((p, q) => p.value - q.value);
    const shown = exact.map((e) => {
      const pretty = prettyMath(e.text);
      const isPlain = /^−?[\d.]+$/.test(pretty) || /^−?\d+\/\d+$/.test(pretty);
      return isPlain || exact.length > 2 ? pretty : `${pretty} ≈ ${formatMathNumber(e.value)}`;
    });
    // Decimals the solver found numerically are approximations, not exact answers.
    const approx = shown.every((t) => /^−?\d+\.\d+$/.test(t)) && exact.some((e) => !Number.isInteger(e.value * 1e4));
    return { kind: 'equation', problem, result: `${v} ${approx ? '≈' : '='} ${shown.join(', ')}`, steps };
  }
  // Transcendental or messy: find real roots numerically.
  const near = findRoots(f, -20, 20, 8000);
  const far = findRoots(f, -1000, 1000, 40000).filter((r) => Math.abs(r) > 20);
  const roots = [...near, ...far].sort((p, q) => p - q);
  if (!roots.length) return { kind: 'equation', problem, result: `no real solution for ${v}` };
  const list = roots.slice(0, 6).map(formatMathNumber).join(', ') + (roots.length > 6 ? ', …' : '');
  return { kind: 'equation', problem, result: `${v} ≈ ${list}`, steps };
}

async function solveSystem(lines: string[]): Promise<MathSolution> {
  const parsed = lines.map((l) => { const [a, b] = l.split('='); return [parseMath(a!), parseMath(b!)] as [MathNode, MathNode]; });
  const vars = [...new Set(parsed.flatMap(([a, b]) => [...variablesOf(a), ...variablesOf(b)]))].sort();
  // Two linear equations in two unknowns: exact, with elimination steps.
  const worked = vars.length === 2 ? systemSteps(parsed, vars as [string, string]) : null;
  if (worked?.solution) {
    return { kind: 'system', problem: lines.map((l) => prettyMath(l)).join('; '), result: `${vars[0]} = ${showQ(worked.solution[0])}, ${vars[1]} = ${showQ(worked.solution[1])}`, steps: worked.steps };
  }
  const n = await cas();
  const eqs = parsed.map(([a, b]) => `${toCas(a)}=${toCas(b)}`);
  let res: any;
  try { res = n.solveEquations(eqs); } catch { throw new Error('That system has no single solution'); }
  if (!res || (Array.isArray(res) && !res.length)) throw new Error('That system has no single solution');
  const pairs: [string, unknown][] = Array.isArray(res) ? res : Object.entries(res);
  const text = pairs.map(([k, v]) => {
    const num = Number(String(v));
    const frac = asFraction(num);
    return `${k} = ${Number.isFinite(num) ? (frac ? `${frac[0]}/${frac[1]}` : formatMathNumber(num)) : prettyMath(String(v))}`;
  }).join(', ');
  return { kind: 'system', problem: lines.map((l) => prettyMath(l)).join('; '), result: text };
}

async function derivative(s: string): Promise<MathSolution> {
  let v = 'x', body = '';
  let m = /^d\/d([a-z])\s*(.+)$/i.exec(s);
  if (m) { v = m[1]!; body = m[2]!; }
  else if ((m = /^diff\((.+),\s*([a-z])\)$/i.exec(s))) { body = m[1]!; v = m[2]!; }
  else if ((m = /^\((.+)\)'$/.exec(s))) body = m[1]!;
  const node = parseMath(body);
  const n = await cas();
  const d = n(`diff(${toCas(node)},${v})`).expand().toString();
  const simp = n(`simplify(${d})`).toString();
  const best = orderTerms(simp.length <= d.length ? simp : d, v);
  return { kind: 'derivative', problem: `d/d${v} ${prettyMath(toCas(node))}`, result: `= ${prettyMath(best)}`, plot: v === 'x' && asFunctionOfX(best.replace(/log10\(/g, 'log(').replace(/\blog\(/g, 'ln(')) ? [{ expr: toCas(node), label: 'f(x)' }, { expr: best, label: "f'(x)" }] : undefined };
}

async function integral(s: string): Promise<MathSolution> {
  let body = '', v = 'x', lo: string | undefined, hi: string | undefined;
  let m = /^integrate\((.+)\)$/i.exec(s);
  if (m) {
    const args = splitTop(m[1]!);
    body = args[0]!; v = args[1] ?? 'x'; lo = args[2]; hi = args[3];
  } else {
    // ∫_0^3 x^2 dx, ∫0^3 x^2 dx, ∫ x^2 dx, int x dx
    m = /^(?:∫|int)\s*(?:_?\{?([^\s^{}]+)\}?\s*\^\s*\{?([^\s{}]+)\}?)?\s*(.+?)\s*d([a-z])\s*$/i.exec(s);
    if (!m) throw new Error('Write integrals like ∫ x^2 dx or ∫_0^3 x^2 dx');
    lo = m[1]; hi = m[2]; body = m[3]!; v = m[4]!;
  }
  const node = parseMath(body);
  const n = await cas();
  const f = toCas(node);
  if (lo !== undefined && hi !== undefined) {
    const a = toCas(parseMath(lo)), b = toCas(parseMath(hi));
    let value = NaN, exact = '';
    try { const r = n(`defint(${f},${a},${b},${v})`); exact = r.toString(); value = Number(r.evaluate().text('decimals')); } catch { /* numeric below */ }
    if (!Number.isFinite(value)) value = simpson((x) => compileNode(node)({ [v]: x }), evalNumber(parseMath(lo)), evalNumber(parseMath(hi)));
    if (!Number.isFinite(value)) throw new Error('That integral does not converge');
    const pretty = exact && readable(exact) && !/^-?[\d.]+$/.test(exact) && !exact.includes('defint') ? `${prettyMath(exact)} ≈ ${formatMathNumber(value)}` : formatMathNumber(value);
    return { kind: 'integral', problem: `∫ from ${prettyMath(a)} to ${prettyMath(b)} of ${prettyMath(f)} d${v}`, result: `= ${pretty}` };
  }
  const r = n(`integrate(${f},${v})`).toString();
  if (r.includes('integrate')) throw new Error("Couldn't find an antiderivative");
  return { kind: 'integral', problem: `∫ ${prettyMath(f)} d${v}`, result: `= ${prettyMath(orderTerms(r, v))} + C` };
}

/** Adaptive-free composite Simpson with 2000 panels — enough for page-sized answers. */
function simpson(f: (x: number) => number, a: number, b: number, n = 2000): number {
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let i = 1; i < n; i++) sum += f(a + i * h) * (i % 2 ? 4 : 2);
  return (sum * h) / 3;
}

async function limit(s: string): Promise<MathSolution> {
  let m = /^limit\((.+)\)$/i.exec(s);
  let body: string, v: string, to: string;
  if (m) { const args = splitTop(m[1]!); body = args[0]!; v = args[1] ?? 'x'; to = args[2] ?? '0'; }
  else {
    m = /^lim\s*_?\{?\s*([a-z])\s*(?:->|→|to)\s*([^\s}]+)\s*\}?\s*(.+)$/i.exec(s);
    if (!m) throw new Error('Write limits like lim x→0 sin(x)/x');
    v = m[1]!; to = m[2]!; body = m[3]!;
  }
  const node = parseMath(body);
  const target = /^(∞|inf|infinity|\+∞)$/i.test(to) ? 'Infinity' : /^(-∞|-inf|-infinity)$/i.test(to) ? '-Infinity' : toCas(parseMath(to));
  const n = await cas();
  let r = '';
  try { r = n(`limit(${toCas(node)},${v},${target})`).toString(); } catch { /* numeric */ }
  if (!r || r.includes('limit')) {
    // Numeric estimate from both sides.
    const f = compileNode(node);
    const a = Number(target === 'Infinity' ? 1e8 : target === '-Infinity' ? -1e8 : evalNumber(parseMath(to)));
    const left = f({ [v]: a - 1e-7 }), right = f({ [v]: a + 1e-7 });
    if (!Number.isFinite(left) || Math.abs(left - right) > 1e-4 * Math.max(1, Math.abs(left))) throw new Error('That limit does not exist');
    r = formatMathNumber((left + right) / 2);
  }
  return { kind: 'limit', problem: `lim ${v}→${prettyMath(to)} ${prettyMath(toCas(node))}`, result: `= ${prettyMath(r)}` };
}
