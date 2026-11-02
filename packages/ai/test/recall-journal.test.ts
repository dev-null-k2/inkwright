import { describe, expect, it } from 'vitest';
import { expandEvents, locateClaims, parseICalendar, setItem, emptyProvenance, type NoteMeta, type PageInk, type TranscriptFile } from '@inkwright/core';
import {
  ROUTINE_TEMPLATES,
  captureSources,
  checkJournalDraft,
  collectJournalSources,
  composeJournal,
  createJournalTools,
  createScriptedProvider,
  eventSources,
  isRepeat,
  noteSourcesForDay,
  redactCapture,
  redactText,
  runAgent,
  sanitizeUrl,
  speechSourcesForDay,
  type ComposedJournal,
  type JournalSource,
} from '../src/index.ts';

const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m).getTime();
const DAY = { from: new Date(2026, 10, 3).getTime(), to: new Date(2026, 10, 4).getTime() };

describe('memory timeline: redaction before storage', () => {
  it('replaces personal data and secrets with their kind, counting but never keeping values', () => {
    const r = redactText('Mail ada@example.com or call +44 20 7946 0958.\nexport OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456\nCard 4111 1111 1111 1111');
    expect(r.text).toBe('Mail [email] or call [phone].\nexport [secret]\nCard [card number]');
    expect(r.counts).toEqual({ email: 1, phone: 1, secret: 1, card: 1 });
    expect(JSON.stringify(r)).not.toContain('ada@example.com');
    // An order number that fails Luhn and a git SHA stay (the firewall's validators).
    expect(redactText('order 1234 5678 9012 3456, commit 9fceb02d0ae598e95dc970b74767f19372d61af8').counts).toEqual({});
    expect(redactText('mail ada@example.com', { kinds: ['phone'] }).text).toBe('mail ada@example.com');
  });

  it('redacts text, title and address; drops query strings; skips empty captures', () => {
    const c = redactCapture({ at: 1, kind: 'screen', app: 'Firefox', title: 'Inbox (3) - ada@example.com - Mail', url: 'https://mail.example.com/u/0/?token=abc123&q=ssn#inbox', text: '  Reset link sent to ada@example.com  \n\n|\nSSN 123-45-6789\n' }, {}, () => 'id1');
    expect(c).toEqual({ id: 'id1', at: 1, kind: 'screen', app: 'Firefox', title: 'Inbox (3) - [email] - Mail', url: 'https://mail.example.com/u/0/', text: 'Reset link sent to [email]\nSSN [ID number]', redacted: { email: 2, gov_id: 1 } });
    expect(redactCapture({ at: 1, kind: 'screen', text: ' \n|\n' })).toBeNull();
    expect(sanitizeUrl('https://user:pw@example.com/a?b=c')).toBe('https://example.com/a');
    expect(sanitizeUrl('file:///etc/passwd')).toBeUndefined();
  });

  it('knows when a capture adds nothing new', () => {
    const a = { app: 'Terminal', title: 'zsh', text: '$ ls\nREADME.md' };
    expect(isRepeat(a, { ...a })).toBe(true);
    expect(isRepeat(a, { ...a, text: 'README.md' })).toBe(true);
    expect(isRepeat(a, { ...a, text: '$ ls\nREADME.md\n$ git status' })).toBe(false);
    expect(isRepeat(a, { ...a, title: 'vim' })).toBe(false);
    expect(isRepeat(null, a)).toBe(false);
  });
});

// ---- Journal ----------------------------------------------------------------------------------------

const note: NoteMeta = { id: 'N1', title: 'Signals lecture 7', recordings: [{ id: 'C1', asset: 'c1.webm', startedAt: at(10), durationMs: 3_600_000, mimeType: 'audio/webm' }] } as NoteMeta;
const pt = (x: number, y: number, t: number) => ({ x, y, t, p: 0.5, tilt: 0, orient: 0 });
const page: PageInk = {
  id: 'P1', formatVersion: 2,
  strokes: [
    { id: 'old', pen: 'fountain', color: '#FF000000', size: 2, createdAt: at(10) - 86_400_000, points: [pt(0, 0, 0), pt(5, 5, 100)] },
    { id: 's1', pen: 'fountain', color: '#FF000000', size: 2, createdAt: at(10, 5), points: [pt(60, 80, 0), pt(300, 82, 900)] },
    { id: 'ai', pen: 'ballpoint', color: '#FF000000', size: 2, createdAt: at(10, 6), origin: 'ai', points: [pt(60, 300, 0), pt(80, 300, 100)] },
  ],
  texts: [{ id: 'imp', x: 0, y: 400, width: 300, text: 'Imported slide text', fontSize: 14, color: '#FF000000', font: 'sans', createdAt: at(10, 7), origin: 'import' }],
  recognizedLines: [
    { text: 'Yesterday: sampling theorem', strokeIds: ['old'], bounds: { minX: 0, minY: 0, maxX: 5, maxY: 5 } },
    { text: 'FFT turns O(n^2) into O(n log n)', strokeIds: ['s1'], bounds: { minX: 60, minY: 70, maxX: 300, maxY: 90 } },
  ],
} as unknown as PageInk;
const transcript: TranscriptFile = { formatVersion: 1, clipId: 'C1', run: 'r', engine: 'device:moonshine', where: 'device', complete: true, updatedAt: 0, segments: [{ id: 'a', startMs: 600_000, endMs: 610_000, text: 'The lab report is due Friday.' }, { id: 'b', startMs: 610_000, endMs: 620_000, text: 'Bring your laptops next week.' }] };
const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', `DTSTART:20261103T${String(new Date(at(9, 30)).getUTCHours()).padStart(2, '0')}3000Z`, 'DURATION:PT15M', 'SUMMARY:Stand-up', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

function daySources(): JournalSource[] {
  return collectJournalSources([
    ...noteSourcesForDay(note, [page], DAY.from, DAY.to),
    ...speechSourcesForDay(note, [transcript], DAY.from, DAY.to),
    ...eventSources(expandEvents(parseICalendar(ics), DAY.from, DAY.to)),
    ...captureSources([
      { id: 'k1', at: at(14, 1), kind: 'screen', app: 'Terminal', title: 'zsh', text: '$ make bench\nbench: 1.8 ms' },
      { id: 'k2', at: at(14, 9), kind: 'screen', app: 'Terminal', title: 'zsh', text: '$ make bench\nbench: 1.2 ms' },
    ]),
  ]);
}

describe('journal: the day\'s sources', () => {
  it('collects only what was written that day (not AI ink, not imported, not yesterday), what was said, events and screen moments', () => {
    const s = daySources();
    expect(s.map((x) => [x.id, x.kind, x.title])).toEqual([
      ['s1', 'event', 'Stand-up'],
      ['s2', 'note', 'Signals lecture 7'],
      ['s3', 'speech', 'Signals lecture 7'],
      ['s4', 'screen', 'Terminal'],
    ]);
    expect(s[1]!.text).toBe('FFT turns O(n^2) into O(n log n)');
    expect(s[1]!.anchor).toMatch(/^N1\/1\/60,70,240,20#/);
    expect(s[2]!.text).toBe('The lab report is due Friday. Bring your laptops next week.');
    expect(s[2]!.link).toBe('#said/N1/C1/600000');
    expect(s[3]!.text).toBe('zsh\n$ make bench\nbench: 1.8 ms\nbench: 1.2 ms');
    expect(s[3]!.link).toBe(`#recall/${at(14, 1)}`);
  });

  it('keeps within the budget by dropping screen moments first', () => {
    const big = collectJournalSources([
      { kind: 'note', title: 'A', at: 1, text: 'x'.repeat(900) },
      { kind: 'screen', title: 'T', at: 2, text: 'y'.repeat(400) },
    ], 1000);
    expect(big.map((s) => s.kind)).toEqual(['note']);
  });
});

describe('journal: checking and composing the draft', () => {
  it('drops paragraphs without a valid citation and numbers sources in order of first use', () => {
    const s = daySources();
    const check = checkJournalDraft([
      { text: 'Started with stand-up, then the signals lecture on the FFT [s2].', sources: ['s1', 'S2'] },
      { text: 'I felt great about it.', sources: [] },
      { text: 'The lab report is due Friday.', sources: ['s9'] },
      { text: 'Benchmarks went from 1.8 to 1.2 ms', sources: ['s4', 's2'] },
      { text: '   ', sources: ['s1'] },
      'nonsense',
    ], s);
    expect(check.kept.map((k) => k.text)).toEqual(['Started with stand-up, then the signals lecture on the FFT.', 'Benchmarks went from 1.8 to 1.2 ms']);
    expect(check.dropped).toEqual([{ text: 'I felt great about it.', reason: 'cites no source' }, { text: 'The lab report is due Friday.', reason: 'cites sources that do not exist' }]);
    const j = composeJournal(check.kept);
    expect(j.body).toBe('Started with stand-up, then the signals lecture on the FFT [1, 2].\n\nBenchmarks went from 1.8 to 1.2 ms [3, 2]');
    expect(j.cited.map((c) => c.id)).toEqual(['s1', 's2', 's4']);
    expect(j.footer.split('\n')[0]).toBe('Sources');
    expect(j.footer).toContain('2. [Signals lecture 7](#mem/N1/1) — your note, 10:05');
    expect(j.footer).toMatch(/3\. \[Terminal\]\(#recall\/\d+\) — memory timeline, 14:01/);
    // Explain finds each sentence's sources.
    const prov = setItem(emptyProvenance(), 'text:T1', { by: 'Scripted', prompt: 'journal.draft/1', at: 1 }, j.claims);
    const located = locateClaims(j.body, prov, 'text:T1');
    expect(located.every((l) => l.claim)).toBe(true);
    expect(located[0]!.claim!.src[0]).toMatch(/^N1\/1\//);
    expect(located[0]!.claim!.why).toBe('Also from: calendar');
  });
});

describe('journal: the evening routine with a scripted model', () => {
  it('reads the day, writes only cited paragraphs, and reports what it dropped', async () => {
    const written: Array<{ day: string; draft: ComposedJournal; style: string }> = [];
    const tools = createJournalTools({
      today: () => '2026-11-03',
      gather: async () => ({ sources: daySources(), style: 'ink', looked: ['1 note', '1 recording', '1 event', 'memory timeline'] }),
      write: async (day, draft, _check, style) => { written.push({ day, draft, style }); return { noteId: 'J1', title: '2026-11-03', page: 1 }; },
    });
    const model = createScriptedProvider([
      { toolCalls: [{ name: 'journal_sources', arguments: {} }] },
      (ctx) => {
        const res = ctx.toolResults[0]!.value as { sources: Array<{ id: string; kind: string }>; instructions: string; style: string };
        expect(res.style).toBe('ink');
        expect(res.instructions).toContain('handwriting');
        const lecture = res.sources.find((x) => x.kind === 'note')!.id;
        const said = res.sources.find((x) => x.kind === 'speech')!.id;
        return { toolCalls: [{ name: 'write_journal_draft', arguments: { paragraphs: [
          { text: 'In the signals lecture we saw how the FFT gets to n log n.', sources: [lecture] },
          { text: 'The lab report is due Friday.', sources: [said] },
          { text: 'It was the best day of the term.', sources: [] },
        ] } }] };
      },
      (ctx) => {
        const r = ctx.toolResults[0]!.value as { written: boolean; paragraphs: number; dropped: unknown[] };
        expect(r).toMatchObject({ written: true, paragraphs: 2 });
        expect(r.dropped).toHaveLength(1);
        return { text: 'Your journal draft for 3 November is in your Journal.' };
      },
    ]);
    const routine = ROUTINE_TEMPLATES.find((t) => t.id === 'daily-journal')!.build(0);
    expect(routine.triggers).toEqual([{ kind: 'daily', time: '21:30' }]);
    const res = await runAgent({ provider: model, model: 'scripted', messages: [{ role: 'user', content: routine.prompt }], tools, maxSteps: 6 });
    expect(res.text).toContain('journal draft');
    expect(written).toHaveLength(1);
    expect(written[0]!.style).toBe('ink');
    expect(written[0]!.draft.body).toBe('In the signals lecture we saw how the FFT gets to n log n [1].\n\nThe lab report is due Friday [2].');
  });

  it('refuses to write before reading the day, and writes nothing when no paragraph is cited', async () => {
    const tools = createJournalTools({ today: () => '2026-11-03', gather: async () => ({ sources: daySources(), style: 'typed', looked: [] }), write: async () => { throw new Error('must not write'); } });
    const write = tools.find((t) => t.name === 'write_journal_draft')!;
    await expect(write.execute({ paragraphs: [{ text: 'x', sources: ['s1'] }] }, { toolCallId: '1', messages: [] })).rejects.toThrow(/journal_sources/);
    await tools[0]!.execute({ date: '2026-11-03' }, { toolCallId: '2', messages: [] });
    expect(await write.execute({ date: '2026-11-03', paragraphs: [{ text: 'Unbacked.', sources: ['s99'] }] }, { toolCallId: '3', messages: [] })).toMatchObject({ written: false });
    await expect(tools[0]!.execute({ date: 'Tuesday' }, { toolCallId: '4', messages: [] })).rejects.toThrow(/not a date/);
  });
});
