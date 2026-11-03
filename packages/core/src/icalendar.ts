/**
 * Reading iCalendar (RFC 5545) files: the `.ics` export every calendar app offers and the "secret
 * address in iCal format" Google, Outlook and Apple calendars publish. Used by the journal that
 * writes itself to know what the day held, with no calendar account access.
 *
 * Covers what real calendars emit: folded lines, escaped text, all-day dates, UTC / floating /
 * `TZID` times (IANA names, plus the Windows zone names Outlook writes), `DURATION`, recurring
 * events (`RRULE` with DAILY, WEEKLY, MONTHLY and YEARLY; INTERVAL, COUNT, UNTIL, BYDAY with
 * ordinals, BYMONTHDAY, BYMONTH), `EXDATE`, moved or edited occurrences (`RECURRENCE-ID`) and
 * cancelled events. Not covered: BYSETPOS, BYWEEKNO, BYYEARDAY, hourly and finer frequencies
 * (rare in personal calendars); such rules expand only their first occurrence.
 */

export interface IcsEvent {
  uid: string;
  title: string;
  /** Wall-clock start in the event's zone, or a date for all-day events. */
  start: IcsTime;
  /** Exclusive end; absent means "same as start" (or one day, all-day). */
  end?: IcsTime;
  /** Length when the file gave a DURATION instead of DTEND (ms). */
  durationMs?: number;
  allDay: boolean;
  location?: string;
  description?: string;
  rrule?: RRule;
  /** Excluded occurrence starts (epoch ms). */
  exdates: number[];
  /** Set on an edited occurrence of a recurring event: the original start (epoch ms). */
  recurrenceId?: number;
  cancelled: boolean;
}

export interface IcsTime {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  /** 'utc', an IANA zone, or null for floating/local time (and all-day dates). */
  zone: string | null;
  dateOnly: boolean;
}

export interface RRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: number;
  /** [ordinal or 0, weekday 0=SU…6=SA] */
  byDay?: Array<[number, number]>;
  byMonthDay?: number[];
  byMonth?: number[];
  /** Rule parts we don't expand (BYSETPOS…): only the first occurrence is used. */
  unsupported?: boolean;
}

/** One occurrence, in epoch ms. */
export interface IcsOccurrence {
  uid: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  description?: string;
}

// ---- Lines -----------------------------------------------------------------------------------------

interface Prop { name: string; params: Record<string, string>; value: string }

function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.length);
}

function parseLine(line: string): Prop | null {
  // NAME *(;PARAM=VALUE) : VALUE — parameter values may be quoted and contain ':' or ';'.
  let i = 0;
  let quoted = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return name ? { name, params, value } : null;
}

/** TEXT unescaping (RFC 5545 §3.3.11). */
export function icsUnescape(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

// ---- Times -----------------------------------------------------------------------------------------

/** Windows zone names Outlook and Exchange write in TZID, mapped to IANA (the common ones). */
const WINDOWS_ZONES: Record<string, string> = {
  'Pacific Standard Time': 'America/Los_Angeles', 'Mountain Standard Time': 'America/Denver', 'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York', 'Alaskan Standard Time': 'America/Anchorage', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest', 'Russian Standard Time': 'Europe/Moscow', 'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland', 'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo', 'South Africa Standard Time': 'Africa/Johannesburg', 'Arabian Standard Time': 'Asia/Dubai',
  'Israel Standard Time': 'Asia/Jerusalem', 'Turkey Standard Time': 'Europe/Istanbul', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};

const zoneCache = new Map<string, Intl.DateTimeFormat | null>();
function zoneFormat(zone: string): Intl.DateTimeFormat | null {
  if (!zoneCache.has(zone)) {
    try {
      zoneCache.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    } catch {
      zoneCache.set(zone, null);
    }
  }
  return zoneCache.get(zone)!;
}

/** Resolves a TZID to a zone `Intl` knows (IANA as written, Windows names mapped, Olson suffixes found). */
export function resolveZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.trim();
  if (zoneFormat(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t]!;
  // Some exporters prefix IANA ids ("/mozilla.org/20050126_1/Europe/Berlin").
  const m = /([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(t);
  if (m && zoneFormat(m[1]!)) return m[1]!;
  return null;
}

/** Offset of `zone` from UTC at instant `t` (ms; positive east of Greenwich). */
function zoneOffset(zone: string, t: number): number {
  const f = zoneFormat(zone);
  if (!f) return 0;
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour === 24 ? 0 : p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

/** Epoch ms of a wall-clock time. */
export function icsTimeToEpoch(t: IcsTime): number {
  if (t.zone === 'utc') return Date.UTC(t.y, t.m - 1, t.d, t.hh, t.mm, t.ss);
  if (!t.zone) return new Date(t.y, t.m - 1, t.d, t.hh, t.mm, t.ss).getTime();
  const wall = Date.UTC(t.y, t.m - 1, t.d, t.hh, t.mm, t.ss);
  // Two passes settle the offset around DST changes.
  let guess = wall - zoneOffset(t.zone, wall);
  guess = wall - zoneOffset(t.zone, guess);
  return guess;
}

function parseTime(p: Prop): IcsTime | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const dateOnly = p.params.VALUE === 'DATE' || m[4] == null;
  return {
    y: Number(m[1]), m: Number(m[2]), d: Number(m[3]),
    hh: dateOnly ? 0 : Number(m[4]), mm: dateOnly ? 0 : Number(m[5]), ss: dateOnly ? 0 : Number(m[6] ?? 0),
    zone: dateOnly ? null : m[7] ? 'utc' : resolveZone(p.params.TZID),
    dateOnly,
  };
}

/** ISO 8601 duration (`P1D`, `PT1H30M`, `P2W`) in ms. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = (((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 24 + Number(m[4] ?? 0)) * 60 + Number(m[5] ?? 0)) * 60_000 + Number(m[6] ?? 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRRule(v: string, zoneOf: IcsTime): RRule | null {
  const parts: Record<string, string> = {};
  for (const kv of v.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
  }
  const freq = parts.FREQ as RRule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const r: RRule = { freq, interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1) };
  if (parts.COUNT) r.count = Math.max(1, Number(parts.COUNT) || 1);
  if (parts.UNTIL) {
    const t = parseTime({ name: 'UNTIL', params: {}, value: parts.UNTIL });
    if (t) r.until = icsTimeToEpoch(t.zone || t.dateOnly ? { ...t, ...(t.dateOnly ? { hh: 23, mm: 59, ss: 59, zone: zoneOf.zone } : {}) } : { ...t, zone: zoneOf.zone });
  }
  if (parts.BYDAY) {
    r.byDay = parts.BYDAY.split(',').map((x) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim())).filter(Boolean).map((m) => [Number(m![1] ?? 0), DAYS.indexOf(m![2]!)] as [number, number]);
  }
  if (parts.BYMONTHDAY) r.byMonthDay = parts.BYMONTHDAY.split(',').map(Number).filter((n) => n && Math.abs(n) <= 31);
  if (parts.BYMONTH) r.byMonth = parts.BYMONTH.split(',').map(Number).filter((n) => n >= 1 && n <= 12);
  if (parts.BYSETPOS || parts.BYWEEKNO || parts.BYYEARDAY || parts.BYHOUR || parts.BYMINUTE) r.unsupported = true;
  return r;
}

// ---- Parsing ---------------------------------------------------------------------------------------

/** Parses every VEVENT in a calendar file. Malformed events are skipped. */
export function parseICalendar(text: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: Prop[] | null = null;
  let depth = 0;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !cur) { cur = []; depth = 0; }
      else if (cur) depth++; // VALARM etc. inside an event
      continue;
    }
    if (p.name === 'END') {
      if (cur && depth > 0) { depth--; continue; }
      if (cur && p.value.toUpperCase() === 'VEVENT') {
        const ev = buildEvent(cur);
        if (ev) out.push(ev);
        cur = null;
      }
      continue;
    }
    if (cur && depth === 0) cur.push(p);
  }
  return out;
}

function buildEvent(props: Prop[]): IcsEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const startP = get('DTSTART');
  const start = startP ? parseTime(startP) : null;
  if (!start) return null;
  const endP = get('DTEND');
  const end = endP ? parseTime(endP) ?? undefined : undefined;
  const dur = get('DURATION');
  const ev: IcsEvent = {
    uid: get('UID')?.value.trim() || `${get('SUMMARY')?.value ?? ''}@${startP!.value}`,
    title: icsUnescape(get('SUMMARY')?.value ?? '').trim() || '(No title)',
    start,
    allDay: start.dateOnly,
    exdates: [],
    cancelled: (get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
  };
  if (end) ev.end = end;
  else if (dur) { const ms = parseDuration(dur.value); if (ms != null) ev.durationMs = ms; }
  const loc = get('LOCATION')?.value;
  if (loc) ev.location = icsUnescape(loc).trim();
  const desc = get('DESCRIPTION')?.value;
  if (desc) ev.description = icsUnescape(desc).trim();
  const rr = get('RRULE');
  if (rr) { const r = parseRRule(rr.value, start); if (r) ev.rrule = r; }
  for (const p of props.filter((x) => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const t = parseTime({ ...p, value: v });
      if (t) ev.exdates.push(icsTimeToEpoch(t.dateOnly ? t : { ...t, zone: t.zone ?? start.zone }));
    }
  }
  const rid = get('RECURRENCE-ID');
  if (rid) { const t = parseTime(rid); if (t) ev.recurrenceId = icsTimeToEpoch(t.dateOnly ? t : { ...t, zone: t.zone ?? start.zone }); }
  return ev;
}

// ---- Expansion -------------------------------------------------------------------------------------

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

function lengthOf(ev: IcsEvent): number {
  const s = icsTimeToEpoch(ev.start);
  if (ev.end) return Math.max(0, icsTimeToEpoch(ev.end) - s);
  if (ev.durationMs != null) return Math.max(0, ev.durationMs);
  return ev.allDay ? 86_400_000 : 0;
}

/** Candidate dates of one period (month/year/week) of a rule, in order. */
function datesInPeriod(r: RRule, base: IcsTime, y: number, m: number, weekStart?: { y: number; m: number; d: number }): Array<{ y: number; m: number; d: number }> {
  const out: Array<{ y: number; m: number; d: number }> = [];
  const push = (yy: number, mm: number, dd: number) => { if (dd >= 1 && dd <= daysInMonth(yy, mm)) out.push({ y: yy, m: mm, d: dd }); };
  if (r.freq === 'WEEKLY' && weekStart) {
    const days = r.byDay?.length ? r.byDay.map(([, wd]) => wd) : [weekday(base.y, base.m, base.d)];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(Date.UTC(weekStart.y, weekStart.m - 1, weekStart.d + i));
      if (days.includes(dt.getUTCDay())) out.push({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
    }
    return out;
  }
  const monthDates = (yy: number, mm: number) => {
    const dim = daysInMonth(yy, mm);
    if (r.byMonthDay?.length) for (const md of r.byMonthDay) push(yy, mm, md > 0 ? md : dim + md + 1);
    else if (r.byDay?.length) {
      for (const [ord, wd] of r.byDay) {
        const all: number[] = [];
        for (let d = 1; d <= dim; d++) if (weekday(yy, mm, d) === wd) all.push(d);
        if (!ord) all.forEach((d) => push(yy, mm, d));
        else { const d = ord > 0 ? all[ord - 1] : all[all.length + ord]; if (d) push(yy, mm, d); }
      }
    } else push(yy, mm, base.d);
  };
  if (r.freq === 'MONTHLY') monthDates(y, m);
  else if (r.freq === 'YEARLY') {
    const months = r.byMonth?.length ? r.byMonth : [base.m];
    for (const mm of months) {
      if (r.byMonthDay?.length || r.byDay?.length) monthDates(y, mm);
      else push(y, mm, base.d);
    }
  }
  return out.sort((a, b) => a.y - b.y || a.m - b.m || a.d - b.d);
}

/**
 * Occurrences of the events that overlap `[from, to)`. Edited occurrences replace the ones they
 * move; cancelled events and excluded dates are left out. At most `limit` per event.
 */
export function expandEvents(events: readonly IcsEvent[], from: number, to: number, limit = 2000): IcsOccurrence[] {
  const overrides = new Map<string, Map<number, IcsEvent>>();
  for (const e of events) if (e.recurrenceId != null) {
    let m = overrides.get(e.uid);
    if (!m) overrides.set(e.uid, (m = new Map()));
    m.set(e.recurrenceId, e);
  }
  const out: IcsOccurrence[] = [];
  const emit = (e: IcsEvent, start: number, len: number) => {
    if (e.cancelled) return;
    const end = start + len;
    if (end > from && start < to || (len === 0 && start >= from && start < to)) {
      out.push({ uid: e.uid, title: e.title, start, end, allDay: e.allDay, ...(e.location ? { location: e.location } : {}), ...(e.description ? { description: e.description } : {}) });
    }
  };
  for (const e of events) {
    if (e.recurrenceId != null) { emit(e, icsTimeToEpoch(e.start), lengthOf(e)); continue; }
    const len = lengthOf(e);
    const first = icsTimeToEpoch(e.start);
    const moved = overrides.get(e.uid);
    const occurrence = (t: number) => {
      if (e.exdates.includes(t)) return;
      if (moved?.has(t)) return; // the edited copy is emitted on its own
      emit(e, t, len);
    };
    const r = e.rrule;
    if (!r || r.unsupported) { occurrence(first); continue; }
    let n = 0;
    const s = e.start;
    const at = (d: { y: number; m: number; d: number }) => icsTimeToEpoch({ ...s, y: d.y, m: d.m, d: d.d });
    const done = (t: number) => (r.until != null && t > r.until) || (r.count != null && n >= r.count) || t >= to || n >= limit * 4;
    // Walk period by period from the first occurrence.
    outer: for (let p = 0; p < 50_000; p++) {
      let dates: Array<{ y: number; m: number; d: number }>;
      if (r.freq === 'DAILY') {
        const dt = new Date(Date.UTC(s.y, s.m - 1, s.d + p * r.interval));
        dates = [{ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }];
        if (r.byDay?.length && !r.byDay.some(([, wd]) => wd === dt.getUTCDay())) dates = [];
        if (r.byMonth?.length && !r.byMonth.includes(dates[0]?.m ?? 0)) dates = [];
      } else if (r.freq === 'WEEKLY') {
        // Weeks start on Monday (WKST default).
        const back = (weekday(s.y, s.m, s.d) + 6) % 7;
        const ws = new Date(Date.UTC(s.y, s.m - 1, s.d - back + p * 7 * r.interval));
        dates = datesInPeriod(r, s, 0, 0, { y: ws.getUTCFullYear(), m: ws.getUTCMonth() + 1, d: ws.getUTCDate() });
      } else if (r.freq === 'MONTHLY') {
        const mi = s.m - 1 + p * r.interval;
        dates = datesInPeriod(r, s, s.y + Math.floor(mi / 12), (mi % 12) + 1);
      } else {
        dates = datesInPeriod(r, s, s.y + p * r.interval, s.m);
      }
      for (const d of dates) {
        const t = at(d);
        if (t < first) continue;
        if (done(t)) break outer;
        n++;
        if (t + len >= from || t >= from) occurrence(t);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || (a.title < b.title ? -1 : 1));
}
