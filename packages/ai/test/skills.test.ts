import { describe, expect, it } from 'vitest';
import {
  MemoryNoteToolHost,
  NO_NOTES_ANSWER,
  SKILLS,
  answerFromNotes,
  buildAnswerPrompt,
  cleanText,
  createScriptedProvider,
  explainSelection,
  extractTodos,
  keywords,
  makeFlashcards,
  normalizeTag,
  parseCitations,
  retrieveNotes,
  runSkill,
  suggestTags,
  suggestTitle,
  summarizeNote,
  transcribeHandwriting,
  translate,
  type RetrievedSource,
} from '../src/index.ts';
import { PNG_1PX } from './helpers.ts';

describe('cleanText', () => {
  it('drops preambles, fences and sign-offs', () => {
    expect(cleanText("Sure! Here's the summary:\n\nThe plan is set.\n\nLet me know if you need anything else.")).toBe('The plan is set.');
    expect(cleanText('```\nline 1\nline 2\n```')).toBe('line 1\nline 2');
    expect(cleanText('Here is the transcription:\n```markdown\n# Notes\n- a\n```')).toBe('# Notes\n- a');
    expect(cleanText('Plain answer.')).toBe('Plain answer.');
  });
});

describe('transcribeHandwriting', () => {
  it('builds a vision prompt with the page image', () => {
    const p = transcribeHandwriting.build({ image: { mediaType: 'image/png', data: PNG_1PX }, languageHint: 'German', context: 'Physics lecture' });
    expect(transcribeHandwriting.vision).toBe(true);
    expect(p.system).toMatch(/line breaks/);
    expect(p.system).toMatch(/German/);
    expect(p.temperature).toBe(0);
    expect(p.messages[0]!.content).toEqual([
      { type: 'text', text: expect.stringContaining('Physics lecture') },
      { type: 'image', mediaType: 'image/png', data: PNG_1PX },
    ]);
    expect(transcribeHandwriting.build({ image: { mediaType: 'image/png', data: '' }, mode: 'markdown' }).system).toMatch(/- \[ \] /);
  });

  it('parses transcriptions, keeping lines and dropping chatter', () => {
    const input = { image: { mediaType: 'image/png', data: '' } };
    expect(transcribeHandwriting.parse('Here is the transcription:\n\nBuy milk   \nCall mom\n  - email Sam', input)).toBe('Buy milk\nCall mom\n  - email Sam');
    expect(transcribeHandwriting.parse('```\n# Week 3\n- [x] done\n```', input)).toBe('# Week 3\n- [x] done');
    expect(transcribeHandwriting.parse('(no handwriting)', input)).toBe('');
    expect(transcribeHandwriting.parse('[blank page]', input)).toBe('');
  });
});

describe('summaries, explanations, translation', () => {
  it('summarizeNote varies by style and strips labels', () => {
    expect(summarizeNote.build({ text: 'x', style: 'bullets' }).system).toMatch(/bullet/);
    expect(summarizeNote.build({ text: 'x' }).maxTokens).toBe(200);
    expect(summarizeNote.parse('**Summary:** Plans for the beta launch.', { text: '' })).toBe('Plans for the beta launch.');
  });

  it('explainSelection includes context and question', () => {
    const p = explainSelection.build({ selection: 'E = mc^2', context: 'Relativity notes', question: 'Why squared?', level: 'simple' });
    expect(p.system).toMatch(/12-year-old/);
    expect(p.messages[0]!.content).toMatch(/E = mc\^2[\s\S]*Relativity notes[\s\S]*Why squared\?/);
  });

  it('translate keeps formatting instructions and unquotes output', () => {
    const p = translate.build({ text: 'Hello\n- world', lang: 'Spanish', sourceLang: 'English' });
    expect(p.system).toMatch(/from English into Spanish/);
    expect(p.messages[0]!.content).toBe('Hello\n- world');
    expect(translate.parse('"Hola\n- mundo"', { text: 'Hello\n- world', lang: 'es' })).toBe('Hola\n- mundo');
    expect(translate.parse('Translation: Bonjour', { text: 'Hi', lang: 'fr' })).toBe('Bonjour');
    expect(translate.parse('"Hola"', { text: '"Hello"', lang: 'es' })).toBe('"Hola"');
  });
});

describe('suggestTitle / suggestTags', () => {
  it('cleans titles', () => {
    const i = { text: '' };
    expect(suggestTitle.parse('"Q3 Launch Plan."', i)).toBe('Q3 Launch Plan');
    expect(suggestTitle.parse('Title: **Grocery list**\n\nBecause it lists groceries.', i)).toBe('Grocery list');
    expect(suggestTitle.parse('# Meeting notes — Oct 12', i)).toBe('Meeting notes — Oct 12');
    expect(suggestTitle.parse('A'.repeat(50) + ' ' + 'B'.repeat(50), i)).toBe('A'.repeat(50));
  });

  it('parses tags from JSON or lists, normalizing and reusing existing tags', () => {
    const i = { text: '', existingTags: ['Machine-Learning', 'work'], max: 4 };
    expect(suggestTags.parse('{"tags": ["#Machine Learning", "Work", "neural nets", "work", "x".repeat(50)]}'.replace('"x".repeat(50)', `"${'x'.repeat(50)}"`), i)).toEqual(['machine-learning', 'work', 'neural-nets']);
    expect(suggestTags.parse('Tags: physics, thermodynamics, lecture notes', { text: '' })).toEqual(['physics', 'thermodynamics', 'lecture-notes']);
    expect(suggestTags.parse('- travel\n- japan\n- food\n- budget\n- itinerary\n- extra', { text: '' })).toEqual(['travel', 'japan', 'food', 'budget', 'itinerary']);
    expect(suggestTags.build({ text: 'x', existingTags: ['a'] }).system).toMatch(/already uses.*a/);
    expect(normalizeTag('  #Project Ideas!! ')).toBe('project-ideas');
  });
});

describe('extractTodos', () => {
  const i = { text: '' };
  it('requests JSON with today’s date for relative dates', () => {
    const p = extractTodos.build({ text: 'call bob tomorrow', today: '2026-11-01' });
    expect(p.json).toBe(true);
    expect(p.system).toMatch(/Today is 2026-11-01/);
    expect(p.system).toMatch(/\{"todos"/);
  });

  it('parses wrapped arrays with field variants and normalizes dates', () => {
    const out = extractTodos.parse(
      'Here you go:\n```json\n{"todos":[{"text":"Email Sam the budget","due":"2026-11-03"},{"task":"Book venue","deadline":"Nov 20, 2026"},{"title":"Pay rent","done":true},{"text":"email sam the budget"},{"text":"  "},"Buy stamps",{"text":"Vague","due":"soon"}]}\n```',
      i,
    );
    expect(out).toEqual([
      { text: 'Email Sam the budget', due: '2026-11-03' },
      { text: 'Book venue', due: '2026-11-20' },
      { text: 'Pay rent', done: true },
      { text: 'Buy stamps' },
      { text: 'Vague' },
    ]);
  });

  it('accepts a bare array and an empty result', () => {
    expect(extractTodos.parse('[{"text":"a"}]', i)).toEqual([{ text: 'a' }]);
    expect(extractTodos.parse('{"todos": []}', i)).toEqual([]);
  });

  it('falls back to Markdown checklists when there is no JSON', () => {
    expect(extractTodos.parse('- [ ] Call the plumber (due 2026-11-05)\n- [x] Water plants\n* Renew passport\nSome prose line', i)).toEqual([
      { text: 'Call the plumber', due: '2026-11-05' },
      { text: 'Water plants', done: true },
      { text: 'Renew passport' },
    ]);
  });
});

describe('makeFlashcards', () => {
  it('parses q/a, question/answer and front/back, de-duplicating', () => {
    const t = '{"cards":[{"q":"What is ATP?","a":"Energy currency"},{"question":"Who wrote Hamlet?","answer":"Shakespeare"},{"front":"H2O","back":"Water"},{"q":"What is ATP?","a":"dup"},{"q":"","a":"x"}]}';
    expect(makeFlashcards.parse(t, { text: '' })).toEqual([
      { q: 'What is ATP?', a: 'Energy currency' },
      { q: 'Who wrote Hamlet?', a: 'Shakespeare' },
      { q: 'H2O', a: 'Water' },
    ]);
  });

  it('falls back to Q:/A: text', () => {
    const t = 'Q: What is mitosis?\nA: Cell division.\n\nQ: What is DNA?\nA: The genetic material.';
    expect(makeFlashcards.parse(t, { text: '' })).toEqual([
      { q: 'What is mitosis?', a: 'Cell division.' },
      { q: 'What is DNA?', a: 'The genetic material.' },
    ]);
  });

  it('asks for the requested count', () => {
    expect(makeFlashcards.build({ text: 'x', count: 4 }).system).toMatch(/up to 4 cards/);
  });
});

describe('runSkill', () => {
  it('sends system + messages + json flag and parses the reply', async () => {
    const provider = createScriptedProvider([{ text: 'Sure:\n```json\n{"todos":[{"text":"Ship it","due":"2026-11-02"}]}\n```' }]);
    const deltas: string[] = [];
    const todos = await runSkill(extractTodos, provider, 'm', { text: 'ship it tomorrow', today: '2026-11-01' }, { onText: (d) => deltas.push(d) });
    expect(todos).toEqual([{ text: 'Ship it', due: '2026-11-02' }]);
    const req = provider.requests[0]!;
    expect(req.json).toBe(true);
    expect(req.temperature).toBe(0);
    expect(req.messages[0]!.role).toBe('system');
    expect(req.messages[1]).toEqual({ role: 'user', content: 'ship it tomorrow' });
    expect(deltas.join('')).toContain('Ship it');
  });

  it('every skill builds a prompt', () => {
    for (const s of Object.values(SKILLS)) {
      const p = (s.build as (i: unknown) => { system: string; messages: unknown[] })({ text: 'x', selection: 'x', lang: 'fr', image: { mediaType: 'image/png', data: PNG_1PX } });
      expect(p.system.length).toBeGreaterThan(20);
      expect(p.messages.length).toBe(1);
    }
  });
});

describe('answerFromNotes (RAG)', () => {
  async function seeded() {
    const host = await MemoryNoteToolHost.create();
    await host.seed({ title: 'Beta launch plan', text: 'The beta launch is on March 3. Marketing budget is $12,000.' });
    await host.seed({ title: 'Team offsite', text: 'Offsite in Lisbon. Discuss the launch retro.' });
    await host.seed({ title: 'Groceries', text: 'eggs, milk, coffee' });
    await host.seed({ title: 'Lecture 7', recognizedText: ['Photosynthesis converts light to energy', 'Chlorophyll absorbs red and blue light'], strokes: 2 });
    return host;
  }

  it('extracts keywords from questions', () => {
    expect(keywords('What did I write about the launch budget?')).toEqual(['launch', 'budget']);
    expect(keywords('When is Q3?')).toEqual(['q3']);
  });

  it('retrieves by keyword even when the full question would not match', async () => {
    const host = await seeded();
    const sources = await retrieveNotes(host, 'What did we decide about the launch budget?', { k: 3 });
    expect(sources[0]!.title).toBe('Beta launch plan');
    expect(sources.map((s) => s.title)).toContain('Team offsite');
    expect(sources.map((s) => s.title)).not.toContain('Groceries');
    expect(sources[0]!.text).toContain('$12,000');
  });

  it('puts the matching page first for multi-page notes', async () => {
    const host = await seeded();
    const [s] = await retrieveNotes(host, 'chlorophyll');
    expect(s!.pageIndex).toBe(1);
    expect(s!.text.indexOf('Chlorophyll')).toBeLessThan(s!.text.indexOf('Photosynthesis'));
  });

  it('answers with citations', async () => {
    const host = await seeded();
    const provider = createScriptedProvider([{ text: 'The launch is on March 3 [Beta launch plan], with a retro planned at the offsite [2].' }]);
    const r = await answerFromNotes(provider, 'm', { question: 'When is the launch?', host, k: 3 });
    expect(r.answer).toMatch(/March 3/);
    expect(r.citations.map((c) => c.title)).toEqual(['Beta launch plan', 'Team offsite']);
    const prompt = provider.requests[0]!.messages;
    expect(prompt[0]!.content).toMatch(/only the user's own notes/);
    expect(prompt[1]!.content).toMatch(/\[1\] Title: Beta launch plan[\s\S]*Question: When is the launch\?/);
  });

  it('does not call the model when nothing is found', async () => {
    const host = await seeded();
    const provider = createScriptedProvider([{ text: 'should not be used' }]);
    const r = await answerFromNotes(provider, 'm', { question: 'What about the zeppelin?', host });
    expect(r).toEqual({ answer: NO_NOTES_ANSWER, citations: [], sources: [] });
    expect(provider.requests).toHaveLength(0);
  });

  it('parseCitations handles numbers, case and multi-citations', () => {
    const src = (title: string, noteId: string): RetrievedSource => ({ noteId, title, pageIndex: 0, snippet: '', score: 1, text: '' });
    const sources = [src('Beta launch plan', 'a'), src('Groceries', 'b')];
    expect(parseCitations('See [beta launch plan; Groceries] and [1] and [unknown] [x]', sources)).toEqual([
      { noteId: 'a', title: 'Beta launch plan' },
      { noteId: 'b', title: 'Groceries' },
    ]);
    expect(buildAnswerPrompt('q', sources).messages[0]!.content).toMatch(/\[2\] Title: Groceries/);
  });
});
