/**
 * The journal's settings and imported calendars, in the vault so every device drafts the same way:
 *
 *   ai/journal/config.json            JournalConfig (style, handwriting, timeline, calendar list)
 *   ai/journal/calendars/<id>.ics     each imported calendar, as the iCalendar file it came as
 *
 * Calendars are kept as their original `.ics` files — an open format any tool reads — and
 * expanded (recurrences, time zones) when a day is drafted (core `expandEvents`). A calendar
 * added by address is refreshed before each draft; the address itself is a secret (it grants
 * read access to the calendar), so it is kept in this device's encrypted secret store, never in
 * the vault, and other devices use the last file it fetched.
 */
import { create } from 'zustand';
import { newId, parseICalendar } from '@inkwright/core';
import { getSecret, setSecret } from '../lib/secrets.ts';
import type { AppVault } from '../lib/vault.ts';
import { invoke, isDesktop } from '../desktop/bridge.ts';

export const JOURNAL_CONFIG_PATH = 'ai/journal/config.json';
export const calendarPath = (id: string) => `ai/journal/calendars/${id}.ics`;
const secretName = (id: string) => `journal.calendar.${id}`;

export interface CalendarRef {
  id: string;
  name: string;
  source: 'file' | 'url';
  /** The host of a subscribed address (shown; the address itself is a device secret). */
  host?: string;
  events: number;
  updatedAt: number;
}

export interface JournalConfig {
  formatVersion: 1;
  /** Write the draft in AI handwriting or as typed text. */
  style: 'ink' | 'typed';
  hand: 'script' | 'print';
  /** Use the memory timeline as a source (when it is on). */
  includeTimeline: boolean;
  calendars: CalendarRef[];
  updatedAt: number;
}

export const DEFAULT_JOURNAL: JournalConfig = { formatVersion: 1, style: 'ink', hand: 'script', includeTimeline: true, calendars: [], updatedAt: 0 };

export function decodeJournalConfig(json: string | null): JournalConfig {
  if (!json) return { ...DEFAULT_JOURNAL, calendars: [] };
  try {
    const v = JSON.parse(json) as Partial<JournalConfig>;
    const cals = Array.isArray(v.calendars) ? v.calendars.filter((c): c is CalendarRef => !!c && typeof c.id === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(c.id) && typeof c.name === 'string') : [];
    return {
      formatVersion: 1,
      style: v.style === 'typed' ? 'typed' : 'ink',
      hand: v.hand === 'print' ? 'print' : 'script',
      includeTimeline: v.includeTimeline !== false,
      calendars: cals.map((c) => ({ id: c.id, name: c.name, source: c.source === 'url' ? 'url' : 'file', ...(typeof c.host === 'string' ? { host: c.host } : {}), events: Number(c.events) || 0, updatedAt: Number(c.updatedAt) || 0 })),
      updatedAt: Number(v.updatedAt) || 0,
    };
  } catch {
    return { ...DEFAULT_JOURNAL, calendars: [] };
  }
}

export const useJournal = create<{ config: JournalConfig; loaded: boolean }>(() => ({ config: { ...DEFAULT_JOURNAL, calendars: [] }, loaded: false }));

export async function loadJournalConfig(vault: AppVault): Promise<JournalConfig> {
  const config = decodeJournalConfig(await vault.fs.readText(JOURNAL_CONFIG_PATH).catch(() => null));
  useJournal.setState({ config, loaded: true });
  return config;
}

export async function saveJournalConfig(vault: AppVault, patch: Partial<Omit<JournalConfig, 'formatVersion'>>): Promise<JournalConfig> {
  const current = await loadJournalConfig(vault);
  const config: JournalConfig = { ...current, ...patch, formatVersion: 1, updatedAt: Date.now() };
  await vault.fs.writeText(JOURNAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  useJournal.setState({ config });
  return config;
}

/** Checks a calendar file and counts its events; throws a readable error when it isn't one. */
export function checkCalendar(text: string): number {
  if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text)) throw new Error('That is not a calendar (.ics) file.');
  return parseICalendar(text).length;
}

/** Imports a `.ics` file the user picked. */
export async function importCalendarFile(vault: AppVault, name: string, text: string): Promise<CalendarRef> {
  const events = checkCalendar(text);
  const ref: CalendarRef = { id: newId(), name: name.replace(/\.ics$/i, '') || 'Calendar', source: 'file', events, updatedAt: Date.now() };
  await vault.fs.writeText(calendarPath(ref.id), text);
  const cfg = await loadJournalConfig(vault);
  await saveJournalConfig(vault, { calendars: [...cfg.calendars, ref] });
  return ref;
}

/**
 * Downloads a calendar address. The desktop app fetches it natively (calendar servers send no
 * CORS headers); elsewhere the browser tries, and explains the way out when the server refuses.
 */
export async function fetchCalendar(url: string): Promise<string> {
  const u = url.trim().replace(/^webcals?:\/\//i, 'https://');
  if (!/^https:\/\//i.test(u)) throw new Error('Calendar addresses start with https:// or webcal://.');
  if (isDesktop) return invoke<string>('calendar_fetch', { url: u });
  let res: Response;
  try {
    res = await fetch(u, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new Error('This calendar’s server doesn’t let web pages read it. Download its .ics file and import that, or add the address in the desktop app.');
  }
  if (!res.ok) throw new Error(`The calendar server answered ${res.status}.`);
  return res.text();
}

/** Subscribes to a calendar by address (kept as a device secret) and fetches it now. */
export async function addCalendarUrl(vault: AppVault, name: string, url: string): Promise<CalendarRef> {
  const text = await fetchCalendar(url);
  const events = checkCalendar(text);
  const ref: CalendarRef = { id: newId(), name: name.trim() || 'Calendar', source: 'url', host: new URL(url.replace(/^webcals?:/i, 'https:')).host, events, updatedAt: Date.now() };
  await setSecret(secretName(ref.id), url.trim());
  await vault.fs.writeText(calendarPath(ref.id), text);
  const cfg = await loadJournalConfig(vault);
  await saveJournalConfig(vault, { calendars: [...cfg.calendars, ref] });
  return ref;
}

/** Re-fetches subscribed calendars this device knows the address of; failures keep the last copy. */
export async function refreshCalendars(vault: AppVault): Promise<{ refreshed: number; failed: string[] }> {
  const cfg = await loadJournalConfig(vault);
  let refreshed = 0;
  const failed: string[] = [];
  const next = [...cfg.calendars];
  for (const [i, c] of cfg.calendars.entries()) {
    if (c.source !== 'url') continue;
    const url = await getSecret(secretName(c.id)).catch(() => null);
    if (!url) continue;
    try {
      const text = await fetchCalendar(url);
      next[i] = { ...c, events: checkCalendar(text), updatedAt: Date.now() };
      await vault.fs.writeText(calendarPath(c.id), text);
      refreshed++;
    } catch {
      failed.push(c.name);
    }
  }
  if (refreshed) await saveJournalConfig(vault, { calendars: next });
  return { refreshed, failed };
}

export async function removeCalendar(vault: AppVault, id: string): Promise<void> {
  const cfg = await loadJournalConfig(vault);
  await vault.fs.delete(calendarPath(id));
  await setSecret(secretName(id), null).catch(() => {});
  await saveJournalConfig(vault, { calendars: cfg.calendars.filter((c) => c.id !== id) });
}
