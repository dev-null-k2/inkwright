/**
 * `npm run eval:local`: the local-model evals (local-model.ts) in a plain Node process, so a
 * 1.7B model fits in memory beside nothing else. Prints each case as it finishes and the pass
 * rates at the end; `--json <file>` also writes every reply and raw model turn.
 *
 *   npm run eval:local -- --model qwen3-1.7b --context 4096 --flows before,after --only page-budget,lasso-sum
 *
 * Weights are cached in INKWRIGHT_MODEL_CACHE (default: the OS temp folder), never in the repo.
 * With `--json` the results file is written after every case, and `--resume` skips the cases it
 * already has — a long CPU run that gets interrupted picks up where it stopped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CASES, describeResult, evaluate, summarize, type EvalResult } from './local-model.ts';
import { createNodeEngine } from './node-engine.ts';

const { values } = parseArgs({ options: { model: { type: 'string', default: 'qwen3-1.7b' }, context: { type: 'string', default: '4096' }, flows: { type: 'string', default: 'before,after' }, only: { type: 'string' }, json: { type: 'string' }, resume: { type: 'boolean', default: false } } });
const settings = { model: values.model!, context: Number(values.context) };
const flows = values.flows!.split(',').map((s) => s.trim()) as Array<'before' | 'after'>;
const only = values.only?.split(',').map((s) => s.trim());
const cases = CASES.filter((c) => !only || only.includes(c.id));
const engine = await createNodeEngine();
const save = () => { if (values.json) writeFileSync(values.json, JSON.stringify({ ...settings, at: new Date().toISOString(), results }, null, 2)); };
const results: EvalResult[] = values.resume && values.json && existsSync(values.json) ? (JSON.parse(readFileSync(values.json, 'utf8')) as { results: EvalResult[] }).results : [];
for (const flow of flows) {
  for (const c of cases) {
    if (results.some((r) => r.flow === flow && r.id === c.id && !r.error)) continue;
    const r = await evaluate(flow, c, engine, settings);
    const i = results.findIndex((x) => x.flow === flow && x.id === c.id);
    if (i >= 0) results[i] = r;
    else results.push(r);
    console.log(describeResult(r));
    save();
  }
}
console.log(`\n${summarize(results, settings)}`);
save();
await engine.unload();
