/**
 * Enhanced meeting notes with the real on-device models (opt-in: INKWRIGHT_REAL_MODELS=meetings,
 * model via INKWRIGHT_EVAL_MODEL, default Qwen3 1.7B). A realistic sales call: rough notes plus
 * a stamped transcript go through `enhanceMessages`, the reply through `parseEnhancedNotes`, and
 * the result is checked for what people rely on: their own notes all there and marked, details
 * from the transcript with valid times, the decisions and action items with owners, no invented
 * numbers. Prints the notes and a score.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { findTemplate, meetingMarkdown } from '@inkwright/core';
import { enhanceMessages, parseEnhancedNotes, versionFromParsed, type StampedLine } from '../src/index.ts';
import { createNodeEngine, nodeModelRef, type NodeEngine } from './node-engine.ts';

const ENABLED = /meetings|all/.test(process.env.INKWRIGHT_REAL_MODELS ?? '');
const MODEL = process.env.INKWRIGHT_EVAL_MODEL || 'qwen3-1.7b';

const NOTES = `acme - 40 reps
using spreadsheets, hate it
security review?
price`;

const T: Array<[string, string]> = [
  ['0:04', 'Thanks for making time, Dana. Could you tell me a bit about the team?'],
  ['0:11', 'Sure. I run sales operations at Acme. We have about forty reps across two regions.'],
  ['0:24', 'Right now everything lives in spreadsheets and honestly everyone hates it. Forecasts take two days every month.'],
  ['0:41', 'We tried Salesforce a few years ago but the rollout stalled.'],
  ['0:55', 'What would make this a success for you?'],
  ['1:02', 'If forecasting took an afternoon instead of two days, that alone pays for it.'],
  ['1:20', 'Who else is involved in the decision?'],
  ['1:26', 'Our CFO, Priya, signs off on anything over twenty thousand a year. And IT has to do a security review.'],
  ['1:44', 'Security review usually takes them about three weeks.'],
  ['2:02', 'On price, we are at twenty-four dollars per rep per month for the team plan.'],
  ['2:15', 'That is within budget if the security review passes.'],
  ['2:30', 'Great. So next steps: I will send our SOC 2 report today, and you will introduce me to Priya.'],
  ['2:41', 'Yes, I can set up a call with Priya next week.'],
  ['2:50', 'And we agreed to start a pilot with the east region team in December.'],
];
const transcript: StampedLine[] = T.map(([t, text]) => { const [m, s] = t.split(':').map(Number); return { ms: (m! * 60 + s!) * 1000, text }; });

describe.skipIf(!ENABLED)(`meetings eval: ${MODEL}`, () => {
  let engine: NodeEngine;
  afterAll(async () => { await engine?.unload(); });

  it('turns rough notes and a transcript into complete, grounded notes', async () => {
    engine = await createNodeEngine();
    const template = findTemplate('sales-call');
    const messages = enhanceMessages({ title: 'Acme discovery call', template, notes: NOTES, transcript, attendees: [{ name: 'Dana' }], language: 'en' });
    const t0 = Date.now();
    const r = await engine.generate(nodeModelRef(MODEL), { messages: messages.map((m) => ({ role: m.role as 'system' | 'user', content: String(m.content) })), maxTokens: 900, temperature: 0.2 }, () => {});
    const secs = (Date.now() - t0) / 1000;
    if (process.env.INKWRIGHT_EVAL_OUT) (await import('node:fs')).writeFileSync(process.env.INKWRIGHT_EVAL_OUT, r.text);
    const p = parseEnhancedNotes(r.text, { notes: NOTES, clipId: 'c', durationMs: 180_000, headings: template.sections.map((s) => s.heading), transcript });
    const v = versionFromParsed(p, { by: MODEL, template: template.id, clipIds: ['c'], reason: 'enhance' });
    const md = meetingMarkdown({ title: 'Acme discovery call' }, v);
    const items = p.sections.flatMap((s) => s.items);
    const all = md.toLowerCase();
    const checks: Array<[string, boolean]> = [
      ['every note line is there and marked as theirs', items.filter((i) => i.mine).length >= 4],
      ['few note lines had to be put back', p.restored <= 2],
      ['details from the transcript, with times', items.filter((i) => !i.mine && i.cites?.length).length >= 3],
      ['all times are within the recording', items.every((i) => (i.cites ?? []).every((c) => c <= 180_000))],
      ['forty reps', /40|forty/.test(all)],
      ['CFO Priya signs off', /priya/.test(all)],
      ['three-week security review', /three weeks|3 weeks|3-week|three-week/.test(all)],
      ['$24 per rep', /24|twenty-four/.test(all)],
      ['an action item for the SOC 2 report', /soc ?2/.test(all)],
      ['the pilot in December', /december/.test(all) && /pilot/.test(all)],
      ['no invented big numbers', !/\$\s?\d{3,}|\b(100|200|500)\b/.test(all.replace(/20,?000|twenty thousand/g, ''))],
    ];
    const score = checks.filter(([, ok]) => ok).length;
    console.log(`\n${MODEL}: ${secs.toFixed(0)} s, ${r.outputTokens} tokens\n${md}\n${checks.map(([n, ok]) => `${ok ? 'PASS' : 'FAIL'} ${n}`).join('\n')}\nscore ${score}/${checks.length}\n`);
    expect(items.filter((i) => i.mine).length).toBeGreaterThanOrEqual(4);
    expect(score).toBeGreaterThanOrEqual(checks.length - 3);
  }, 1_800_000);
});
