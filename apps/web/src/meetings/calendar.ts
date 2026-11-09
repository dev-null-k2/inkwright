/**
 * Meetings from your calendars: the ones coming up (from the calendars added in Settings — the
 * same `.ics` files and subscriptions the journal uses), starting a note for one with its title,
 * attendees, call link and a template that fits, and reminders shortly before with the brief.
 */
import { create } from 'zustand';
import {
  expandEvents,
  meetingFromEvent,
  parseICalendar,
  suggestTemplate,
  upcomingMeetings,
  type IcsOccurrence,
  type NoteMeta,
  type UpcomingMeeting,
} from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { createNote, noteChanged } from '../lib/actions.ts';
import { calendarPath, loadJournalConfig, refreshCalendars } from '../journal/config.ts';
import type { AppVault } from '../lib/vault.ts';
import { useMeetingPrefs, useMeetingsLibrary } from './store.ts';

interface UpcomingState {
  meetings: UpcomingMeeting[];
  calendars: number;
  loadedAt: number;
}

export const useUpcoming = create<UpcomingState>(() => ({ meetings: [], calendars: 0, loadedAt: 0 }));

/** Reads every calendar and lists meetings under way and in the next 36 hours. */
export async function loadUpcoming(vault: AppVault, opts: { refresh?: boolean; now?: number } = {}): Promise<UpcomingMeeting[]> {
  if (opts.refresh) await refreshCalendars(vault).catch(() => null);
  const cfg = await loadJournalConfig(vault);
  const now = opts.now ?? Date.now();
  const occ: Array<IcsOccurrence & { calendar?: string }> = [];
  for (const c of cfg.calendars) {
    const text = await vault.fs.readText(calendarPath(c.id)).catch(() => null);
    if (!text) continue;
    try {
      for (const o of expandEvents(parseICalendar(text), now - 12 * 3600_000, now + 48 * 3600_000)) occ.push({ ...o, calendar: c.name });
    } catch { /* a broken calendar file is skipped */ }
  }
  const meetings = upcomingMeetings(occ, now);
  useUpcoming.setState({ meetings, calendars: cfg.calendars.length, loadedAt: now });
  return meetings;
}

/** The note already started for an event occurrence, if any. */
export function noteForEvent(notes: readonly NoteMeta[], key: string): NoteMeta | undefined {
  return notes.find((n) => !n.trashedAt && n.meeting?.event?.uid === key);
}

/** A note asked to start recording as soon as it opens (one-shot, read by the editor). */
let recordOnOpen: string | null = null;
export const consumeRecordOnOpen = (noteId: string) => {
  if (recordOnOpen !== noteId) return false;
  recordOnOpen = null;
  return true;
};

/** Creates (or opens) the meeting note for an event and goes to it; optionally starts recording. */
export async function startMeetingNote(vault: AppVault, e: UpcomingMeeting | null, opts: { record?: boolean; title?: string; /** Runs with the new note's id before it opens. */ beforeOpen?: (id: string) => void } = {}): Promise<string> {
  const app = useApp.getState();
  const existing = e ? noteForEvent(app.notes, e.key) : undefined;
  if (existing) {
    if (opts.record) recordOnOpen = existing.id;
    app.navigate({ name: 'editor', noteId: existing.id });
    return existing.id;
  }
  const self = useMeetingPrefs.getState().selfEmails;
  const info = e ? meetingFromEvent(e, self) : { title: opts.title ?? 'Meeting', attendees: [], event: undefined };
  const template = suggestTemplate(info.title, useMeetingsLibrary.getState().library.templates, info.attendees.length + 1);
  const notebookId = app.filter.kind === 'notebook' ? app.filter.id : undefined;
  const id = await createNote({ title: info.title, ...(notebookId ? { notebookId } : {}) });
  if (!id) throw new Error('No vault is open.');
  await vault.vault.updateNote(id, (m) => ({ ...m, tags: [...new Set([...m.tags, 'meeting'])], meeting: { template: template.id, ...(info.attendees.length ? { attendees: info.attendees } : {}), ...(info.event ? { event: info.event } : {}) } }));
  await noteChanged(id);
  const note = { id };
  if (opts.record) recordOnOpen = note.id;
  opts.beforeOpen?.(note.id);
  app.navigate({ name: 'editor', noteId: note.id });
  return note.id;
}
