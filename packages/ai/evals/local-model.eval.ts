/**
 * The local-model evals (local-model.ts) inside vitest, opt-in: INKWRIGHT_REAL_MODELS=assistant.
 * Defaults to Qwen3 0.6B here, which fits beside vitest's own processes; `npm run eval:local`
 * (run-local-model.ts) runs Qwen3 1.7B in a plain Node process. docs/LOCAL_AI.md has the results.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { CASES, describeResult, evaluate, summarize, type EvalResult, type EvalSettings } from './local-model.ts';
import { createNodeEngine, type NodeEngine } from './node-engine.ts';

const ENABLED = /assistant|^1$|all/.test(process.env.INKWRIGHT_REAL_MODELS ?? '');
const S: EvalSettings = { model: process.env.INKWRIGHT_EVAL_MODEL || 'qwen3-0.6b', context: Number(process.env.INKWRIGHT_EVAL_CONTEXT || 4096) };
const FLOWS = (process.env.INKWRIGHT_EVAL_FLOWS || 'before,after').split(',').map((s) => s.trim()) as Array<'before' | 'after'>;
const results: EvalResult[] = [];

describe.skipIf(!ENABLED)(`local model evals: ${S.model}`, () => {
  let engine: NodeEngine;
  for (const flow of FLOWS) {
    for (const c of CASES) {
      it(`${flow} · ${c.id}: ${c.what}`, async () => {
        engine ??= await createNodeEngine();
        const r = await evaluate(flow, c, engine, S);
        results.push(r);
        console.log(describeResult(r));
        expect(r.error).toBeUndefined();
      }, 900_000);
    }
  }
  afterAll(async () => {
    if (results.length) console.log(`\n${summarize(results, S)}\n`);
    await engine?.unload();
  });
});
