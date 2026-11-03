import { describe, expect, it } from 'vitest';
import { builtInRecognizer, readMathInk, type SymbolRecognizer } from '@inkwright/core';
import { readFileSync } from 'node:fs';
import { parseSamplesFile, sampleToInk } from '../src/devicecheck/samples.ts';
import { solveMath } from '../src/smart/math.ts';
import { simulatedLineText, simulatedMlKit } from './mathink/mlkitsim.ts';
import { sameMaths } from './mathink/score.ts';
import { makeCases, writeCase, type Case } from './mathink/synth.ts';

/**
 * Handwritten maths eval (docs/MATH.md): 350 synthetic problems — 70 each of arithmetic,
 * fractions, powers & roots, equations and systems — written as strokes in three hands, read by
 *  - "before": the old on-device path (ML Kit reads whole lines as text; the solver gets the text),
 *  - "after · ML Kit (simulated)": the new reader with ML Kit's per-symbol behaviour modelled,
 *  - "after · built-in": the new reader with its own on-device classifier (the web fallback), by hand,
 * and scored on exact match (the reading means the same maths as the truth) and solve-correct
 * (the solver's answer equals the answer to the true problem). Seeded and deterministic.
 */

const cases = makeCases(70);

interface Row { case: Case; exact: boolean; solved: boolean; got: string; ms: number }

async function answer(src: string): Promise<string | null> {
  try { return (await solveMath(src)).result; } catch { return null; }
}

const truths = new Map<string, string | null>();
async function truthAnswer(c: Case) {
  if (!truths.has(c.id)) truths.set(c.id, await answer(c.truth));
  return truths.get(c.id)!;
}

async function run(read: (c: Case) => Promise<string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of cases) {
    const t0 = performance.now();
    let got = '';
    try { got = await read(c); } catch { got = ''; }
    const ms = performance.now() - t0;
    const want = await truthAnswer(c);
    const ans = got ? await answer(got) : null;
    rows.push({ case: c, exact: !!got && sameMaths(got, c.truth), solved: ans != null && ans === want, got, ms });
  }
  return rows;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

function table(title: string, rows: Row[], by: (r: Row) => string): string {
  const keys = [...new Set(rows.map(by))];
  const lines = [`${title}`, '| | cases | exact match | solve-correct | ms / problem |', '|---|---:|---:|---:|---:|'];
  for (const k of [...keys, 'all']) {
    const sel = k === 'all' ? rows : rows.filter((r) => by(r) === k);
    const ms = sel.reduce((a, r) => a + r.ms, 0) / Math.max(1, sel.length);
    lines.push(`| ${k} | ${sel.length} | ${pct(sel.filter((r) => r.exact).length, sel.length)} | ${pct(sel.filter((r) => r.solved).length, sel.length)} | ${ms.toFixed(0)} |`);
  }
  return lines.join('\n');
}

const rate = (rows: Row[], f: (r: Row) => boolean) => rows.filter(f).length / rows.length;
const failures = (rows: Row[], n = 12) => rows.filter((r) => !r.exact).slice(0, n).map((r) => `  ${r.case.id} [${r.case.hand}] want ${JSON.stringify(r.case.truth)} got ${JSON.stringify(r.got)}`).join('\n');

describe('handwritten maths', () => {
  it('has a solvable truth for every case', async () => {
    expect(cases.length).toBe(350);
    for (const c of cases) expect(await truthAnswer(c), c.truth).not.toBeNull();
  });

  it('before: whole-line text recognition (ML Kit simulated) → solver', async () => {
    const rows = await run(async (c) => simulatedLineText(writeCase(c), c.seed));
    console.log(table('Before — old on-device path', rows, (r) => r.case.category));
    console.log(failures(rows, 6));
  });

  it('after: stroke-level reader with ML Kit (simulated)', async () => {
    const rows = await run(async (c) => {
      const w = writeCase(c);
      return (await readMathInk(w.strokes, simulatedMlKit(w, c.seed) as SymbolRecognizer)).plain;
    });
    console.log(table('After — ML Kit (simulated) symbols', rows, (r) => r.case.category));
    console.log(failures(rows));
    // The quality bar: regressions below these fail the eval.
    expect(rate(rows, (r) => r.exact)).toBeGreaterThan(0.85);
    expect(rate(rows, (r) => r.solved)).toBeGreaterThan(0.85);
  });

  it('after: stroke-level reader with the built-in classifier', async () => {
    const rows = await run(async (c) => (await readMathInk(writeCase(c).strokes, builtInRecognizer)).plain);
    console.log(table('After — built-in classifier, by category', rows, (r) => r.case.category));
    console.log(table('After — built-in classifier, by hand (C is not in its templates)', rows, (r) => r.case.hand));
    console.log(failures(rows));
    expect(rate(rows.filter((r) => r.case.hand !== 'C'), (r) => r.exact)).toBeGreaterThan(0.75);
  });

  // Real handwriting: INKWRIGHT_SAMPLES=path/to/inkwright-handwriting-samples-….json (recorded in
  // Settings › About › Check this device). Reports what the phone read when the sample was saved
  // (ML Kit there) and what the built-in classifier reads here, against what the writer meant.
  it.runIf(!!process.env.INKWRIGHT_SAMPLES)('real samples from a device', async () => {
    const file = parseSamplesFile(readFileSync(process.env.INKWRIGHT_SAMPLES!, 'utf8'));
    let device = 0, here = 0;
    const misses: string[] = [];
    for (const [i, s] of file.samples.entries()) {
      if (s.read?.plain && sameMaths(s.read.plain, s.label)) device++;
      const r = await readMathInk(sampleToInk(s, `s${i}-`), builtInRecognizer);
      if (sameMaths(r.plain, s.label)) here++;
      else misses.push(`  ${JSON.stringify(s.label)}: device ${JSON.stringify(s.read?.plain ?? '')}, built-in ${JSON.stringify(r.plain)}`);
    }
    const n = file.samples.length;
    console.log(`Real samples (${n}, ${file.device.platform}): on the device ${pct(device, n)}, built-in classifier ${pct(here, n)}\n${misses.slice(0, 20).join('\n')}`);
  });
});
