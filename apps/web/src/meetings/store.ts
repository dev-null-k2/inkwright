/**
 * Meetings in the app: your templates and recipes (`ai/meetings/library.json`, synced), each
 * note's enhanced notes (`assets/meeting-notes.json`), and preferences.
 *
 * Preferences split like the memory timeline's: what should be the same everywhere (your email
 * addresses, so you aren't listed as an attendee; auto-enhance) is in the library file; what
 * is about this device (integration secrets) stays in the device's secret store.
 */
import { create } from 'zustand';
import {
  BUILTIN_RECIPES,
  BUILTIN_TEMPLATES,
  MEETINGS_LIBRARY_PATH,
  MEETING_NOTES_ASSET,
  addMeetingNotesVersion,
  decodeMeetingNotes,
  decodeMeetingsLibrary,
  emptyLibrary,
  encodeMeetingNotes,
  encodeMeetingsLibrary,
  removeFromLibrary,
  upsertInLibrary,
  type MeetingNotesFile,
  type MeetingNotesVersion,
  type MeetingTemplate,
  type MeetingsLibrary,
  type Recipe,
} from '@inkwright/core';
import { safeStorage } from '../platform/env.ts';
import type { AppVault } from '../lib/vault.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- Preferences ----------------------------------------------------------------------------------

export interface MeetingPrefs {
  /** Your addresses: left out of attendee lists, and how your company is recognised. */
  selfEmails: string[];
  /** Enhance the notes as soon as a recording in a meeting note ends. */
  autoEnhance: boolean;
  /** Keep the audio after it is transcribed (off: deleted once the transcript is saved). */
  keepAudio: boolean;
  /** Record the other side of calls too (the browser or desktop asks which window or tab). */
  callAudio: boolean;
  /** Remind before a meeting starts, with its brief (minutes; 0 = off). */
  remindMinutes: number;
}

const PREFS_KEY = 'inkwright.meetings.prefs.v1';
const DEFAULT_PREFS: MeetingPrefs = { selfEmails: [], autoEnhance: true, keepAudio: true, callAudio: true, remindMinutes: 2 };

function loadPrefs(): MeetingPrefs {
  try {
    const v = JSON.parse(safeStorage.get(PREFS_KEY) ?? '{}') as Partial<MeetingPrefs>;
    return {
      selfEmails: Array.isArray(v.selfEmails) ? v.selfEmails.filter((x): x is string => typeof x === 'string' && x.includes('@')).map((x) => x.trim().toLowerCase()) : [],
      autoEnhance: v.autoEnhance !== false,
      keepAudio: v.keepAudio !== false,
      callAudio: v.callAudio !== false,
      remindMinutes: Number.isFinite(v.remindMinutes) ? Math.max(0, Math.min(30, Number(v.remindMinutes))) : DEFAULT_PREFS.remindMinutes,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export const useMeetingPrefs = create<MeetingPrefs & { set: (p: Partial<MeetingPrefs>) => void }>((set, get) => ({
  ...loadPrefs(),
  set(p) {
    set(p);
    const { set: _s, ...rest } = { ...get(), ...p };
    safeStorage.set(PREFS_KEY, JSON.stringify(rest));
  },
}));

// ---- Library (templates and recipes) --------------------------------------------------------------

interface LibraryState {
  library: MeetingsLibrary;
  loaded: boolean;
}

export const useMeetingsLibrary = create<LibraryState>(() => ({ library: emptyLibrary(), loaded: false }));

export async function loadMeetingsLibrary(vault: AppVault): Promise<MeetingsLibrary> {
  let library = emptyLibrary();
  try {
    library = decodeMeetingsLibrary(await vault.fs.readText(MEETINGS_LIBRARY_PATH).catch(() => null));
  } catch { /* unreadable: start empty, the file is left as it is until the next save */ }
  useMeetingsLibrary.setState({ library, loaded: true });
  return library;
}

async function saveLibrary(vault: AppVault, next: MeetingsLibrary): Promise<void> {
  await vault.fs.writeText(MEETINGS_LIBRARY_PATH, encodeMeetingsLibrary(next));
  useMeetingsLibrary.setState({ library: next, loaded: true });
}

export async function saveTemplate(vault: AppVault, t: MeetingTemplate): Promise<void> {
  await saveLibrary(vault, upsertInLibrary(await loadMeetingsLibrary(vault), 'templates', t));
}

export async function saveRecipe(vault: AppVault, r: Recipe): Promise<void> {
  await saveLibrary(vault, upsertInLibrary(await loadMeetingsLibrary(vault), 'recipes', r));
}

export async function deleteFromLibrary(vault: AppVault, id: string): Promise<void> {
  await saveLibrary(vault, removeFromLibrary(await loadMeetingsLibrary(vault), id));
}

/** Built-in and your own templates (yours first). */
export function allTemplates(lib: MeetingsLibrary = useMeetingsLibrary.getState().library): MeetingTemplate[] {
  return [...lib.templates, ...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtIn: true }))];
}

export function allRecipes(lib: MeetingsLibrary = useMeetingsLibrary.getState().library): Recipe[] {
  return [...lib.recipes, ...BUILTIN_RECIPES.map((r) => ({ ...r, builtIn: true }))];
}

// ---- Enhanced notes per note ------------------------------------------------------------------------

type Listener = (noteId: string) => void;
const listeners = new Set<Listener>();
export function onMeetingNotesChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function readMeetingNotes(vault: AppVault, noteId: string): Promise<MeetingNotesFile | null> {
  const bytes = await vault.vault.readAsset(noteId, MEETING_NOTES_ASSET).catch(() => null);
  if (!bytes) return null;
  try {
    return decodeMeetingNotes(dec.decode(bytes));
  } catch {
    return null;
  }
}

/** Adds a version and shows it. */
export async function addMeetingNotes(vault: AppVault, noteId: string, v: MeetingNotesVersion): Promise<MeetingNotesFile> {
  const next = addMeetingNotesVersion(await readMeetingNotes(vault, noteId), v);
  await vault.vault.writeAsset(noteId, MEETING_NOTES_ASSET, enc.encode(encodeMeetingNotes(next)));
  for (const l of [...listeners]) l(noteId);
  return next;
}

/** Shows another version (the version list's "Restore"). */
export async function showMeetingNotesVersion(vault: AppVault, noteId: string, versionId: string): Promise<MeetingNotesFile | null> {
  const cur = await readMeetingNotes(vault, noteId);
  if (!cur || !cur.versions.some((v) => v.id === versionId)) return cur;
  const next = { ...cur, current: versionId, updatedAt: Date.now() };
  await vault.vault.writeAsset(noteId, MEETING_NOTES_ASSET, enc.encode(encodeMeetingNotes(next)));
  for (const l of [...listeners]) l(noteId);
  return next;
}
