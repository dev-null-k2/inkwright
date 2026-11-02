import type { GraphObject } from './objects.ts';

/**
 * A small, dependency-free maths expression language for plotting and quick evaluation, the way
 * people write maths by hand: implicit multiplication (`2x`, `3sin(x)`, `(x+1)(x-1)`), `^`
 * powers, `|x|`, `√`, `π`, `²`, `×`, `÷`, `n!`. Graph objects are drawn from it everywhere
 * (canvas, SVG export in core, the MCP server) without loading a computer-algebra system; the
 * symbolic solver lives in the app and is loaded only when needed.
 *
 * `log` is base 10 and `ln` natural, as in school maths.
 */

export type MathNode =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'neg'; a: MathNode }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: MathNode; b: MathNode }
  | { t: 'call'; fn: string; args: MathNode[] }
  | { t: 'fact'; a: MathNode };

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  exp: Math.exp, ln: Math.log, log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)), log10: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const NAMES = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)].sort((a, b) => b.length - a.length);

export function isMathFunction(name: string): boolean {
  return name in FUNCTIONS;
}

/** Rewrites handwritten/typographic maths symbols into the ASCII the parser reads. */
export function normalizeMath(src: string): string {
  return src
    .replace(/[−–—]/g, '-')
    .replace(/[×·∙⋅]/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/√/g, 'sqrt')
    .replace(/²/g, '^2').replace(/³/g, '^3').replace(/⁴/g, '^4')
    .replace(/\*\*/g, '^')
    .replace(/\s+/g, ' ')
    .trim();
}

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const s = normalizeMath(src);
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ' ') { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num && /[\d.]/.test(ch)) { out.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j]!)) j++;
      let word = s.slice(i, j);
      // Split runs like "xsin" or "2pix" into known names and single-letter variables.
      while (word) {
        const lower = word.toLowerCase();
        const known = NAMES.find((n) => lower.startsWith(n));
        if (known) { out.push({ k: 'id', v: known }); word = word.slice(known.length); continue; }
        const digits = /^[a-zA-Z](\d+)?/.exec(word)![0];
        // x2 → x^2 is ambiguous; keep subscripted names like x1 as one variable.
        out.push({ k: 'id', v: digits });
        word = word.slice(digits.length);
      }
      i = j;
      continue;
    }
    if ('+-*/^()|,!'.includes(ch)) { out.push({ k: 'op', v: ch }); i++; continue; }
    if (ch === '[' || ch === '{') { out.push({ k: 'op', v: '(' }); i++; continue; }
    if (ch === ']' || ch === '}') { out.push({ k: 'op', v: ')' }); i++; continue; }
    throw new Error(`Unexpected "${ch}"`);
  }
  return out;
}

/** Parses an expression (no `=`). Throws with a readable message on malformed input. */
export function parseMath(src: string): MathNode {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = toks[p]; return !!t && t.k === 'op' && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };
  let absDepth = 0;

  const startsPrimary = () => {
    const t = peek();
    if (!t) return false;
    if (t.k === 'num' || t.k === 'id') return true;
    return t.v === '(' || (t.v === '|' && absDepth === 0);
  };

  function sum(): MathNode {
    let a = product();
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { v: '+' | '-' }).v;
      a = { t: 'bin', op, a, b: product() };
    }
    return a;
  }
  function product(): MathNode {
    let a = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = (toks[p++] as { v: '*' | '/' }).v;
        a = { t: 'bin', op, a, b: unary() };
      } else if (startsPrimary()) {
        a = { t: 'bin', op: '*', a, b: power() };
      } else return a;
    }
  }
  function unary(): MathNode {
    if (isOp('-')) { p++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power(): MathNode {
    const base = postfix();
    if (isOp('^')) { p++; return { t: 'bin', op: '^', a: base, b: unary() }; }
    return base;
  }
  function postfix(): MathNode {
    let a = primary();
    while (isOp('!')) { p++; a = { t: 'fact', a }; }
    return a;
  }
  function primary(): MathNode {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.k === 'num') { p++; return { t: 'num', v: t.v }; }
    if (t.k === 'id') {
      p++;
      if (t.v in FUNCTIONS) {
        // sin x, sin2x (no parentheses): the argument is the next factor.
        if (isOp('(')) {
          p++;
          const args = [sum()];
          while (isOp(',')) { p++; args.push(sum()); }
          expect(')');
          if (isOp('^')) {
            // sin(x)^2 means (sin x)^2.
            p++;
            return { t: 'bin', op: '^', a: { t: 'call', fn: t.v, args }, b: unary() };
          }
          return { t: 'call', fn: t.v, args };
        }
        if (isOp('^')) { p++; const e = unary(); return { t: 'bin', op: '^', a: { t: 'call', fn: t.v, args: [power()] }, b: e }; }
        return { t: 'call', fn: t.v, args: [power()] };
      }
      if (t.v in CONSTANTS) return { t: 'num', v: CONSTANTS[t.v]! };
      return { t: 'var', name: t.v };
    }
    if (t.v === '(') { p++; const e = sum(); expect(')'); return e; }
    if (t.v === '|') { p++; absDepth++; const e = sum(); absDepth--; expect('|'); return { t: 'call', fn: 'abs', args: [e] }; }
    throw new Error(`Unexpected "${t.v}"`);
  }

  const node = sum();
  if (p < toks.length) throw new Error(`Unexpected "${(toks[p] as { v: unknown }).v}"`);
  return node;
}

function factorial(n: number): number {
  if (n < 0 || !Number.isFinite(n)) return NaN;
  if (Number.isInteger(n) && n <= 170) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
  return NaN;
}

/** Compiles a parsed expression into a fast function of its variables. */
export function compileNode(n: MathNode): (env: Record<string, number>) => number {
  switch (n.t) {
    case 'num': { const v = n.v; return () => v; }
    case 'var': { const k = n.name; return (env) => (k in env ? env[k]! : NaN); }
    case 'neg': { const a = compileNode(n.a); return (env) => -a(env); }
    case 'fact': { const a = compileNode(n.a); return (env) => factorial(a(env)); }
    case 'call': {
      const f = FUNCTIONS[n.fn]!;
      const args = n.args.map(compileNode);
      if (args.length === 1) { const a = args[0]!; return (env) => f(a(env)); }
      return (env) => f(...args.map((a) => a(env)));
    }
    case 'bin': {
      const a = compileNode(n.a), b = compileNode(n.b);
      switch (n.op) {
        case '+': return (env) => a(env) + b(env);
        case '-': return (env) => a(env) - b(env);
        case '*': return (env) => a(env) * b(env);
        case '/': return (env) => a(env) / b(env);
        case '^': return (env) => {
          const x = a(env), y = b(env);
          // Real odd roots of negatives: (-8)^(1/3) = -2.
          if (x < 0 && !Number.isInteger(y)) {
            const inv = 1 / y;
            if (Number.isInteger(Math.round(inv)) && Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2 !== 0) return -Math.pow(-x, y);
          }
          return Math.pow(x, y);
        };
      }
    }
  }
}

/**
 * Writes a parsed expression back as explicit ASCII maths (every product has a `*`), for a
 * computer-algebra system. `rename` maps function names to the target's (e.g. log → log10).
 */
export function formatMath(n: MathNode, rename: Record<string, string> = {}): string {
  const prec = (x: MathNode) => (x.t === 'bin' ? ({ '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 } as const)[x.op] : x.t === 'neg' ? 1.5 : 5);
  const wrap = (x: MathNode, min: number) => (prec(x) < min ? `(${formatMath(x, rename)})` : formatMath(x, rename));
  switch (n.t) {
    case 'num': return Number.isInteger(n.v) || Math.abs(n.v) > 1e-6 ? String(n.v === Math.PI ? 'pi' : n.v === Math.E ? 'e' : n.v) : n.v.toExponential();
    case 'var': return n.name;
    case 'neg': return `-${wrap(n.a, 4)}`;
    case 'fact': return `${wrap(n.a, 5)}!`;
    case 'call': return `${rename[n.fn] ?? n.fn}(${n.args.map((a) => formatMath(a, rename)).join(',')})`;
    case 'bin':
      if (n.op === '^') return `${wrap(n.a, 5)}^${wrap(n.b, 4)}`;
      if (n.op === '-' || n.op === '/') return `${wrap(n.a, prec(n))}${n.op}${wrap(n.b, prec(n) + 1)}`;
      return `${wrap(n.a, prec(n))}${n.op}${wrap(n.b, prec(n))}`;
  }
}

/** Variables an expression uses (constants and function names excluded). */
export function variablesOf(n: MathNode, out = new Set<string>()): Set<string> {
  if (n.t === 'var') out.add(n.name);
  else if (n.t === 'neg' || n.t === 'fact') variablesOf(n.a, out);
  else if (n.t === 'bin') { variablesOf(n.a, out); variablesOf(n.b, out); }
  else if (n.t === 'call') n.args.forEach((a) => variablesOf(a, out));
  return out;
}

/** A function of x compiled from source, or null when it does not parse or uses other variables. */
export function compileFunctionOfX(src: string): ((x: number) => number) | null {
  try {
    const node = parseMath(src);
    const vars = variablesOf(node);
    for (const v of vars) if (v !== 'x') return null;
    const f = compileNode(node);
    return (x) => f({ x });
  } catch {
    return null;
  }
}

/**
 * Reads "y = …", "f(x) = …" or a bare expression in x as a function to plot. Returns the
 * right-hand side and a label, or null when it is not a function of x alone.
 */
export function asFunctionOfX(src: string): { expr: string; label: string } | null {
  const s = normalizeMath(src).replace(/=\s*$/, '');
  const m = /^\s*(y|[a-z]\s*\(\s*x\s*\))\s*=\s*(.+)$/i.exec(s);
  const expr = (m ? m[2]! : s).trim();
  if (!expr || expr.includes('=')) return null;
  try {
    const node = parseMath(expr);
    const vars = variablesOf(node);
    if (!vars.has('x') || vars.size !== 1) return null;
  } catch {
    return null;
  }
  return { expr, label: m ? m[1]!.replace(/\s+/g, '') : 'y' };
}

// ---- Plotting ---------------------------------------------------------------------------------------

/** Samples f over [x0, x1] into polylines, broken where it is undefined or jumps (asymptotes). */
export function sampleFunction(f: (x: number) => number, x0: number, x1: number, n: number, yRange: number): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  let prev: number | null = null;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = f(x);
    const ok = Number.isFinite(y);
    if (!ok || (prev !== null && Math.abs(y - prev) > yRange * 1.5)) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      prev = ok ? y : null;
      if (ok) cur.push({ x, y });
      continue;
    }
    cur.push({ x, y });
    prev = y;
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Real roots of f in [x0, x1]: sign changes refined by bisection (poles are rejected). */
export function findRoots(f: (x: number) => number, x0: number, x1: number, n = 600): number[] {
  const roots: number[] = [];
  let px = x0, py = f(x0);
  const push = (r: number) => {
    const tol = (x1 - x0) * 1e-6;
    if (!roots.some((q) => Math.abs(q - r) < tol * 10)) roots.push(Math.abs(r) < tol ? 0 : r);
  };
  if (py === 0) push(px);
  for (let i = 1; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = f(x);
    if (y === 0) push(x);
    else if (Number.isFinite(py) && Number.isFinite(y) && py !== 0 && Math.sign(y) !== Math.sign(py)) {
      let a = px, b = x, fa = py;
      for (let k = 0; k < 80; k++) {
        const m = (a + b) / 2, fm = f(m);
        if (!Number.isFinite(fm)) break;
        if (Math.sign(fm) === Math.sign(fa)) { a = m; fa = fm; } else b = m;
      }
      const r = (a + b) / 2;
      // A sign change across a pole is not a root.
      if (Math.abs(f(r)) < 1e-6 * Math.max(1, Math.abs(py), Math.abs(y))) push(r);
    }
    px = x; py = y;
  }
  return roots.sort((a, b) => a - b);
}

/** "Nice" tick values (1, 2, 5 × 10^k) covering [min, max] with about `count` ticks. */
export function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

/** Formats a number for labels: up to 4 significant decimals, no trailing zeros. */
export function formatMathNumber(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : 'undefined';
  if (Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4 && v !== 0)) return v.toExponential(3).replace(/\.?0+e/, 'e');
  return String(Number(v.toFixed(4))).replace('-', '−');
}

/** A view that shows the interesting part of the functions: y from robust percentiles of samples. */
export function autoView(exprs: readonly string[], xMin = -10, xMax = 10): GraphObject['view'] {
  const ys: number[] = [];
  for (const e of exprs) {
    const f = compileFunctionOfX(e);
    if (!f) continue;
    for (let i = 0; i <= 200; i++) { const y = f(xMin + ((xMax - xMin) * i) / 200); if (Number.isFinite(y)) ys.push(y); }
  }
  if (!ys.length) return { xMin, xMax, yMin: -10, yMax: 10 };
  ys.sort((a, b) => a - b);
  let lo = ys[Math.floor(ys.length * 0.05)]!, hi = ys[Math.floor(ys.length * 0.95)]!;
  lo = Math.min(lo, 0); hi = Math.max(hi, 0);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  return { xMin, xMax, yMin: lo - pad, yMax: hi + pad };
}

export interface GraphGeometry {
  /** Page-space plot area (inside the frame). */
  plot: { x: number; y: number; w: number; h: number };
  toPage: (x: number, y: number) => { x: number; y: number };
  xTicks: number[];
  yTicks: number[];
  curves: { color: string; label?: string; expr: string; lines: { x: number; y: number }[][]; roots: number[]; yIntercept: number | null }[];
}

/**
 * Everything needed to draw a graph object in page space, shared by the canvas renderer, the
 * SVG exporter and the PDF exporter so all three look the same.
 */
export function graphGeometry(g: GraphObject): GraphGeometry {
  const pad = 6;
  const plot = { x: g.x + pad, y: g.y + pad, w: Math.max(10, g.width - pad * 2), h: Math.max(10, g.height - pad * 2) };
  const { xMin, xMax, yMin, yMax } = g.view;
  const toPage = (x: number, y: number) => ({ x: plot.x + ((x - xMin) / (xMax - xMin)) * plot.w, y: plot.y + (1 - (y - yMin) / (yMax - yMin)) * plot.h });
  const n = Math.max(120, Math.min(1200, Math.round(plot.w * 1.5)));
  const curves = g.functions.map((fn) => {
    const f = compileFunctionOfX(fn.expr);
    if (!f) return { color: fn.color, label: fn.label, expr: fn.expr, lines: [], roots: [], yIntercept: null };
    const raw = sampleFunction(f, xMin, xMax, n, yMax - yMin);
    // Clip far outside the view so exports stay small and paths stay finite.
    const lim = (yMax - yMin) * 4;
    const lines = raw.map((l) => l.map((p) => toPage(p.x, Math.max(yMin - lim, Math.min(yMax + lim, p.y)))));
    const y0 = xMin <= 0 && xMax >= 0 ? f(0) : NaN;
    return { color: fn.color, label: fn.label, expr: fn.expr, lines, roots: findRoots(f, xMin, xMax), yIntercept: Number.isFinite(y0) ? y0 : null };
  });
  return { plot, toPage, xTicks: niceTicks(xMin, xMax, Math.max(3, Math.round(plot.w / 70))), yTicks: niceTicks(yMin, yMax, Math.max(3, Math.round(plot.h / 50))), curves };
}

/** Zooms a view about a point (graph coordinates) by factor k (<1 zooms in). */
export function zoomView(v: GraphObject['view'], k: number, cx = (v.xMin + v.xMax) / 2, cy = (v.yMin + v.yMax) / 2): GraphObject['view'] {
  return { xMin: cx + (v.xMin - cx) * k, xMax: cx + (v.xMax - cx) * k, yMin: cy + (v.yMin - cy) * k, yMax: cy + (v.yMax - cy) * k };
}

export function panView(v: GraphObject['view'], dx: number, dy: number): GraphObject['view'] {
  return { xMin: v.xMin + dx, xMax: v.xMax + dx, yMin: v.yMin + dy, yMax: v.yMax + dy };
}
