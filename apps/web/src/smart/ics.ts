/**
 * Calendar events out of a note: an iCalendar file (RFC 5545) that every calendar app imports,
 * and Google Calendar's prefilled "new event" link. No account access or permissions needed.
 */

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  description?: string;
  location?: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** UTC date-time "20261114T150000Z". */
export function icsDateTime(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Local calendar date "20261114" (all-day events are dates, not instants). */
export function icsDate(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** TEXT escaping (RFC 5545 §3.3.11). */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line at 75 octets (§3.1), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (len + n > limit) { out.push(cur); cur = ''; len = 0; }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(e: CalendarEvent, opts: { uid: string; now?: Date }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Inkwright//Notes//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${icsDateTime(opts.now ?? new Date())}`,
    ...(e.allDay
      ? [`DTSTART;VALUE=DATE:${icsDate(e.start)}`, `DTEND;VALUE=DATE:${icsDate(e.end)}`]
      : [`DTSTART:${icsDateTime(e.start)}`, `DTEND:${icsDateTime(e.end)}`]),
    `SUMMARY:${icsEscape(e.title)}`,
    ...(e.description ? [`DESCRIPTION:${icsEscape(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${icsEscape(e.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Google Calendar's "create event" page, prefilled. */
export function googleCalendarUrl(e: CalendarEvent): string {
  const dates = e.allDay ? `${icsDate(e.start)}/${icsDate(e.end)}` : `${icsDateTime(e.start)}/${icsDateTime(e.end)}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates });
  if (e.description) q.set('details', e.description);
  if (e.location) q.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** A file name for the .ics ("Signals midterm 2026-11-14.ics"). */
export function icsFileName(e: CalendarEvent): string {
  const base = e.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60).trim() || 'Event';
  return `${base} ${e.start.getFullYear()}-${pad(e.start.getMonth() + 1)}-${pad(e.start.getDate())}.ics`;
}
