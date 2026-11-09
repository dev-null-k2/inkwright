import { describe, expect, it } from 'vitest';
import { BUILTIN_RECIPES, BUILTIN_TEMPLATES, findTemplate } from '@inkwright/core';
import {
  briefMessages,
  editNotesMessages,
  enhanceMessages,
  meetingCitations,
  noteLines,
  notesToLines,
  parseEnhancedNotes,
  recipeMessages,
  versionFromParsed,
} from '../src/index.ts';

const notes = `- offline sync
- pricing??
* Jane to write spec`;

const transcript = [
  { ms: 0, text: 'Let’s talk about offline sync first.' },
  { ms: 62_000, text: 'Conflicts will merge per stroke, so nothing is lost.' },
  { ms: 125_000, text: 'Jane, can you write the merge spec by Friday?' },
  { ms: 190_000, text: 'Pricing stays at nine dollars for now.' },
];

describe('enhanced meeting notes', () => {
  it('asks for the template’s sections, keeps the writer’s notes and sends the stamped transcript', () => {
    const m = enhanceMessages({ title: 'Design review', template: findTemplate('general'), notes, transcript, attendees: [{ name: 'Jane' }] });
    expect(m[0]!.content).toContain('## Decisions — What was decided');
    expect(m[0]!.content).toContain('Keep each of their notes as a point, in their own words');
    expect(m[1]!.content).toContain('[1:02] Conflicts will merge per stroke');
    expect(m[1]!.content).toContain('Attendees: Jane');
    expect(m[1]!.content).toContain('- pricing??');
  });

  it('reads a well-formed reply, marks the writer’s lines and the times', () => {
    const reply = `TLDR: Offline sync ships with per-stroke merges; pricing unchanged.
## Discussion
- Offline sync
  - Conflicts merge per stroke, so nothing is lost [1:02]
- Pricing
  - Stays at $9 for now [3:10]
## Action items
- [ ] Write the merge spec by Friday — Jane [2:05]`;
    const p = parseEnhancedNotes(reply, { notes, clipId: 'c1', durationMs: 200_000, headings: ['Discussion', 'Decisions', 'Action items'] });
    expect(p.tldr).toBe('Offline sync ships with per-stroke merges; pricing unchanged.');
    expect(p.sections.map((s) => s.heading)).toEqual(['Discussion', 'Action items']);
    const [d, a] = p.sections;
    expect(d!.items[0]).toMatchObject({ text: 'Offline sync', mine: true });
    expect(d!.items[1]).toMatchObject({ text: 'Conflicts merge per stroke, so nothing is lost', depth: 1, cites: [62_000], clipId: 'c1' });
    expect(d!.items[1]!.mine).toBeUndefined();
    expect(d!.items[2]).toMatchObject({ text: 'Pricing', mine: true });
    expect(a!.items[0]).toMatchObject({ text: 'Write the merge spec by Friday', owner: 'Jane', done: false, cites: [125_000], mine: true });
    expect(p.restored).toBe(0);
  });

  it('copes with what small models write: bold headings, stars, no dashes, think blocks, fences, stray times', () => {
    const reply = `<think>let me think</think>
\`\`\`
**Discussion**
* offline sync [0:00, 1:02]
Conflicts merge per stroke [1:02]
**Action items:**
1. [x] write spec - Jane [2:05]
- [ ] Follow up on pricing — unassigned [99:00]
\`\`\``;
    const p = parseEnhancedNotes(reply, { notes, durationMs: 200_000 });
    expect(p.sections.map((s) => s.heading)).toEqual(['Discussion', 'Action items']);
    expect(p.sections[0]!.items.map((i) => i.text)).toEqual(['offline sync', 'Conflicts merge per stroke']);
    expect(p.sections[0]!.items[0]!.cites).toEqual([0, 62_000]);
    expect(p.sections[1]!.items[0]).toMatchObject({ text: 'write spec', owner: 'Jane', done: true });
    // "pricing??" was only paraphrased: put back word for word, with the AI's line as its detail.
    expect(p.sections[1]!.items[1]).toMatchObject({ text: 'pricing??', mine: true });
    expect(p.sections[1]!.items[2]).toEqual(expect.objectContaining({ text: 'Follow up on pricing', depth: 1 }));
    // A time past the end of the recording is dropped; "unassigned" is no owner.
    expect(p.sections[1]!.items[2]!.cites).toBeUndefined();
    expect(p.sections[1]!.items[2]!.owner).toBeUndefined();
    expect(p.restored).toBe(1);
  });

  it('handles what Qwen3 1.7B actually wrote for a sales call: notes kept, details under them, times found', () => {
    // The real reply from the on-device model in evals/meetings.eval.ts (no times, notes paraphrased).
    const reply = `TLDR: Acme Discovery call concluded with action items and next steps agreed upon.
## About them
- Dana: Attendee, Acme discovery call
## Pain points
- Dana: Hates spreadsheets, forecasts take two days every month, Salesforce rollout stalled
## Current solution
- Acme uses spreadsheets for forecasting. They tried Salesforce but the rollout stalled
## Budget, authority, timeline
- No budget mentioned
## Action items
- [ ] send SOC 2 report today — Dana
- [ ] start pilot with east region team in December — Dana`;
    const notes = 'acme - 40 reps\nusing spreadsheets, hate it\nsecurity review?\nprice';
    const tr = [
      { ms: 11_000, text: 'Sure. I run sales operations at Acme. We have about forty reps across two regions.' },
      { ms: 24_000, text: 'Right now everything lives in spreadsheets and honestly everyone hates it. Forecasts take two days every month.' },
      { ms: 41_000, text: 'We tried Salesforce a few years ago but the rollout stalled.' },
      { ms: 150_000, text: 'Great. So next steps: I will send our SOC 2 report today, and you will introduce me to Priya.' },
      { ms: 170_000, text: 'And we agreed to start a pilot with the east region team in December.' },
    ];
    const p = parseEnhancedNotes(reply, { notes, clipId: 'c', durationMs: 180_000, transcript: tr });
    const all = p.sections.flatMap((s) => s.items);
    // Every note line is there, word for word, and marked as theirs.
    for (const n of ['acme - 40 reps', 'using spreadsheets, hate it', 'security review?', 'price']) expect(all.some((i) => i.mine && i.text === n)).toBe(true);
    // "using spreadsheets, hate it" sits above the AI's spreadsheet line, which became its detail.
    const pain = p.sections.find((s) => s.heading === 'Pain points')!.items;
    expect(pain.map((i) => [i.text.slice(0, 24), !!i.mine, i.depth ?? 0])).toEqual([['using spreadsheets, hate', true, 0], ['Dana: Hates spreadsheets', false, 1]]);
    // Grey lines got the moments they came from.
    expect(pain[1]!.cites).toEqual([24_000, 41_000]);
    const actions = p.sections.find((s) => s.heading === 'Action items')!.items;
    expect(actions.find((i) => /SOC 2/.test(i.text))!.cites).toEqual([150_000]);
    expect(actions.find((i) => /pilot/.test(i.text))!.cites).toEqual([170_000]);
    // A line with no support in the transcript gets no time.
    expect(all.find((i) => i.text === 'No budget mentioned')!.cites).toBeUndefined();
  });

  it('never loses the writer’s notes, even when the model returns nothing usable', () => {
    const p = parseEnhancedNotes('', { notes });
    expect(p.sections).toHaveLength(1);
    expect(p.sections[0]!.items.map((i) => i.text)).toEqual(['offline sync', 'pricing??', 'Jane to write spec']);
    expect(noteLines('\n- [ ] a\n2) bb\n•\n')).toEqual(['a', 'bb']);
  });

  it('round-trips through the line format for edits', () => {
    const p = parseEnhancedNotes(`TLDR: x\n## Action items\n- [ ] Ship it — Ana [0:30]\n## Discussion\n- Point\n  - Detail [1:00]`, { notes: '' });
    const v = versionFromParsed(p, { by: 'test', template: 'general', clipIds: [], reason: 'enhance' });
    const lines = notesToLines(v);
    expect(lines).toBe('TLDR: x\n## Action items\n- [ ] Ship it — Ana [0:30]\n## Discussion\n- Point\n  - Detail [1:00]');
    const again = parseEnhancedNotes(lines, { notes: '' });
    expect(again.sections).toEqual(p.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, id: expect.any(String) })) })));
    const e = editNotesMessages({ title: 'T', current: v, request: 'Make it shorter', transcript });
    expect(e[1]!.content).toContain('The request: Make it shorter');
    expect(e[1]!.content).toContain('- [ ] Ship it — Ana [0:30]');
  });

  it('every built-in template produces a prompt with all its sections', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const m = enhanceMessages({ title: 'x', template: t, notes: '', transcript: [] });
      for (const s of t.sections) expect(m[0]!.content).toContain(`## ${s.heading}`);
    }
  });
});

describe('recipes and briefs', () => {
  it('numbers meetings and asks for [M1] citations when there are several', () => {
    const r = BUILTIN_RECIPES.find((x) => x.id === 'feature-requests')!;
    const m = recipeMessages(r, [
      { title: 'Acme call', at: Date.UTC(2026, 10, 2), notes: '- wants SSO', transcript },
      { title: 'Globex call', notes: '- wants offline' },
    ]);
    expect(m[0]!.content).toContain('[M1], [M2]');
    expect(m[1]!.content).toContain('[M1] Acme call');
    expect(m[1]!.content).toContain('[M2] Globex call');
    const one = recipeMessages(BUILTIN_RECIPES[0]!, [{ title: 'Acme call', notes: '- x', transcript }]);
    expect(one[0]!.content).toContain('cite its time like [12:03]');
    expect(one[1]!.content).not.toContain('[M1]');
    expect(meetingCitations('As said [M2] and [M1 12:03], not [M] or [Mx].')).toEqual([{ match: '[M2]', index: 1 }, { match: '[M1 12:03]', index: 0, ms: 723_000 }]);
  });

  it('briefs from earlier meetings with the same people', () => {
    const m = briefMessages({ title: 'Acme follow-up', at: Date.UTC(2026, 10, 10, 15), attendees: [{ name: 'Jane', email: 'jane@acme.com' }], past: [{ title: 'Acme intro', notes: '- Jane wants SSO by Q1' }] });
    expect(m[0]!.content).toContain('**Still open**');
    expect(m[1]!.content).toContain('Jane <jane@acme.com>');
    expect(m[1]!.content).toContain('[M1] Acme intro');
    expect(briefMessages({ title: 'New', at: 0, attendees: [], past: [] })[1]!.content).toContain('No earlier meetings');
  });
});
