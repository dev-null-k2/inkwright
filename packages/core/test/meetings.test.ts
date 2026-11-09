import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RECIPES,
  BUILTIN_TEMPLATES,
  addMeetingNotesVersion,
  callService,
  companyDomain,
  companyName,
  currentMeetingNotes,
  decodeMeetingInfo,
  decodeMeetingNotes,
  decodeMeetingsLibrary,
  decodeNote,
  emptyLibrary,
  encodeMeetingNotes,
  encodeMeetingsLibrary,
  encodeNote,
  expandEvents,
  hasHandEdits,
  meetingFromEvent,
  meetingHtml,
  meetingLink,
  meetingMailto,
  meetingMarkdown,
  meetingNotesText,
  meetingNotionBlocks,
  meetingSlack,
  mergeMeetingsLibraries,
  parseICalendar,
  peopleAndCompanies,
  relatedMeetings,
  removeFromLibrary,
  suggestTemplate,
  upcomingMeetings,
  upsertInLibrary,
  type MeetingNotesVersion,
  type NoteMeta,
} from '../src/index.ts';

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:abc
SUMMARY:Acme discovery call
DTSTART:20261110T150000Z
DTEND:20261110T153000Z
ORGANIZER;CN=Karthik K:mailto:karthik@inkwright.app
ATTENDEE;CN="Jane Doe";PARTSTAT=ACCEPTED:mailto:Jane.Doe@acme.com
ATTENDEE;CN=Big room;CUTYPE=ROOM:mailto:room@inkwright.app
ATTENDEE;PARTSTAT=DECLINED;CN=Bob:mailto:bob@acme.com
ATTENDEE:mailto:sam@gmail.com
DESCRIPTION:Join: https://acme.zoom.us/j/123456789?pwd=xyz\\nThanks
END:VEVENT
BEGIN:VEVENT
UID:focus
SUMMARY:Focus time
DTSTART:20261110T160000Z
DTEND:20261110T180000Z
END:VEVENT
BEGIN:VEVENT
UID:allday
SUMMARY:Offsite
DTSTART;VALUE=DATE:20261110
END:VEVENT
END:VCALENDAR`;

describe('calendar events for meetings', () => {
  const [ev] = parseICalendar(ICS);
  it('reads attendees (organizer first, no rooms or decliners) and the call link', () => {
    expect(ev!.attendees).toEqual([
      { name: 'Karthik K', email: 'karthik@inkwright.app', organizer: true },
      { name: 'Jane Doe', email: 'jane.doe@acme.com' },
      { email: 'sam@gmail.com' },
    ]);
    expect(meetingLink(ev!)).toBe('https://acme.zoom.us/j/123456789?pwd=xyz');
    expect(callService(meetingLink(ev!))).toBe('Zoom');
    expect(callService('https://meet.google.com/abc-defg-hij')).toBe('Google Meet');
  });

  it('lists upcoming meetings, skipping focus blocks and all-day events, and marks the one under way', () => {
    const occ = expandEvents(parseICalendar(ICS), Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 11));
    const now = Date.UTC(2026, 10, 10, 14, 57);
    const up = upcomingMeetings(occ, now);
    expect(up.map((u) => u.title)).toEqual(['Acme discovery call']);
    expect(up[0]!.now).toBe(true);
    expect(upcomingMeetings(occ, Date.UTC(2026, 10, 10, 14, 0))[0]!.now).toBe(false);
    expect(upcomingMeetings(occ, Date.UTC(2026, 10, 10, 15, 31))).toEqual([]);
    const m = meetingFromEvent(up[0]!, ['karthik@inkwright.app']);
    expect(m.attendees).toEqual([{ name: 'Jane Doe', email: 'jane.doe@acme.com' }, { name: 'Sam', email: 'sam@gmail.com' }]);
    expect(m.event).toMatchObject({ link: 'https://acme.zoom.us/j/123456789?pwd=xyz', start: Date.UTC(2026, 10, 10, 15) });
  });
});

describe('templates and recipes', () => {
  it('has distinct ids and usable sections', () => {
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(BUILTIN_TEMPLATES.length);
    expect(new Set(BUILTIN_RECIPES.map((r) => r.id)).size).toBe(BUILTIN_RECIPES.length);
    for (const t of BUILTIN_TEMPLATES) expect(t.sections.length).toBeGreaterThan(1);
    for (const t of BUILTIN_TEMPLATES) if (t.match) expect(() => new RegExp(t.match!)).not.toThrow();
  });

  it('suggests a template from the title', () => {
    expect(suggestTemplate('Weekly 1:1 with Priya').id).toBe('one-on-one');
    expect(suggestTemplate('Daily standup').id).toBe('standup');
    expect(suggestTemplate('Acme discovery call').id).toBe('sales-call');
    expect(suggestTemplate('Interview: backend engineer').id).toBe('interview');
    expect(suggestTemplate('CS 101 lecture 4').id).toBe('lecture');
    expect(suggestTemplate('Lunch with Sam', [], 2).id).toBe('one-on-one');
    expect(suggestTemplate('Something').id).toBe('general');
    const custom = [{ id: 'mine', name: 'Pipeline', description: '', sections: [{ heading: 'A', guide: '' }], match: 'pipeline' }];
    expect(suggestTemplate('Pipeline review', custom).id).toBe('mine');
    expect(suggestTemplate('x', [{ ...custom[0]!, match: '(' }]).id).toBe('general');
  });

  it('keeps your own templates and recipes in a library that merges by newest edit, deletions included', () => {
    let a = upsertInLibrary(emptyLibrary(), 'recipes', { id: 'r1', name: 'Mine', description: '', prompt: 'Do it', scope: 'meeting' }, 100);
    a = upsertInLibrary(a, 'templates', { id: 't1', name: 'T', description: '', sections: [{ heading: 'H', guide: 'g' }] }, 110);
    const round = decodeMeetingsLibrary(encodeMeetingsLibrary(a));
    expect(round.recipes[0]).toMatchObject({ id: 'r1', prompt: 'Do it', updatedAt: 100 });
    const b = upsertInLibrary(round, 'recipes', { ...round.recipes[0]!, prompt: 'Do it better' }, 200);
    const c = removeFromLibrary(round, 't1', 150);
    const m = mergeMeetingsLibraries(b, c, 1000);
    expect(m.recipes[0]!.prompt).toBe('Do it better');
    expect(m.templates).toEqual([]);
    // An edit newer than the deletion brings it back.
    const d = upsertInLibrary(round, 'templates', round.templates[0]!, 300);
    expect(mergeMeetingsLibraries(d, c, 1000).templates.map((t) => t.id)).toEqual(['t1']);
    expect(decodeMeetingsLibrary('{"templates":[{"id":"bad id"}],"recipes":[{"id":"x","name":"n"}]}')).toMatchObject({ templates: [], recipes: [] });
  });
});

const version = (id: string, at: number, reason: MeetingNotesVersion['reason'] = 'enhance'): MeetingNotesVersion => ({
  id, at, by: 'test', template: 'general', clipIds: ['c1'], reason, tldr: 'Agreed to ship offline sync in March.',
  sections: [
    { heading: 'Discussion', items: [
      { id: 'a', text: 'Offline sync', mine: true },
      { id: 'b', text: 'Conflicts merge per stroke', depth: 1, cites: [62_000], clipId: 'c1' },
    ] },
    { heading: 'Action items', items: [{ id: 'c', text: 'Write the merge spec', owner: 'Jane', done: false, cites: [125_000] }] },
  ],
});

describe('enhanced notes file', () => {
  it('round-trips, keeps versions in order and the one shown', () => {
    let f = addMeetingNotesVersion(null, version('v1', 1));
    f = addMeetingNotesVersion(f, version('v2', 2, 'edit'));
    const back = decodeMeetingNotes(encodeMeetingNotes(f));
    expect(back.versions.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(currentMeetingNotes(back)!.id).toBe('v2');
    expect(hasHandEdits(back)).toBe(true);
    expect(back.versions[0]!.sections[0]!.items[1]).toEqual({ id: 'b', text: 'Conflicts merge per stroke', depth: 1, cites: [62_000], clipId: 'c1' });
    expect(() => decodeMeetingNotes('{"versions":[]}')).toThrow();
    for (let i = 3; i < 20; i++) f = addMeetingNotesVersion(f, version(`v${i}`, i));
    expect(f.versions).toHaveLength(12);
    expect(meetingNotesText(version('x', 1))).toContain('- Write the merge spec (Jane)');
  });

  it('exports to Markdown, Slack, HTML, Notion and email', () => {
    const h = { title: 'Design review', at: Date.UTC(2026, 10, 10, 15), attendees: [{ name: 'Jane Doe' }], link: 'https://example.com/n' };
    const v = version('v', 1);
    const md = meetingMarkdown(h, v);
    expect(md).toContain('# Design review');
    expect(md).toContain('> Agreed to ship offline sync in March.');
    expect(md).toContain('  - Conflicts merge per stroke [1:02]');
    expect(md).toContain('- [ ] Write the merge spec — Jane [2:05]');
    expect(meetingMarkdown(h, v, { stamps: false })).not.toContain('[1:02]');
    const slack = meetingSlack(h, v);
    expect(slack).toContain('*Action items*');
    expect(slack).toContain('• ☐ Write the merge spec — Jane');
    expect(slack).toContain('<https://example.com/n|Open in Inkwright>');
    const html = meetingHtml({ ...h, title: 'A <b> & c' }, v);
    expect(html).toContain('<h1>A &lt;b&gt; &amp; c</h1>');
    expect(html).toContain('<li>Offline sync<ul>');
    const blocks = meetingNotionBlocks(h, v);
    expect(blocks.some((b) => b.type === 'to_do')).toBe(true);
    const mail = meetingMailto(h, v, ['jane@acme.com'], 'Subject: Thanks!\n\nHi Jane');
    expect(mail).toMatch(/^mailto:jane%40acme\.com\?subject=Thanks!&body=Hi%20Jane$/);
  });
});

describe('people and companies', () => {
  it('reads company domains, ignoring personal providers', () => {
    expect(companyDomain('a@acme.com')).toBe('acme.com');
    expect(companyDomain('a@eu.mail.acme.com')).toBe('acme.com');
    expect(companyDomain('a@shop.acme.co.uk')).toBe('acme.co.uk');
    expect(companyDomain('a@gmail.com')).toBeNull();
    expect(companyDomain('nonsense')).toBeNull();
    expect(companyName('acme-corp.com')).toBe('Acme Corp');
    expect(companyName('granola.ai')).toBe('Granola');
  });

  const note = (id: string, at: number, title: string, attendees: Array<{ name: string; email?: string }>): Pick<NoteMeta, 'id' | 'title' | 'createdAt' | 'trashedAt' | 'meeting'> => ({ id, title, createdAt: at, meeting: { attendees } });
  const notes = [
    note('n1', 1, 'Acme intro', [{ name: 'Jane', email: 'jane@acme.com' }, { name: 'Me', email: 'me@inkwright.app' }]),
    note('n2', 2, 'Acme pricing', [{ name: 'Bob', email: 'bob@acme.com' }]),
    note('n3', 3, 'Team sync', [{ name: 'Ana', email: 'ana@inkwright.app' }]),
    note('n4', 4, 'Weekly 1:1', [{ name: 'Sam' }]),
    { ...note('n5', 5, 'Acme old', [{ name: 'Jane', email: 'jane@acme.com' }]), trashedAt: 9 },
  ];

  it('groups people and companies (not your own company) from meeting notes', () => {
    const { people, companies } = peopleAndCompanies(notes, ['me@inkwright.app']);
    expect(people.map((p) => p.name)).toEqual(['Sam', 'Ana', 'Bob', 'Jane']);
    expect(companies).toEqual([{ domain: 'acme.com', name: 'Acme', people: ['jane@acme.com', 'bob@acme.com'], meetings: ['n1', 'n2'], last: 2 }]);
  });

  it('finds earlier meetings with the same people, then the same company, then the same title', () => {
    expect(relatedMeetings({ attendees: [{ name: 'Jane', email: 'jane@acme.com' }] }, notes)).toEqual(['n2', 'n1']);
    expect(relatedMeetings({ attendees: [{ name: 'Jane', email: 'jane@acme.com' }], before: 2 }, notes)).toEqual(['n1']);
    expect(relatedMeetings({ title: 'Weekly 1:1', attendees: [] }, notes)).toEqual(['n4']);
    expect(relatedMeetings({ attendees: [{ name: 'Zed', email: 'zed@other.com' }] }, notes)).toEqual([]);
  });
});

describe('note meeting field', () => {
  it('is kept through the note codec and cleaned of bad shapes', () => {
    const n = decodeNote(JSON.stringify({ id: 'n', meeting: { template: 'standup', attendees: [{ name: 'A', email: 'A@X.COM' }, { bogus: 1 }], event: { uid: 'u', start: 5, end: 9, link: 'javascript:alert(1)' } } }));
    expect(n.meeting).toEqual({ template: 'standup', attendees: [{ name: 'A', email: 'a@x.com' }], event: { uid: 'u', start: 5, end: 9 } });
    expect(decodeNote(encodeNote(n)).meeting).toEqual(n.meeting);
    expect('meeting' in decodeNote(JSON.stringify({ id: 'n', meeting: 'x' }))).toBe(false);
    expect(decodeMeetingInfo(null)).toBeUndefined();
  });
});

describe('who spoke on a call', () => {
  it('labels segments by the louder side, leaving close calls unlabelled, and keeps names through the codec', async () => {
    const { assignSides, decodeTranscript, encodeTranscript, speakerName, transcriptTextWithSpeakers } = await import('../src/index.ts');
    const energy = [
      ...Array.from({ length: 20 }, (_, i) => ({ t: i * 100, me: 0.2, them: 0.02 })),
      ...Array.from({ length: 20 }, (_, i) => ({ t: 2000 + i * 100, me: 0.03, them: 0.25 })),
      ...Array.from({ length: 20 }, (_, i) => ({ t: 4000 + i * 100, me: 0.1, them: 0.09 })),
    ];
    const segs = assignSides([
      { id: 'a', startMs: 0, endMs: 1900, text: 'Hi Dana' },
      { id: 'b', startMs: 2000, endMs: 3900, text: 'Hello' },
      { id: 'c', startMs: 4000, endMs: 5900, text: 'Both talking', speaker: 'me' },
      { id: 'd', startMs: 9000, endMs: 9500, text: 'After the meter' },
    ], energy);
    expect(segs.map((s) => s.speaker)).toEqual(['me', 'them', undefined, undefined]);
    const file = decodeTranscript(encodeTranscript({ formatVersion: 1, clipId: 'c', run: 'r', engine: 'e', where: 'device', complete: true, updatedAt: 1, segments: segs, speakers: { them: 'Dana', 'bad/label': 'x' } }));
    expect(file.segments.map((s) => s.speaker)).toEqual(['me', 'them', undefined, undefined]);
    expect(file.speakers).toEqual({ them: 'Dana' });
    expect(speakerName(file, 'me')).toBe('You');
    expect(speakerName(file, 'them')).toBe('Dana');
    expect(speakerName(file, 'B')).toBe('Speaker B');
    expect(transcriptTextWithSpeakers(file).split('\n').slice(0, 2)).toEqual(['[0:00] You: Hi Dana', '[0:02] Dana: Hello']);
  });
});

describe('a hand like yours', () => {
  it('recovers size, slant and pen from someone’s writing, and needs enough of it', async () => {
    const { handwrite, handStyleOf } = await import('../src/index.ts');
    const text = 'The quick brown fox jumps over the lazy dog while we write meeting notes by hand every day';
    const big = handwrite(text.repeat(2), { x: 40, y: 60, width: 700, xHeight: 12, slant: 12, style: 'script', pen: 'fountain', size: 2.2, seed: 3 });
    const st = handStyleOf(big.strokes)!;
    expect(st.pen).toBe('fountain');
    expect(st.size).toBeCloseTo(2.2, 1);
    expect(st.xHeight).toBeGreaterThan(8);
    expect(st.xHeight).toBeLessThan(18);
    expect(st.slant).toBeGreaterThan(3);
    const small = handwrite(text.repeat(2), { x: 40, y: 60, width: 700, xHeight: 7, slant: 0, style: 'print', pen: 'ballpoint', size: 1.2, seed: 3 });
    const s2 = handStyleOf(small.strokes)!;
    expect(s2.xHeight).toBeLessThan(st.xHeight);
    expect(s2.slant).toBeLessThan(st.slant);
    expect(handStyleOf(big.strokes.slice(0, 10))).toBeNull();
    // AI ink doesn't count as the person's hand.
    expect(handStyleOf(big.strokes.map((s) => ({ ...s, origin: 'ai' as const })))).toBeNull();
  });
});
