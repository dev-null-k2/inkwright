/**
 * Meetings around people and time: the video link of an event, the meetings coming up, which
 * company someone is from (their email domain), and earlier meetings with the same people
 * (what a brief before the next one is made of).
 */
import type { IcsOccurrence, IcsPerson } from '../icalendar.ts';
import type { NoteMeta } from '../model.ts';
import type { MeetingAttendee, MeetingEvent } from './model.ts';

/** Video call links, most specific first. */
const CALL_LINK = /https:\/\/(?:[\w-]+\.)?(?:zoom\.us\/(?:j|my|w|s)\/[^\s<>"')\]]+|meet\.google\.com\/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}[^\s<>"')\]]*|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')\]]+|teams\.live\.com\/meet\/[^\s<>"')\]]+|[\w-]+\.webex\.com\/[^\s<>"')\]]+|whereby\.com\/[^\s<>"')\]]+|app\.slack\.com\/huddle\/[^\s<>"')\]]+|meet\.jit\.si\/[^\s<>"')\]]+|chime\.aws\/[^\s<>"')\]]+|around\.co\/[^\s<>"')\]]+)/i;

/** The video call link of an event (URL property, location, then description), if any. */
export function meetingLink(ev: Pick<IcsOccurrence, 'url' | 'location' | 'description'>): string | undefined {
  for (const t of [ev.url, ev.location, ev.description]) {
    const m = t ? CALL_LINK.exec(t) : null;
    if (m) return m[0].replace(/[.,;]+$/, '');
  }
  return undefined;
}

/** Which service a call link is on, for its label. */
export function callService(link: string | undefined): string | null {
  if (!link) return null;
  const h = /^https:\/\/([^/]+)/i.exec(link)?.[1]?.toLowerCase() ?? '';
  if (h.endsWith('zoom.us')) return 'Zoom';
  if (h === 'meet.google.com') return 'Google Meet';
  if (h.startsWith('teams.')) return 'Microsoft Teams';
  if (h.endsWith('webex.com')) return 'Webex';
  if (h === 'whereby.com') return 'Whereby';
  if (h === 'app.slack.com') return 'Slack huddle';
  if (h === 'meet.jit.si') return 'Jitsi';
  return null;
}

/** An event that is a meeting worth taking notes in: timed, not cancelled, not a one-person block. */
export function isMeetingEvent(ev: IcsOccurrence): boolean {
  if (ev.allDay) return false;
  if (ev.end - ev.start < 5 * 60_000 || ev.end - ev.start > 10 * 3600_000) return false;
  if (/^(busy|blocked?|focus( time)?|lunch|ooo|out of office|commute|travel|hold)$/i.test(ev.title.trim())) return false;
  return (ev.attendees?.length ?? 0) > 1 || !!meetingLink(ev) || !ev.attendees;
}

export interface UpcomingMeeting extends IcsOccurrence {
  /** The occurrence's own id (uid plus start). */
  key: string;
  link?: string;
  calendar?: string;
  /** Happening now (from 5 minutes before the start until the end). */
  now: boolean;
}

/** Meetings from `now` to `now + horizonMs`, plus any under way, in start order. */
export function upcomingMeetings(occ: readonly (IcsOccurrence & { calendar?: string })[], now: number, horizonMs = 36 * 3600_000): UpcomingMeeting[] {
  const seen = new Set<string>();
  const out: UpcomingMeeting[] = [];
  for (const e of [...occ].sort((a, b) => a.start - b.start)) {
    if (!isMeetingEvent(e) || e.end <= now || e.start > now + horizonMs) continue;
    const key = `${e.uid}@${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const link = meetingLink(e);
    out.push({ ...e, key, ...(link ? { link } : {}), now: e.start - 5 * 60_000 <= now && now < e.end });
  }
  return out;
}

/** The meeting info a note started from an event gets. */
export function meetingFromEvent(e: UpcomingMeeting, selfEmails: readonly string[] = []): { title: string; attendees: MeetingAttendee[]; event: MeetingEvent } {
  const self = new Set(selfEmails.map((x) => x.toLowerCase()));
  const attendees = (e.attendees ?? []).filter((p) => !p.email || !self.has(p.email)).map(personToAttendee);
  return {
    title: e.title,
    attendees,
    event: { uid: e.key, start: e.start, end: e.end, ...(e.calendar ? { calendar: e.calendar } : {}), ...(e.location ? { location: e.location } : {}), ...(e.link ? { link: e.link } : {}) },
  };
}

export function personToAttendee(p: IcsPerson): MeetingAttendee {
  const name = p.name?.trim() || (p.email ? nameFromEmail(p.email) : 'Someone');
  return { name, ...(p.email ? { email: p.email.toLowerCase() } : {}) };
}

/** "jane.doe@acme.com" → "Jane Doe". */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.split(/[._+-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || email;
}

/** Personal email providers: an address there says nothing about a company. */
const PERSONAL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'hey.com', 'fastmail.com', 'tutanota.com', 'rediffmail.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net']);

/** The company domain of an address, or null for personal providers and malformed ones. */
export function companyDomain(email: string | undefined): string | null {
  const d = email?.toLowerCase().split('@')[1]?.trim();
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || PERSONAL.has(d)) return null;
  // mail.acme.co.uk → acme.co.uk; eu.acme.com → acme.com
  const parts = d.split('.');
  const twoLevel = /^(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

/** "acme-corp.com" → "Acme Corp". */
export function companyName(domain: string): string {
  const base = domain.split('.')[0] ?? domain;
  return base.split(/[-_]+/).filter(Boolean).map((w) => (w.length <= 3 && w === w.toLowerCase() && /^(ai|io|hq)$/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(' ');
}

export interface PersonSummary {
  key: string;
  name: string;
  email?: string;
  company?: string;
  meetings: string[];
  last: number;
}

export interface CompanySummary {
  domain: string;
  name: string;
  people: string[];
  meetings: string[];
  last: number;
}

const personKey = (a: MeetingAttendee) => (a.email ? a.email.toLowerCase() : `name:${a.name.trim().toLowerCase()}`);

/** People and companies across meeting notes (live notes only), most recent first. */
export function peopleAndCompanies(notes: readonly Pick<NoteMeta, 'id' | 'createdAt' | 'trashedAt' | 'meeting'>[], selfEmails: readonly string[] = []): { people: PersonSummary[]; companies: CompanySummary[] } {
  const self = new Set(selfEmails.map((x) => x.toLowerCase()));
  const selfDomains = new Set([...self].map((e) => companyDomain(e)).filter((x): x is string => !!x));
  const people = new Map<string, PersonSummary>();
  const companies = new Map<string, CompanySummary>();
  for (const n of notes) {
    if (n.trashedAt || !n.meeting?.attendees?.length) continue;
    const when = n.meeting.event?.start ?? n.createdAt;
    for (const a of n.meeting.attendees) {
      if (a.email && self.has(a.email.toLowerCase())) continue;
      const k = personKey(a);
      const dom = companyDomain(a.email);
      const p = people.get(k) ?? { key: k, name: a.name, ...(a.email ? { email: a.email } : {}), ...(dom && !selfDomains.has(dom) ? { company: dom } : {}), meetings: [], last: 0 };
      if (!p.meetings.includes(n.id)) p.meetings.push(n.id);
      p.last = Math.max(p.last, when);
      people.set(k, p);
      if (dom && !selfDomains.has(dom)) {
        const c = companies.get(dom) ?? { domain: dom, name: companyName(dom), people: [], meetings: [], last: 0 };
        if (!c.people.includes(k)) c.people.push(k);
        if (!c.meetings.includes(n.id)) c.meetings.push(n.id);
        c.last = Math.max(c.last, when);
        companies.set(dom, c);
      }
    }
  }
  const byLast = <T extends { last: number }>(x: T, y: T) => y.last - x.last;
  return { people: [...people.values()].sort(byLast), companies: [...companies.values()].sort(byLast) };
}

/**
 * Earlier meetings that share people (or, failing that, a company) with these attendees, newest
 * first: what a brief before the next meeting draws on. Notes without attendees whose title
 * matches the event title (a recurring meeting) count too.
 */
export function relatedMeetings(target: { title?: string; attendees?: readonly MeetingAttendee[]; before?: number; excludeId?: string }, notes: readonly Pick<NoteMeta, 'id' | 'title' | 'createdAt' | 'trashedAt' | 'meeting'>[], limit = 6): string[] {
  const keys = new Set((target.attendees ?? []).map(personKey));
  const doms = new Set((target.attendees ?? []).map((a) => companyDomain(a.email)).filter((x): x is string => !!x));
  const title = (target.title ?? '').trim().toLowerCase();
  const scored: Array<{ id: string; score: number; at: number }> = [];
  for (const n of notes) {
    if (n.trashedAt || n.id === target.excludeId) continue;
    const at = n.meeting?.event?.start ?? n.createdAt;
    if (target.before != null && at >= target.before) continue;
    let score = 0;
    for (const a of n.meeting?.attendees ?? []) {
      if (keys.has(personKey(a))) score += 3;
      else { const d = companyDomain(a.email); if (d && doms.has(d)) score += 1; }
    }
    if (title && title.length > 3 && n.title.trim().toLowerCase() === title) score += 4;
    if (score > 0) scored.push({ id: n.id, score, at });
  }
  return scored.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit).sort((a, b) => b.at - a.at).map((x) => x.id);
}
