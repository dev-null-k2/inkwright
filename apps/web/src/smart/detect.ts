import * as chrono from 'chrono-node';

/**
 * What recognized handwriting can be acted on: a date/time (→ calendar), phone numbers, email
 * addresses and links (→ tappable actions), and to-do lines (→ a checklist). Pure text in, plain
 * data out, so it is easy to test and works offline.
 */

export interface FoundEvent {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** The words that were read as the date ("Thu 14 Nov 3pm"). */
  when: string;
}

/**
 * The first date/time mentioned in `text`, as a calendar event. Dates without a time become
 * all-day events; timed events without an end last an hour. The title is the rest of the text.
 * Ambiguous dates resolve forward ("Friday" means the coming Friday).
 */
export function findEvent(text: string, ref: Date = new Date()): FoundEvent | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const results = chrono.parse(clean, ref, { forwardDate: true });
  const r = results.find((x) => x.start.isCertain('day') || x.start.isCertain('weekday') || x.start.isCertain('hour'));
  if (!r) return null;
  const allDay = !r.start.isCertain('hour');
  const start = r.start.date();
  if (allDay) start.setHours(0, 0, 0, 0);
  let end: Date;
  if (r.end) {
    end = r.end.date();
    if (allDay) { end.setHours(0, 0, 0, 0); end = new Date(end.getTime() + 86_400_000); }
  } else end = new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));
  if (end <= start) end = new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));
  const rest = (clean.slice(0, r.index) + ' ' + clean.slice(r.index + r.text.length))
    .replace(/\b(on|at|by|from|due|@)\s*$/i, '')
    .replace(/^\s*(on|at|by|from|due|@)\b/i, '')
    .replace(/\s*[-–—:,;|]\s*$/g, '')
    .replace(/^\s*[-–—:,;|]\s*/g, '')
    .replace(/["“”'‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: rest || 'Event', start, end, allDay, when: r.text };
}

/** "Thu 14 Nov, 3pm" / "Thu 14 Nov" (all day) in the user's locale. */
export function describeWhen(e: Pick<FoundEvent, 'start' | 'end' | 'allDay'>, locale?: string): string {
  const day = e.start.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  if (e.allDay) {
    const days = Math.round((e.end.getTime() - e.start.getTime()) / 86_400_000);
    if (days <= 1) return day;
    const last = new Date(e.end.getTime() - 86_400_000);
    return `${day} – ${last.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })}`;
  }
  const t = e.start.toLocaleTimeString(locale, { hour: 'numeric', minute: e.start.getMinutes() ? '2-digit' : undefined }).replace(/\s?([AP])M/i, (_, a: string) => `${a.toLowerCase()}m`).replace(':00', '');
  return `${day}, ${t}`;
}

export interface FoundLink {
  kind: 'phone' | 'email' | 'url';
  /** As written. */
  text: string;
  /** What to open: tel:, mailto: or https: */
  href: string;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|dev|app|co|uk|de|fr|in|ca|au|us|info|me|ai|ly|tv|gg|xyz|nl|es|it|jp|ch|se|no|fi|be|at|nz|ie|br|mx|pl|ru|cn)\b(?:\/[^\s]*)?/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d[\d\s.-]{5,}\d/g;

/** Phone numbers, email addresses and web links in recognized text, in reading order. */
export function findLinks(text: string): FoundLink[] {
  const out: (FoundLink & { at: number })[] = [];
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  for (const m of text.matchAll(EMAIL)) {
    out.push({ kind: 'email', text: m[0], href: `mailto:${m[0]}`, at: m.index! });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(URL_RE)) {
    const a = m.index!, b = a + m[0].length;
    if (!free(a, b)) continue;
    const t = m[0].replace(/[.,;:!?)]+$/, '');
    out.push({ kind: 'url', text: t, href: /^https?:\/\//i.test(t) ? t : `https://${t}`, at: a });
    taken.push([a, b]);
  }
  for (const m of text.matchAll(PHONE)) {
    const a = m.index!, b = a + m[0].length;
    const digits = m[0].replace(/\D/g, '');
    // 7–15 digits (E.164), and not a date like 2026-11-14 or a time range.
    if (digits.length < 7 || digits.length > 15 || !free(a, b) || /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(m[0].trim())) continue;
    out.push({ kind: 'phone', text: m[0].trim(), href: `tel:${m[0].trim().startsWith('+') ? '+' : ''}${digits}`, at: a });
    taken.push([a, b]);
  }
  return out.sort((x, y) => x.at - y.at).map(({ at: _at, ...l }) => l);
}

/**
 * To-do lines in recognized text ("☐ buy milk", "[ ] call Sam", "- [x] done") as checklist
 * items, or null when the text is not a list of them.
 */
export function findTasks(text: string): { text: string; done: boolean }[] | null {
  const items: { text: string; done: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:[-*•]\s*)?(?:(☐|□|▢|\[\s?\])|(☑|☒|✓|✔|\[[xX✓]\]))\s*(.+)$/.exec(line);
    if (!m) return null;
    items.push({ text: m[3]!.trim(), done: !!m[2] });
  }
  return items.length ? items : null;
}

/** Markdown task list for a text box. */
export function tasksToMarkdown(items: { text: string; done: boolean }[]): string {
  return items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n');
}
