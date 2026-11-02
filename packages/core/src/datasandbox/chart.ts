import type { QueryResult } from './query.ts';

/**
 * Charts of query results, as standalone SVG (the app rasterizes it into an image on the page, so
 * it shows in thumbnails, exports and sync like any picture). Kept deliberately plain: one y
 * axis, thin marks, rounded bar ends at the baseline with a 2 px gap, a recessive grid, a legend
 * only for two or more series, text in ink colours (never the series colour). Series colours come
 * in a fixed order validated for colour-vision deficiency and ≥ 3:1 contrast on paper
 * (`CHART_COLORS`); a fifth series is never invented — charts carry at most four.
 */

export type ChartKind = 'bar' | 'line';

export interface ChartSpec {
  kind: ChartKind;
  /** Column for categories (bar) or the x axis (line). */
  x: string;
  /** Numeric columns plotted as series (≤ 4). */
  y: string[];
  title?: string;
}

/** Categorical order, validated with the dataviz palette checks on light paper. */
export const CHART_COLORS = ['#2F6FB5', '#C46A1C', '#00957F', '#7A3E9D'] as const;
const INK = '#2B2330';
const INK_2 = '#5F5666';
const GRID = 'rgba(43,35,48,0.12)';

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * A sensible chart for a result: the first non-numeric column (or the first column) as x, the
 * numeric columns as series; a line when x looks like time or an ordered number, else bars.
 * Null when there is nothing numeric to plot.
 */
export function inferChart(r: QueryResult, title?: string): ChartSpec | null {
  if (!r.rows.length || !r.columns.length) return null;
  const numeric = r.columns.filter((_, i) => r.rows.every((row) => row[i] == null || isNum(row[i])) && r.rows.some((row) => isNum(row[i])));
  let x = r.columns.find((c) => !numeric.includes(c));
  let y = numeric.filter((c) => c !== x);
  if (!x) {
    if (numeric.length < 2) return null;
    x = numeric[0]!;
    y = numeric.slice(1);
  }
  if (!y.length) return null;
  const xi = r.columns.indexOf(x);
  const xs = r.rows.map((row) => row[xi]);
  const timeLike = xs.every((v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?/.test(v)) || /^(date|day|month|year|week|time)/i.test(x) || xs.every(isNum);
  return { kind: timeLike && r.rows.length > 2 ? 'line' : 'bar', x, y: y.slice(0, CHART_COLORS.length), ...(title ? { title } : {}) };
}

/** Round, readable axis steps (1, 2, 2.5, 5 × 10^n). */
export function chartTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) { const v = Number.isFinite(min) ? min : 0; return [v === 0 ? 0 : Math.min(0, v), v === 0 ? 1 : Math.max(0, v)]; }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function formatChartTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return String(+v.toFixed(2));
}

/** Renders the chart as an SVG document string. */
export function chartSvg(spec: ChartSpec, r: QueryResult, o: { width?: number; height?: number; font?: string } = {}): string {
  const W = o.width ?? 480, H = o.height ?? 300;
  const font = o.font ?? 'system-ui, sans-serif';
  const xi = r.columns.indexOf(spec.x);
  const series = spec.y.slice(0, CHART_COLORS.length).map((name) => ({ name, i: r.columns.indexOf(name) })).filter((s) => s.i >= 0);
  const rows = r.rows.slice(0, spec.kind === 'bar' ? 40 : 2000);
  const values = rows.flatMap((row) => series.map((s) => row[s.i])).filter(isNum) as number[];
  const ticks = chartTicks(Math.min(0, ...values), Math.max(0, ...values));
  const top = spec.title ? 34 : 14;
  const legendH = series.length > 1 ? 22 : 0;
  const left = 12 + Math.max(...ticks.map((t) => formatChartTick(t).length)) * 6.6;
  const right = 12, bottom = 40 + legendH;
  const pw = W - left - right, ph = H - top - bottom;
  const y0 = ticks[0]!, y1 = ticks[ticks.length - 1]!;
  const sy = (v: number) => top + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(font)}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#FFFFFF" rx="6"/>`);
  if (spec.title) parts.push(`<text x="${left}" y="22" font-size="14" font-weight="600" fill="${INK}">${esc(spec.title)}</text>`);
  for (const t of ticks) {
    const y = sy(t);
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${t === 0 ? 'rgba(43,35,48,0.35)' : GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${left - 6}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${INK_2}">${formatChartTick(t)}</text>`);
  }
  const label = (v: unknown) => { const s = v == null ? '—' : String(v); return s.length > 14 ? `${s.slice(0, 13)}…` : s; };
  const n = Math.max(1, rows.length);
  const every = Math.ceil(n / Math.max(1, Math.floor(pw / 64)));
  if (spec.kind === 'bar') {
    const band = pw / n;
    const gap = 2;
    const bw = Math.max(2, (band * 0.72 - gap * (series.length - 1)) / Math.max(1, series.length));
    rows.forEach((row, k) => {
      const bx = left + k * band + (band - (bw * series.length + gap * (series.length - 1))) / 2;
      series.forEach((s, j) => {
        const v = row[s.i];
        if (!isNum(v)) return;
        const ya = sy(Math.max(0, v as number)), yb = sy(Math.min(0, v as number));
        const h = Math.max(0.5, yb - ya);
        const x = bx + j * (bw + gap);
        const rad = Math.min(4, bw / 2, h);
        // Rounded at the data end, square at the baseline.
        const d = (v as number) >= 0
          ? `M${x},${yb} V${ya + rad} Q${x},${ya} ${x + rad},${ya} H${x + bw - rad} Q${x + bw},${ya} ${x + bw},${ya + rad} V${yb} Z`
          : `M${x},${ya} V${yb - rad} Q${x},${yb} ${x + rad},${yb} H${x + bw - rad} Q${x + bw},${yb} ${x + bw},${yb - rad} V${ya} Z`;
        parts.push(`<path d="${d}" fill="${CHART_COLORS[j]}"><title>${esc(`${label(row[xi])} · ${s.name}: ${v}`)}</title></path>`);
      });
      if (k % every === 0) parts.push(`<text x="${(left + k * band + band / 2).toFixed(1)}" y="${top + ph + 16}" font-size="11" text-anchor="middle" fill="${INK_2}">${esc(label(row[xi]))}</text>`);
    });
  } else {
    const sx = (k: number) => left + (n === 1 ? pw / 2 : (k / (n - 1)) * pw);
    series.forEach((s, j) => {
      const pts = rows.map((row, k) => (isNum(row[s.i]) ? `${sx(k).toFixed(1)},${sy(row[s.i] as number).toFixed(1)}` : null));
      const runs: string[][] = [[]];
      for (const p of pts) { if (p) runs[runs.length - 1]!.push(p); else if (runs[runs.length - 1]!.length) runs.push([]); }
      for (const run of runs) if (run.length) parts.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${CHART_COLORS[j]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (rows.length <= 24) rows.forEach((row, k) => { if (isNum(row[s.i])) parts.push(`<circle cx="${sx(k).toFixed(1)}" cy="${sy(row[s.i] as number).toFixed(1)}" r="4" fill="${CHART_COLORS[j]}" stroke="#FFFFFF" stroke-width="2"><title>${esc(`${label(row[xi])} · ${s.name}: ${row[s.i]}`)}</title></circle>`); });
    });
    rows.forEach((row, k) => { if (k % every === 0) parts.push(`<text x="${sx(k).toFixed(1)}" y="${top + ph + 16}" font-size="11" text-anchor="middle" fill="${INK_2}">${esc(label(row[xi]))}</text>`); });
  }
  parts.push(`<text x="${left + pw / 2}" y="${top + ph + 32}" font-size="11" text-anchor="middle" fill="${INK_2}">${esc(spec.x)}</text>`);
  if (series.length > 1) {
    let lx = left;
    const ly = H - 10;
    series.forEach((s, j) => {
      parts.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${CHART_COLORS[j]}"/>`);
      parts.push(`<text x="${lx + 14}" y="${ly}" font-size="11" fill="${INK}">${esc(s.name)}</text>`);
      lx += 26 + s.name.length * 6.6;
    });
  } else if (series[0] && !spec.title) {
    parts.push(`<text x="${left}" y="10" font-size="11" fill="${INK_2}">${esc(series[0].name)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}
