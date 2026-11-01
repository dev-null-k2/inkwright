/**
 * Skill evals: each case feeds a fixed input through a button skill and checks the parsed output.
 * Scripted mode replays realistic messy model replies (fences, preambles, field-name drift) to
 * measure parser robustness; live mode sends the same inputs to a real model.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  MemoryNoteToolHost,
  answerFromNotes,
  createScriptedProvider,
  extractTodos,
  makeFlashcards,
  runSkill,
  suggestTags,
  suggestTitle,
  summarizeNote,
  translate,
  type Provider,
} from '../src/index.ts';
import { formatTable, liveConfig, printReport, type CaseResult } from './harness.ts';

interface SkillCase {
  id: string;
  /** Messy but plausible reply used in scripted mode. */
  scripted: string;
  run: (provider: Provider, model: string) => Promise<unknown>;
  checks: Array<[name: string, test: (out: any) => boolean]>;
}

const MEETING = `Meeting notes 10/30
- Sam to send the pitch deck to investors by Friday
- [x] booked the conference room
We discussed Q3 pricing at length; no decision.
TODO: renew the domain before Nov 15`;

const SKILL_CASES: SkillCase[] = [
  {
    id: 'todos',
    scripted: 'Sure! Here are the action items I found:\n```json\n{"todos": [\n  {"task": "Send the pitch deck to investors", "due_date": "2026-11-06"},\n  {"text": "Book the conference room", "completed": true},\n  {"text": "Renew the domain", "due": "2026-11-15"},\n]}\n```',
    run: (p, m) => runSkill(extractTodos, p, m, { text: MEETING, today: '2026-11-01' }),
    checks: [
      ['finds the deck task', (o) => o.some((t: any) => /deck/i.test(t.text))],
      ['finds the domain task', (o) => o.some((t: any) => /domain/i.test(t.text))],
      ['domain due 2026-11-15', (o) => o.find((t: any) => /domain/i.test(t.text))?.due === '2026-11-15'],
      ['no pricing non-task', (o) => !o.some((t: any) => /pricing/i.test(t.text))],
      ['valid date format', (o) => o.every((t: any) => t.due === undefined || /^\d{4}-\d{2}-\d{2}$/.test(t.due))],
    ],
  },
  {
    id: 'flashcards',
    scripted: '{"flashcards": [{"question": "What is the powerhouse of the cell?", "answer": "The mitochondrion"}, {"front": "Energy currency of the cell", "back": "ATP"}, {"q": "What do ribosomes make?", "a": "Proteins"}]}\n\nThese cover the key facts.',
    run: (p, m) => runSkill(makeFlashcards, p, m, { text: 'Mitochondria are the powerhouse of the cell. ATP is the energy currency. Ribosomes make proteins.', count: 3 }),
    checks: [
      ['2–6 cards', (o) => o.length >= 2 && o.length <= 6],
      ['covers ATP', (o) => o.some((c: any) => /ATP/.test(c.q + c.a))],
      ['non-empty q/a', (o) => o.every((c: any) => c.q && c.a)],
    ],
  },
  {
    id: 'tags',
    scripted: 'Tags: #Biology, Photosynthesis, plant science, school',
    run: (p, m) => runSkill(suggestTags, p, m, { text: 'Lecture 7: photosynthesis converts light into chemical energy in chloroplasts.', existingTags: ['biology', 'school'], max: 5 }),
    checks: [
      ['reuses existing "biology"', (o) => o.includes('biology')],
      ['normalized', (o) => o.every((t: string) => /^[\p{L}\p{N}/-]+$/u.test(t) && t === t.toLowerCase())],
      ['at most 5', (o) => o.length >= 1 && o.length <= 5],
    ],
  },
  {
    id: 'title',
    scripted: 'Suggested title: "Weekly Grocery List."',
    run: (p, m) => runSkill(suggestTitle, p, m, { text: '- eggs\n- milk\n- spinach\n- coffee' }),
    checks: [
      ['short', (o) => o.length >= 3 && o.length <= 60],
      ['no quotes or trailing period', (o) => !/^["'“]|["'”.]$/.test(o)],
      ['no label', (o) => !/title\s*:/i.test(o)],
    ],
  },
  {
    id: 'translate',
    scripted: 'Here is the translation:\n\nBuenos días\n- comprar pan',
    run: (p, m) => runSkill(translate, p, m, { text: 'Good morning\n- buy bread', lang: 'Spanish' }),
    checks: [
      ['keeps line structure', (o) => o.split('\n').length === 2 && o.split('\n')[1].startsWith('- ')],
      ['translated', (o) => /pan/i.test(o) && !/bread/i.test(o)],
      ['no preamble', (o) => !/translation/i.test(o)],
    ],
  },
  {
    id: 'summary',
    scripted: '**Summary:** The beta launches March 3 with a $12,000 marketing budget; Priya owns the launch.',
    run: (p, m) => runSkill(summarizeNote, p, m, { title: 'Beta launch plan', text: 'Launch date: March 3. Owner: Priya. Marketing budget $12,000. Press embargo until 9am. Need final screenshots by Feb 20.' }),
    checks: [
      ['mentions launch', (o) => /launch/i.test(o)],
      ['short (≤ 60 words)', (o) => o.split(/\s+/).length <= 60],
      ['no label', (o) => !/^\W*summary/i.test(o)],
    ],
  },
  {
    id: 'answer-from-notes',
    scripted: 'Your beta launch is on **March 3** [Beta launch plan]. The retro is planned for the offsite [Team offsite].',
    async run(p, m) {
      const host = await MemoryNoteToolHost.create();
      await host.seed({ title: 'Beta launch plan', text: 'Launch date: March 3. Owner: Priya.' });
      await host.seed({ title: 'Team offsite', text: 'Lisbon, April. Agenda: launch retro.' });
      await host.seed({ title: 'Groceries', text: 'eggs, milk' });
      return answerFromNotes(p, m, { question: 'When is the beta launch?', host, k: 3 });
    },
    checks: [
      ['answers March 3', (o) => /March 3|3 March|03-03/i.test(o.answer)],
      ['cites the plan', (o) => o.citations.some((c: any) => c.title === 'Beta launch plan')],
      ['no irrelevant citation', (o) => !o.citations.some((c: any) => c.title === 'Groceries')],
    ],
  },
];

async function runSkillCase(c: SkillCase, provider: Provider, model: string, mode: string): Promise<CaseResult> {
  const t0 = Date.now();
  let out: unknown;
  let error: string | undefined;
  try {
    out = await c.run(provider, model);
  } catch (e) {
    error = (e as Error).message;
  }
  const checks = c.checks.map(([name, test]) => {
    let pass = false;
    if (!error) {
      try {
        pass = !!test(out);
      } catch {
        pass = false;
      }
    }
    return { name, pass, weight: 1 };
  });
  return { id: c.id, mode, score: checks.filter((x) => x.pass).length / checks.length, checks, steps: 1, tools: [], ms: Date.now() - t0, ...(error ? { error } : {}) };
}

describe('skill evals — scripted replies', () => {
  const results: CaseResult[] = [];
  afterAll(() => printReport(formatTable('Inkstone skill evals — scripted', results)));
  for (const c of SKILL_CASES) {
    it(c.id, async () => {
      const r = await runSkillCase(c, createScriptedProvider([{ text: c.scripted }]), 'scripted', 'scripted');
      results.push(r);
      expect(r.checks.filter((x) => !x.pass).map((x) => x.name)).toEqual([]);
    });
  }
});

const live = liveConfig();

describe.skipIf(!live)(`skill evals — live (${live?.label ?? 'off'})`, () => {
  const results: CaseResult[] = [];
  afterAll(() => printReport(formatTable(`Inkstone skill evals — live ${live!.label}`, results)));
  for (const c of SKILL_CASES) {
    it(c.id, async () => {
      const r = await runSkillCase(c, live!.provider, live!.model, 'live');
      results.push(r);
      expect(r.score).toBeGreaterThanOrEqual(live!.minScore);
    });
  }
});
