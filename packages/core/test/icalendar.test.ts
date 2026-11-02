import { describe, expect, it } from 'vitest';
import { expandEvents, icsTimeToEpoch, icsUnescape, parseDuration, parseICalendar, resolveZone } from '../src/index.ts';

const CRLF = (lines: string[]) => lines.join('\r\n') + '\r\n';
const cal = (...events: string[][]) => CRLF(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...events.flat(), 'END:VCALENDAR']);
const day = (y: number, m: number, d: number) => ({ from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() });

describe('iCalendar files', () => {
  it('reads folded lines, escapes, quoted parameters, alarms and cancelled events', () => {
    const text = cal(
      ['BEGIN:VEVENT', 'UID:standup@example.com', 'DTSTART:20261103T093000Z', 'DTEND:20261103T094500Z', 'SUMMARY:Stand-up\\, team', 'LOCATION:Room "B"', 'DESCRIPTION:Line one\\nline two that is folded', ' across lines', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'DESCRIPTION:Not the event', 'END:VALARM', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID="Europe/Berlin":20261103T140000', 'DURATION:PT1H30M', 'SUMMARY:Seminar', 'STATUS:CANCELLED', 'END:VEVENT'],
    );
    const [a, b] = parseICalendar(text);
    expect(a).toMatchObject({ uid: 'standup@example.com', title: 'Stand-up, team', location: 'Room "B"', description: 'Line one\nline two that is foldedacross lines', allDay: false, cancelled: false });
    expect(icsTimeToEpoch(a!.start)).toBe(Date.UTC(2026, 10, 3, 9, 30));
    expect(b).toMatchObject({ title: 'Seminar', durationMs: 90 * 60_000, cancelled: true });
    expect(b!.start.zone).toBe('Europe/Berlin');
    expect(expandEvents([a!, b!], Date.UTC(2026, 10, 3), Date.UTC(2026, 10, 4)).map((e) => e.title)).toEqual(['Stand-up, team']);
    expect(icsUnescape('a\\;b\\\\c\\Nd')).toBe('a;b\\c\nd');
  });

  it('converts zoned times, including across DST and Windows zone names', () => {
    expect(resolveZone('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(resolveZone('/mozilla.org/20050126_1/Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveZone('Nowhere/Special')).toBeNull();
    const [summer, winter] = parseICalendar(cal(
      ['BEGIN:VEVENT', 'UID:s', 'DTSTART;TZID=America/New_York:20260715T090000', 'SUMMARY:S', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:w', 'DTSTART;TZID=Eastern Standard Time:20261215T090000', 'SUMMARY:W', 'END:VEVENT'],
    ));
    expect(icsTimeToEpoch(summer!.start)).toBe(Date.UTC(2026, 6, 15, 13)); // EDT, UTC−4
    expect(icsTimeToEpoch(winter!.start)).toBe(Date.UTC(2026, 11, 15, 14)); // EST, UTC−5
  });

  it('treats all-day events as local dates', () => {
    const [ev] = parseICalendar(cal(['BEGIN:VEVENT', 'UID:h', 'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104', 'SUMMARY:Holiday', 'END:VEVENT']));
    expect(ev!.allDay).toBe(true);
    const { from, to } = day(2026, 11, 3);
    expect(expandEvents([ev!], from, to)).toEqual([{ uid: 'h', title: 'Holiday', start: from, end: to, allDay: true }]);
    expect(expandEvents([ev!], to, to + 86_400_000)).toEqual([]);
  });

  it('expands weekly rules with BYDAY, COUNT, EXDATE and a moved occurrence', () => {
    const evs = parseICalendar(cal(
      ['BEGIN:VEVENT', 'UID:lec', 'DTSTART:20261102T100000Z', 'DTEND:20261102T110000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', 'EXDATE:20261111T100000Z', 'SUMMARY:Lecture', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:lec', 'RECURRENCE-ID:20261116T100000Z', 'DTSTART:20261116T130000Z', 'DTEND:20261116T140000Z', 'SUMMARY:Lecture (moved)', 'END:VEVENT'],
    ));
    const all = expandEvents(evs, Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1));
    expect(all.map((e) => [new Date(e.start).toISOString().slice(0, 16), e.title])).toEqual([
      ['2026-11-02T10:00', 'Lecture'],
      ['2026-11-04T10:00', 'Lecture'],
      ['2026-11-09T10:00', 'Lecture'],
      // 11 Nov excluded; 16 Nov moved to 13:00
      ['2026-11-16T13:00', 'Lecture (moved)'],
      ['2026-11-18T10:00', 'Lecture'],
    ]);
  });

  it('expands daily, monthly (nth weekday, last day) and yearly rules with UNTIL and INTERVAL', () => {
    const evs = parseICalendar(cal(
      ['BEGIN:VEVENT', 'UID:d', 'DTSTART:20261101T080000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261107T235959Z', 'SUMMARY:Run', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:m', 'DTSTART:20260904T170000Z', 'RRULE:FREQ=MONTHLY;BYDAY=1FR', 'SUMMARY:Book club', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:l', 'DTSTART:20260131T120000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=12', 'SUMMARY:Rent', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:y', 'DTSTART;VALUE=DATE:19900312', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday', 'END:VEVENT'],
    ));
    const nov = expandEvents(evs, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1));
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    expect(nov.filter((e) => e.uid === 'd').map((e) => iso(e.start))).toEqual(['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07']);
    expect(nov.filter((e) => e.uid === 'm').map((e) => iso(e.start))).toEqual(['2026-11-06']);
    expect(nov.filter((e) => e.uid === 'l').map((e) => iso(e.start))).toEqual(['2026-11-30']);
    const feb = expandEvents(evs, Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1)).filter((e) => e.uid === 'l');
    expect(feb.map((e) => iso(e.start))).toEqual(['2026-02-28']);
    const bday = expandEvents(evs, new Date(2026, 2, 12).getTime(), new Date(2026, 2, 13).getTime()).filter((e) => e.uid === 'y');
    expect(bday).toHaveLength(1);
  });

  it('parses ISO durations', () => {
    expect(parseDuration('P1D')).toBe(86_400_000);
    expect(parseDuration('PT1H30M')).toBe(5_400_000);
    expect(parseDuration('P1W')).toBe(7 * 86_400_000);
    expect(parseDuration('-PT15M')).toBe(-900_000);
    expect(parseDuration('soon')).toBeNull();
  });
});
