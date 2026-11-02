import { describe, expect, it } from 'vitest';
import { extractGraph } from '../src/index.ts';
import { generateSketch } from '../test/fixtures/sketches.ts';
import { scoreSketch } from '../test/fixtures/score-sketch.ts';

/**
 * Graph-extraction eval for the executable canvas: 120 synthetic hand-drawn diagrams (two to six
 * boxes drawn four ways, labels handwritten with handwrite() or typed, arrows with V heads, single
 * barbs, hooks or no head, some drawn backwards, some cycles; see test/fixtures/sketches.ts).
 *
 * Bar: node F1 ≥ 0.98, directed-edge F1 ≥ 0.97, cycle detection right ≥ 0.97, whole diagram
 * exactly right (every box, label, edge and direction) ≥ 0.90. Measured on 2 Nov 2026: 1.0 on
 * every measure (120/120 exact). The sketches are synthetic, so this bounds the geometry, not
 * people's drawing habits; see docs/INK_ACTIONS.md for what real sketches add.
 */
describe('executable canvas: graph extraction', () => {
  it('meets the bar over 120 synthetic sketches', () => {
    const N = 120;
    let nTp = 0, nFound = 0, nTrue = 0, eTp = 0, eFound = 0, eTrue = 0, exact = 0, cyc = 0, labels = 0;
    const failures: number[] = [];
    for (let seed = 1; seed <= N; seed++) {
      const s = generateSketch(seed);
      const r = scoreSketch(s, extractGraph(s));
      nTp += r.nodeTp; nFound += r.nodesFound; nTrue += r.nodesTrue;
      eTp += r.edgeTp; eFound += r.edgesFound; eTrue += r.edgesTrue;
      labels += r.labelsOk;
      if (r.exact) exact++; else failures.push(seed);
      if (r.cycleOk) cyc++;
    }
    const f1 = (tp: number, found: number, truth: number) => (2 * tp) / (found + truth || 1);
    const report = {
      nodeF1: +f1(nTp, nFound, nTrue).toFixed(3),
      edgeF1: +f1(eTp, eFound, eTrue).toFixed(3),
      labels: +(labels / nTrue).toFixed(3),
      cycles: +(cyc / N).toFixed(3),
      exact: +(exact / N).toFixed(3),
      failures: failures.slice(0, 15),
    };
    console.log('canvas graph extraction', JSON.stringify(report));
    expect(report.nodeF1).toBeGreaterThanOrEqual(0.98);
    expect(report.edgeF1).toBeGreaterThanOrEqual(0.97);
    expect(report.cycles).toBeGreaterThanOrEqual(0.97);
    expect(report.exact).toBeGreaterThanOrEqual(0.9);
  });
});
