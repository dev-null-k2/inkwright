import { describe, expect, it } from 'vitest';
import { asFraction, prettyMath, solveMath } from './math.ts';
import { describeWhen, findEvent, findLinks, findTasks, tasksToMarkdown } from './detect.ts';
import { buildIcs, foldLine, googleCalendarUrl, icsEscape, icsFileName } from './ics.ts';

describe('solving maths', () => {
  it('evaluates arithmetic (with fractions when written as such)', async () => {
    expect((await solveMath('2+3×4 =')).result).toBe('= 14');
    expect((await solveMath('1/3 + 1/6')).result).toBe('= 1/2 ≈ 0.5');
    expect((await solveMath('√(2)')).result).toBe('= 1.4142');
  });
  it('solves linear and quadratic equations exactly', async () => {
    expect((await solveMath('2x + 3 = 7')).result).toBe('x = 2');
    expect((await solveMath('x^2 - 2 = 0')).result).toBe('x = −√2 ≈ −1.4142, √2 ≈ 1.4142');
    expect((await solveMath('x^2 = 9')).result).toBe('x = −3, 3');
  });
  it('falls back to numeric roots for transcendental equations', async () => {
    const r = await solveMath('cos(x) = x');
    expect(r.result).toBe('x ≈ 0.7391');
    expect((await solveMath('x^2 = -1')).result).toBe('no real solution for x');
  });
  it('solves systems of equations', async () => {
    expect((await solveMath('x + y = 3\nx - y = 1')).result).toBe('x = 2, y = 1');
    expect((await solveMath('2x + 3y = 12; x - y = 1')).result).toBe('x = 3, y = 2');
  });
  it('differentiates, integrates and takes limits', async () => {
    expect((await solveMath('d/dx x^3 + 2x')).result).toBe('= 3x² + 2');
    expect((await solveMath('∫ 2x dx')).result).toBe('= x² + C');
    expect((await solveMath('∫_0^3 x^2 dx')).result).toBe('= 9');
    expect((await solveMath('integrate(x, x, 0, 2)')).result).toBe('= 2');
    expect((await solveMath('lim x→0 sin(x)/x')).result).toBe('= 1');
  });
  it('converts units', async () => {
    expect((await solveMath('5 km to m')).result).toBe('= 5000 m');
    expect((await solveMath('2 hours + 30 minutes to minutes')).result).toBe('= 150 minutes');
  });
  it('treats y = f(x) as a function to plot, with intercepts', async () => {
    const r = await solveMath('y = x^2 - 4');
    expect(r.kind).toBe('function');
    expect(r.result).toBe('x-intercepts −2, 2; y-intercept −4');
    expect(r.plot?.[0]?.expr).toBe('x^2-4');
  });
  it('says so when the writing is not maths', async () => {
    await expect(solveMath('hello there =')).rejects.toThrow();
    await expect(solveMath('=')).rejects.toThrow();
  });
  it('prettifies for the page', () => {
    expect(prettyMath('2*x^2+sqrt(2)*pi-3')).toBe('2x² + √2·π − 3');
    expect(asFraction(0.75)).toEqual([3, 4]);
    expect(asFraction(Math.PI)).toBeNull();
  });
});

describe('reading maths with an AI (strict prompt)', () => {
  it('asks for JSON in solver syntax with the image, and parses fenced replies', async () => {
    const { readMathSkill, readTableSkill } = await import('./read.ts');
    const p = readMathSkill.build({ image: { mediaType: 'image/jpeg', data: 'AAA' } });
    expect(p.json).toBe(true);
    expect(p.system).toContain('"plain"');
    expect(JSON.stringify(p.messages)).toContain('"type":"image"');
    const r = readMathSkill.parse('```json\n{"plain":"x^2 = 9","latex":"x^2=9","steps":["Take roots"," "],"answer":"x = ±3"}\n```', { image: { mediaType: '', data: '' } });
    expect(r).toEqual({ plain: 'x^2 = 9', latex: 'x^2=9', steps: ['Take roots'], answer: 'x = ±3' });
    expect(() => readMathSkill.parse('I think the answer is 3', { image: { mediaType: '', data: '' } })).toThrow();
    expect(readTableSkill.parse('{"cells":[["a","b"],["c"]]}', { image: { mediaType: '', data: '' }, rows: 2, cols: 2 })).toEqual([['a', 'b'], ['c', '']]);
  });
});

describe('dates, links and tasks in handwriting', () => {
  const ref = new Date(2026, 10, 1, 9, 0); // Sun 1 Nov 2026
  it('reads a date and time into an event with a title', () => {
    const e = findEvent('Signals midterm Thu 14 Nov 3pm', ref)!;
    expect(e.title).toBe('Signals midterm');
    expect(e.allDay).toBe(false);
    expect(e.start.getFullYear()).toBe(2026);
    expect(e.start.getMonth()).toBe(10);
    expect(e.start.getDate()).toBe(14);
    expect(e.start.getHours()).toBe(15);
    expect(e.end.getTime() - e.start.getTime()).toBe(3_600_000);
    expect(describeWhen(e, 'en-US')).toBe('Sat, Nov 14, 3pm');
  });
  it('makes all-day events from dates without times, and resolves weekdays forward', () => {
    const e = findEvent('Dentist on Friday', ref)!;
    expect(e.allDay).toBe(true);
    expect(e.start.getDay()).toBe(5);
    expect(e.start > ref).toBe(true);
    expect(e.title).toBe('Dentist');
    expect(findEvent('Essay due 12/3 at 9am', ref)!.start.getHours()).toBe(9);
  });
  it('finds no event where there is no date', () => {
    expect(findEvent('buy milk and eggs', ref)).toBeNull();
    expect(findEvent('', ref)).toBeNull();
  });
  it('finds phone numbers, emails and links', () => {
    const l = findLinks('Call Sam +1 (415) 555-0134 or mail sam@example.com, notes at example.org/signals');
    expect(l.map((x) => x.kind)).toEqual(['phone', 'email', 'url']);
    expect(l[0]!.href).toBe('tel:+14155550134');
    expect(l[1]!.href).toBe('mailto:sam@example.com');
    expect(l[2]!.href).toBe('https://example.org/signals');
    expect(findLinks('meet 2026-11-14 at 3.5 hrs')).toEqual([]);
  });
  it('reads checklists', () => {
    const t = findTasks('☐ buy milk\n☑ call Sam\n[ ] essay')!;
    expect(t).toEqual([{ text: 'buy milk', done: false }, { text: 'call Sam', done: true }, { text: 'essay', done: false }]);
    expect(tasksToMarkdown(t)).toBe('- [ ] buy milk\n- [x] call Sam\n- [ ] essay');
    expect(findTasks('just a line')).toBeNull();
  });
});

describe('calendar files', () => {
  const ev = { title: 'Signals midterm, room 3; bring calculator', start: new Date(Date.UTC(2026, 10, 14, 15)), end: new Date(Date.UTC(2026, 10, 14, 16)), allDay: false, description: 'From Inkstone' };
  it('writes a valid iCalendar event (CRLF, escaped, UTC times)', () => {
    const ics = buildIcs(ev, { uid: 'abc@inkstone', now: new Date(Date.UTC(2026, 10, 1)) });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261114T150000Z\r\n');
    expect(ics).toContain('DTEND:20261114T160000Z\r\n');
    expect(ics).toContain('SUMMARY:Signals midterm\\, room 3\\; bring calculator\r\n');
    expect(ics).toContain('UID:abc@inkstone');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
  it('writes all-day events as dates', () => {
    const ics = buildIcs({ title: 'Trip', start: new Date(2026, 11, 3), end: new Date(2026, 11, 5), allDay: true }, { uid: 'x' });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261203');
    expect(ics).toContain('DTEND;VALUE=DATE:20261205');
  });
  it('folds long lines and escapes text', () => {
    const long = 'SUMMARY:' + 'é'.repeat(60);
    expect(foldLine(long).split('\r\n ').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(icsEscape('a\\b\nc')).toBe('a\\\\b\\nc');
  });
  it('links to Google Calendar prefilled', () => {
    const u = new URL(googleCalendarUrl(ev));
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('dates')).toBe('20261114T150000Z/20261114T160000Z');
    expect(u.searchParams.get('text')).toBe(ev.title);
    expect(icsFileName(ev)).toMatch(/^Signals midterm, room 3; bring calculator 2026-11-14\.ics$/);
  });
});
