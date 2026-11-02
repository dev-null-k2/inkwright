import { afterAll, describe, expect, it } from 'vitest';
import { createScriptedProvider } from '../src/index.ts';
import { AGENT_CASES } from './cases.ts';
import { formatTable, liveConfig, printReport, runCase, type CaseResult } from './harness.ts';

const live = liveConfig();

describe('agent evals — scripted model (deterministic)', () => {
  const results: CaseResult[] = [];
  afterAll(() => printReport(formatTable('Inkwright agent evals — scripted', results)));

  for (const c of AGENT_CASES) {
    it(`${c.id}: ${c.description}`, async () => {
      const r = await runCase(c, { name: 'scripted', model: 'scripted' });
      results.push(r);
      expect(r.error).toBeUndefined();
      expect(r.checks.filter((x) => !x.pass).map((x) => x.name)).toEqual([]);
      expect(r.score).toBe(1);
    });
  }

  // The checks must be able to fail: a model that misbehaves has to score below 1.
  it('harness catches bad behaviour (negative controls)', async () => {
    const grocery = AGENT_CASES.find((c) => c.id === 'grocery-note')!;
    const sloppy = await runCase({ ...grocery, script: [{ toolCalls: [{ name: 'create_note', arguments: { title: 'List', text: 'eggs, milk' } }] }, { text: 'Done' }] }, { name: 'scripted', model: 'x' });
    expect(sloppy.score).toBeLessThan(0.5);

    const trash = AGENT_CASES.find((c) => c.id === 'trash-declined')!;
    // A model that claims success and trashes the wrong note.
    const reckless = await runCase(
      {
        ...trash,
        script: [
          { toolCalls: [{ name: 'list_notes', arguments: {} }] },
          (ctx) => ({ toolCalls: [{ name: 'trash_note', arguments: { note_id: (ctx.toolResults[0]!.value as any).notes[0].id } }] }),
          { text: 'Deleted it!' },
        ],
      },
      { name: 'scripted', model: 'x' },
    );
    expect(reckless.score).toBeLessThan(0.7);

    const chatty = AGENT_CASES.find((c) => c.id === 'chitchat-no-writes')!;
    const writer = await runCase({ ...chatty, script: [{ toolCalls: [{ name: 'create_note', arguments: { title: 'Hi', text: 'hello' } }] }, { text: 'Hi' }] }, { name: 'scripted', model: 'x' });
    expect(writer.score).toBeLessThan(1);

    // Provider failures score 0 and are reported.
    const broken = await runCase(grocery, { name: 'scripted', model: 'x', provider: createScriptedProvider(() => { throw new Error('model offline'); }) });
    expect(broken.score).toBe(0);
    expect(broken.error).toMatch(/model offline/);
  });
});

describe.skipIf(!live)(`agent evals — live (${live?.label ?? 'set INKWRIGHT_EVAL_PROVIDER/KEY/MODEL'})`, () => {
  const results: CaseResult[] = [];
  afterAll(() => printReport(formatTable(`Inkwright agent evals — live ${live!.label}`, results)));

  for (const c of AGENT_CASES) {
    it(c.id, async () => {
      const r = await runCase(c, { name: 'live', provider: live!.provider, model: live!.model });
      results.push(r);
      // Live models are not deterministic: report scores, fail only below INKWRIGHT_EVAL_MIN_SCORE.
      expect(r.score).toBeGreaterThanOrEqual(live!.minScore);
    });
  }
});
