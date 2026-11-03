import { handwrite, layoutHandwriting, type HandwritingStyle } from '../../../../packages/core/src/handwrite.ts';
import { TOP_MARGIN, LEFT_MARGIN } from '../../../../packages/core/src/paper.ts';
import type { InkStroke, PaperSpec, PenType, RecognizedLine, TextBox } from '../../../../packages/core/src/model.ts';

/**
 * Realistic notebook content for the README showcase (e2e/showcase.spec.ts) and for the real MCP
 * session shown next to it (scripts/brand/showcase-mcp.ts). Everything handwritten is written by
 * the app's own synthesiser (`handwrite()`, packages/core/src/handwrite.ts), deterministic per
 * seed, so the same note is byte-identical in the browser's vault and in the folder the MCP server
 * reads. Recognized text is filled in as the on-device recognizer would, so search, Ask and MCP
 * clients see the words.
 */

export interface SeedPage {
  strokes: InkStroke[];
  texts?: TextBox[];
  recognizedText?: string;
  /** One entry per written line, with its strokes and bounds, as the on-device recognizer gives. */
  recognizedLines?: RecognizedLine[];
}

export interface SeedNote {
  title: string;
  notebook: string;
  tags: string[];
  paper: PaperSpec;
  pages: SeedPage[];
  /** Minutes before "now" the note was last edited (keeps the library's order and dates plausible). */
  agoMin: number;
}

export const NOTEBOOK_COLORS: Record<string, string> = {
  'Product': '#FFB3412F',
  'Calculus II': '#FF2E6B57',
  'Platform team': '#FF1F3A93',
  'Thesis': '#FF7A5410',
  'Clients': '#FF5F5666',
};

const INK = '#FF1F2433';
const BLUE = '#FF1F3A93';
const RED = '#FFB3412F';
const GREEN = '#FF2E7D57';
const HIGHLIGHT = '#FFFFD54A';
const RULE = 34;

const RULED: PaperSpec = { style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: RULE };
const DOTS: PaperSpec = { style: 'dot_grid', tint: 'white', texture: 'smooth', spacing: 0 };

/** Baseline of rule line `k` (0 = the first rule under the top margin). */
const rule = (k: number) => TOP_MARGIN + k * RULE;

interface WriteOpts { xHeight?: number; style?: HandwritingStyle; color?: string; pen?: PenType; indent?: number; width?: number; seed?: number; messiness?: number; lines?: number }

/**
 * Writes on ruled paper the way a person does: each line of text sits on a rule, a title takes
 * two rules. Returns the strokes and the recognized text, and where the next line goes.
 */
class RuledPage {
  strokes: InkStroke[] = [];
  recognized: string[] = [];
  lines: RecognizedLine[] = [];
  private seed: number;
  private clock: number;
  constructor(private x: number, public line: number, seed: number, start: number) { this.seed = seed; this.clock = start; }

  write(text: string, o: WriteOpts = {}) {
    const xh = o.xHeight ?? 10;
    const lines = o.lines ?? 1;
    const r = handwrite(text, {
      x: this.x + (o.indent ?? 0), y: rule(this.line + lines - 1) - xh - 1.5, width: (o.width ?? 590) - (o.indent ?? 0), xHeight: xh,
      lineHeight: RULE * lines, style: o.style ?? 'script', color: o.color ?? INK, pen: o.pen ?? 'fountain', seed: o.seed ?? ++this.seed,
      startTime: this.clock, messiness: o.messiness ?? 0.35,
    });
    this.strokes.push(...r.strokes);
    this.recognized.push(text);
    // Each visual line becomes a recognized line with its own strokes, like ML Kit's line anchors.
    const words = r.baselines.length > 1 ? layoutHandwriting(text, (o.width ?? 590) - (o.indent ?? 0), xh, o.style ?? 'script') : [text];
    r.baselines.forEach((b, i) => {
      const mine = r.strokes.filter((st) => {
        const ys = st.points.map((p) => p.y);
        const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
        return r.baselines.reduce((best, bb, j) => (Math.abs(bb - xh / 2 - mid) < Math.abs(r.baselines[best]! - xh / 2 - mid) ? j : best), 0) === i;
      });
      const xs = mine.flatMap((st) => st.points.map((p) => p.x)), ys = mine.flatMap((st) => st.points.map((p) => p.y));
      if (mine.length) this.lines.push({ text: words[i] ?? '', strokeIds: mine.map((st) => st.id), bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } });
    });
    this.clock = (r.strokes.at(-1)?.createdAt ?? this.clock) + 1800;
    const first = this.line;
    this.line += r.baselines.length * lines;
    return { firstLine: first, lastLine: this.line - 1, baselines: r.baselines, bottom: r.bottom, strokes: r.strokes, top: rule(first) - xh * 2.2 };
  }

  skip(n = 1) { this.line += n; }
  /** The page as seeded: ink plus what the recognizer would have read, line by line. */
  page(): SeedPage { return { strokes: this.strokes, recognizedText: this.lines.map((l) => l.text).join('\n'), recognizedLines: this.lines }; }
  now() { return this.clock; }
}

function polyline(points: [number, number][], pen: PenType, color: string, size: number, t0: number, origin?: InkStroke['origin']): InkStroke {
  return {
    id: `sc-${Math.round(points[0]![0] * 7 + points[0]![1] * 13)}-${t0.toString(36)}`, pen, color, size, createdAt: t0,
    points: points.map(([x, y], i) => ({ x, y, t: i * 9, p: 0.45 + 0.25 * Math.sin((Math.PI * i) / Math.max(1, points.length - 1)), tilt: -1, orient: -1 })),
    ...(origin ? { origin } : {}),
  };
}

/** A hand-drawn segment (a little wobble, sampled every ~6 page units). */
function stroke(x0: number, y0: number, x1: number, y1: number, pen: PenType, color: string, size: number, t0: number, wobble = 0.6, seed = 1): InkStroke {
  const n = Math.max(8, Math.round(Math.hypot(x1 - x0, y1 - y0) / 6));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push([x0 + (x1 - x0) * f + Math.sin(f * 9 + seed) * wobble, y0 + (y1 - y0) * f + Math.cos(f * 7 + seed) * wobble]);
  }
  return polyline(pts, pen, color, size, t0 + seed);
}

/** A hand-drawn checkbox on a baseline, optionally ticked. */
function checkbox(x: number, baseline: number, ticked: boolean, t0: number): InkStroke[] {
  const s = 13, y = baseline - s;
  const out = [stroke(x, y, x + s, y, 'ballpoint', INK, 1.3, t0, 0.2, 1), stroke(x + s, y, x + s, y + s, 'ballpoint', INK, 1.3, t0, 0.2, 2), stroke(x + s, y + s, x, y + s, 'ballpoint', INK, 1.3, t0, 0.2, 3), stroke(x, y + s, x, y, 'ballpoint', INK, 1.3, t0, 0.2, 4)];
  if (ticked) out.push(polyline([[x + 2, y + 7], [x + 6, y + 12], [x + 17, y - 6]], 'fountain', GREEN, 2.2, t0 + 5));
  return out;
}

const HOUR_MS = 3600_000;

/**
 * The hero note: a product meeting written by hand. In the showcase the question at the bottom is
 * lassoed and answered in AI ink (live, by the app), and the same note is found by an MCP client.
 */
export function launchSync(now: number): SeedNote {
  const t0 = now - 26 * 60_000;
  const w = new RuledPage(LEFT_MARGIN + 14, 1, 410, t0);
  w.write('Beta launch sync', { xHeight: 15, lines: 2, seed: 401 });
  const title = w.strokes.slice();
  w.strokes.push(stroke(LEFT_MARGIN + 8, rule(2) + 4, LEFT_MARGIN + 300, rule(2) + 3, 'highlighter', HIGHLIGHT, 13, w.now()));
  void title;
  w.skip();
  w.write('Beta goes to 200 people on Nov 18.');
  w.write('Priya - sync fix lands Friday,');
  w.write('then a week of soak tests.', { indent: 24 });
  w.write('Pricing unchanged, students free.');
  const risk = w.write('Risk - pen lag on older tablets.', { color: RED });
  void risk;
  w.skip();
  w.write('Actions', { xHeight: 11, style: 'print' });
  const items: [string, boolean][] = [['Dev - release notes draft', true], ['Sam - book the design review', false], ['Me - email the waitlist Nov 17', false]];
  for (const [text, done] of items) {
    const r = w.write(text, { style: 'print', indent: 30, xHeight: 9 });
    w.strokes.push(...checkbox(LEFT_MARGIN + 16, r.baselines[0]!, done, w.now()));
  }
  w.skip();
  w.write('What is still blocking the beta?', { color: BLUE, seed: 433 });
  return { title: 'Beta launch sync', notebook: 'Product', tags: ['meeting', 'launch'], paper: RULED, pages: [w.page()], agoMin: 26 };
}

/** Where the hero's question sits (page units), for the lasso. */
export const LAUNCH_QUESTION_LINE = 15;

/** Lecture notes around a linear equation the student solves on the device. */
export function lecture(now: number): SeedNote {
  const t0 = now - 3 * HOUR_MS;
  const w = new RuledPage(LEFT_MARGIN + 14, 1, 520, t0);
  w.write('Lecture 9 — linear equations', { xHeight: 14, lines: 2 });
  w.write('Goal - get x on its own.');
  w.write('Do the same to both sides.');
  w.write('undo adding first, then multiplying', { style: 'print', color: BLUE, xHeight: 9, indent: 20 });
  w.write('Check by putting x back in.');
  w.skip(4);
  w.write('Exam - show every step, or half marks.', { color: RED, xHeight: 9 });
  return { title: 'Lecture 9 — linear equations', notebook: 'Calculus II', tags: ['lecture', 'exam'], paper: RULED, pages: [w.page()], agoMin: 180 };
}

/** Handwritten definitions the study deck is made from. */
export function studyNotes(now: number): SeedNote {
  const t0 = now - 2 * 24 * HOUR_MS;
  const w = new RuledPage(LEFT_MARGIN + 14, 1, 610, t0);
  w.write('Week 6 — series', { xHeight: 14, lines: 2 });
  w.write('Harmonic series - the sum of 1/n, diverges.');
  w.write('Geometric series - converges when |r| < 1.');
  w.write('p-series - converges when p > 1.');
  w.write('Telescoping series - terms cancel in pairs.');
  w.write('Ratio test - limit below 1, it converges.');
  return { title: 'Week 6 — series', notebook: 'Calculus II', tags: ['study'], paper: RULED, pages: [w.page()], agoMin: 2 * 24 * 60 };
}

/** Two notes from a thesis project that disagree; the linter flags them. */
export function thesisNotes(now: number): SeedNote[] {
  const mk = (title: string, body: string, agoMin: number, seed: number): SeedNote => {
    const w = new RuledPage(LEFT_MARGIN + 14, 1, seed, now - agoMin * 60_000);
    w.write(title, { xHeight: 14, lines: 2 });
    for (const line of body.split('\n')) w.write(line);
    return { title, notebook: 'Thesis', tags: ['thesis'], paper: RULED, pages: [w.page()], agoMin };
  };
  return [
    mk('Methods — sampling', 'Survey ran from March to May.\nResponse rate must stay above 40%.\nWe weight answers by region.', 5 * 24 * 60, 700),
    mk('Results — first pass', 'The pilot response rate averages 23%.\nRural sites answered least.', 2 * 24 * 60, 720),
  ];
}

/** A design-review page an engineer links to code ([[code:…]]) and sketches a pipeline on. */
export function reviewText(): string {
  return 'Sessions start in [[code:src/auth.ts#createSession]]. Tokens live 24 h, then the user signs in again.';
}

/** Writes free-standing handwriting at a page position (used for labels and margin notes). */
export function handAt(text: string, x: number, y: number, o: WriteOpts & { t?: number } = {}) {
  return handwrite(text, { x, y, width: o.width ?? 600, xHeight: o.xHeight ?? 8, style: o.style ?? 'print', color: o.color ?? INK, pen: o.pen ?? 'fountain', seed: o.seed ?? Math.round(x + y), startTime: o.t ?? Date.now(), messiness: o.messiness ?? 0.35 });
}

export const COLORS = { INK, BLUE, RED, GREEN };
export { rule, RULE, stroke, polyline };
