/**
 * Meetings: notes taken in a meeting, made better with what was said.
 *
 * A meeting is an ordinary note with optional `NoteMeta.meeting` (who was there, the calendar
 * event, the template) and, once enhanced, `notes/<id>/assets/meeting-notes.json`: versions of
 * the enhanced notes. Each item says whether it is the writer's own words (`mine`) or added from
 * the transcript, with the moments it came from (`cites`, ms into a recording), so the app can
 * show your words in ink colour, additions in grey, and jump to where each was said.
 * docs/VAULT_FORMAT.md › Meetings.
 */

export const MEETING_NOTES_ASSET = 'meeting-notes.json';
export const MEETING_NOTES_FORMAT = 1;
/** Versions kept per meeting (regenerating or editing adds one; the oldest go first). */
export const MEETING_NOTES_KEEP = 12;

export interface MeetingAttendee {
  name: string;
  email?: string;
}

export interface MeetingEvent {
  /** iCalendar UID of the event (with the occurrence start, unique per occurrence). */
  uid: string;
  start: number;
  end: number;
  /** Name of the calendar it came from. */
  calendar?: string;
  location?: string;
  /** Video call link (Zoom, Meet, Teams…), when the event has one. */
  link?: string;
}

/** `NoteMeta.meeting`: optional, set on notes taken in a meeting. */
export interface MeetingInfo {
  /** Template id (built-in or custom) the notes are shaped by. */
  template?: string;
  attendees?: MeetingAttendee[];
  event?: MeetingEvent;
}

/** One line of enhanced notes. */
export interface MeetingItem {
  id: string;
  text: string;
  /** The writer's own words (kept as written, perhaps tidied); otherwise added from the transcript. */
  mine?: boolean;
  /** Moments it came from: ms from the start of recording `clipId`. */
  cites?: number[];
  clipId?: string;
  /** Nesting under the previous item (0 or 1). */
  depth?: 0 | 1;
  /** Action items: who owns it, and whether it is done. */
  owner?: string;
  done?: boolean;
}

export interface MeetingSection {
  heading: string;
  items: MeetingItem[];
}

export interface MeetingNotesVersion {
  id: string;
  at: number;
  /** What wrote it: the model's label, or `you` for a hand edit. */
  by: string;
  template: string;
  /** Recordings it drew on. */
  clipIds: string[];
  /** One-line summary shown in lists and given to search. */
  tldr?: string;
  sections: MeetingSection[];
  /** How this version came about (shown in the version list). */
  reason?: 'enhance' | 'regenerate' | 'ask' | 'edit';
  /** For `ask`: what was asked. */
  request?: string;
}

export interface MeetingNotesFile {
  formatVersion: number;
  /** Id of the version shown. */
  current: string;
  versions: MeetingNotesVersion[];
  updatedAt: number;
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const ID = /^[0-9A-Za-z_-]{1,64}$/;

function decodeItem(v: unknown, i: number): MeetingItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const text = str(o.text).trim();
  if (!text) return null;
  const item: MeetingItem = { id: typeof o.id === 'string' && ID.test(o.id) ? o.id : `i${i}`, text };
  if (o.mine === true) item.mine = true;
  if (Array.isArray(o.cites)) {
    const c = o.cites.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0).slice(0, 8);
    if (c.length) item.cites = c;
  }
  if (typeof o.clipId === 'string' && ID.test(o.clipId)) item.clipId = o.clipId;
  if (o.depth === 1) item.depth = 1;
  if (typeof o.owner === 'string' && o.owner.trim()) item.owner = o.owner.trim().slice(0, 120);
  if (o.done === true) item.done = true;
  return item;
}

function decodeVersion(v: unknown): MeetingNotesVersion | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  let n = 0;
  const sections = Array.isArray(o.sections)
    ? o.sections.flatMap((s): MeetingSection[] => {
      if (!s || typeof s !== 'object') return [];
      const so = s as Record<string, unknown>;
      const items = Array.isArray(so.items) ? so.items.map((x) => decodeItem(x, n++)).filter((x): x is MeetingItem => !!x) : [];
      const heading = str(so.heading, 200).trim();
      return heading || items.length ? [{ heading, items }] : [];
    })
    : [];
  const reason = ['enhance', 'regenerate', 'ask', 'edit'].includes(o.reason as string) ? (o.reason as MeetingNotesVersion['reason']) : undefined;
  return {
    id: o.id,
    at: Number(o.at) || 0,
    by: str(o.by, 200) || 'AI',
    template: str(o.template, 64) || 'general',
    clipIds: Array.isArray(o.clipIds) ? o.clipIds.filter((x): x is string => typeof x === 'string' && ID.test(x)) : [],
    ...(str(o.tldr, 600).trim() ? { tldr: str(o.tldr, 600).trim() } : {}),
    sections,
    ...(reason ? { reason } : {}),
    ...(str(o.request, 1000).trim() ? { request: str(o.request, 1000).trim() } : {}),
  };
}

export function decodeMeetingNotes(json: string): MeetingNotesFile {
  const o = JSON.parse(json) as Record<string, unknown>;
  const versions = (Array.isArray(o.versions) ? o.versions : []).map(decodeVersion).filter((x): x is MeetingNotesVersion => !!x).sort((a, b) => a.at - b.at);
  if (!versions.length) throw new Error('No versions in the meeting notes');
  const current = typeof o.current === 'string' && versions.some((v) => v.id === o.current) ? o.current : versions[versions.length - 1]!.id;
  return { formatVersion: MEETING_NOTES_FORMAT, current, versions, updatedAt: Number(o.updatedAt) || 0 };
}

export function encodeMeetingNotes(f: MeetingNotesFile): string {
  return `${JSON.stringify({ ...f, formatVersion: MEETING_NOTES_FORMAT }, null, 2)}\n`;
}

/** The version shown. */
export function currentMeetingNotes(f: MeetingNotesFile | null | undefined): MeetingNotesVersion | null {
  if (!f) return null;
  return f.versions.find((v) => v.id === f.current) ?? f.versions[f.versions.length - 1] ?? null;
}

/** Adds a version and shows it, keeping the newest `MEETING_NOTES_KEEP`. */
export function addMeetingNotesVersion(f: MeetingNotesFile | null, v: MeetingNotesVersion): MeetingNotesFile {
  const versions = [...(f?.versions ?? []).filter((x) => x.id !== v.id), v].sort((a, b) => a.at - b.at).slice(-MEETING_NOTES_KEEP);
  return { formatVersion: MEETING_NOTES_FORMAT, current: v.id, versions, updatedAt: Math.max(Date.now(), v.at) };
}

/** True when a hand edit was made to the version shown, so regenerating would replace it (warn first). */
export function hasHandEdits(f: MeetingNotesFile | null | undefined): boolean {
  return currentMeetingNotes(f)?.reason === 'edit';
}

/** Plain text of a version (search, the assistant, the library card). */
export function meetingNotesText(v: MeetingNotesVersion): string {
  const out: string[] = [];
  if (v.tldr) out.push(v.tldr);
  for (const s of v.sections) {
    if (s.heading) out.push(s.heading);
    for (const it of s.items) out.push(`${it.depth ? '  ' : ''}- ${it.text}${it.owner ? ` (${it.owner})` : ''}`);
  }
  return out.join('\n');
}

/** Decodes `NoteMeta.meeting` leniently (unknown shapes are dropped). */
export function decodeMeetingInfo(v: unknown): MeetingInfo | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: MeetingInfo = {};
  if (typeof o.template === 'string' && o.template.length <= 64) out.template = o.template;
  if (Array.isArray(o.attendees)) {
    const a = o.attendees.flatMap((x): MeetingAttendee[] => {
      if (!x || typeof x !== 'object') return [];
      const xo = x as Record<string, unknown>;
      const name = str(xo.name, 200).trim();
      const email = str(xo.email, 320).trim().toLowerCase();
      if (!name && !email) return [];
      return [{ name: name || email.split('@')[0]!, ...(email ? { email } : {}) }];
    }).slice(0, 200);
    if (a.length) out.attendees = a;
  }
  if (o.event && typeof o.event === 'object') {
    const e = o.event as Record<string, unknown>;
    if (typeof e.uid === 'string' && Number.isFinite(Number(e.start))) {
      out.event = {
        uid: e.uid.slice(0, 400), start: Number(e.start), end: Number(e.end) || Number(e.start),
        ...(str(e.calendar, 200) ? { calendar: str(e.calendar, 200) } : {}),
        ...(str(e.location, 400) ? { location: str(e.location, 400) } : {}),
        ...(typeof e.link === 'string' && /^https:\/\//i.test(e.link) ? { link: e.link.slice(0, 1000) } : {}),
      };
    }
  }
  return Object.keys(out).length ? out : undefined;
}
