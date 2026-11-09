/**
 * Making meeting notes better with what was said: enhance (your notes + the transcript, shaped by
 * a template), edit by asking, recipes on one meeting or many, and briefs before a meeting.
 * Every call goes through `getActiveAI` (the trust gateway decides what the AI may see) and
 * runs on this device when the on-device model is the one chosen.
 */
import {
  briefMessages,
  editNotesMessages,
  enhanceMessages,
  notesToLines,
  parseEnhancedNotes,
  recipeMessages,
  versionFromParsed,
  type RecipeMeeting,
  type StampedLine,
} from '@inkwright/ai';
import {
  currentMeetingNotes,
  findTemplate,
  inkNoteLines,
  inkNotesText,
  pageText,
  meetingStats,
  relatedMeetings,
  statsText,
  speakerName,
  suggestTemplate,
  type MeetingAttendee,
  type MeetingNotesVersion,
  type NoteMeta,
  type PageInk,
  type Recipe,
  type RecordingTranscript,
} from '@inkwright/core';
import { getActiveAI, type ActiveAI } from '../lib/ai.ts';
import { loadNoteTranscripts } from '../lib/listen/transcripts.ts';
import type { AppVault } from '../lib/vault.ts';
import { addMeetingNotes, readMeetingNotes, useMeetingsLibrary } from './store.ts';

export class NoMeetingAIError extends Error {
  constructor() {
    super('Enhancing notes needs an AI. Download the on-device model or connect a provider in Settings › AI.');
    this.name = 'NoMeetingAIError';
  }
}

async function chat(ai: ActiveAI, messages: Parameters<ActiveAI['provider']['chat']>[0]['messages'], maxTokens: number, signal?: AbortSignal, onText?: (t: string) => void): Promise<string> {
  if (onText && ai.provider.capabilities.streaming) {
    let text = '';
    const r = await ai.provider.chat({ model: ai.model, messages, temperature: 0.2, maxTokens, signal }, (e) => {
      if (e.type === 'text') { text += e.delta; onText(text); }
    });
    return r.text || text;
  }
  const r = await ai.provider.chat({ model: ai.model, messages, temperature: 0.2, maxTokens, signal });
  return r.text;
}

/** The other person on a two-person call (so "them" in a transcript gets their name). */
export function themOf(note: Pick<NoteMeta, 'meeting'>): string | undefined {
  const a = note.meeting?.attendees ?? [];
  return a.length === 1 ? a[0]!.name : undefined;
}

/** Your notes as text: typed text, handwriting read from the pages, page objects. */
export function notesTextOf(pages: readonly PageInk[]): string {
  return pages.map((p) => pageText(p).trim()).filter(Boolean).join('\n');
}

/** The note's transcript as stamped lines (several recordings run one after another). */
export function transcriptLines(recs: readonly RecordingTranscript[], opts: { them?: string } = {}): { lines: StampedLine[]; clipId?: string; durationMs: number } {
  if (!recs.length) return { lines: [], durationMs: 0 };
  // Speakers, when known, lead each line ("Dana: …"), so the notes can say who said what.
  const line = (r: RecordingTranscript, s: RecordingTranscript['file']['segments'][number], offset: number): StampedLine => {
    const who = speakerName(r.file, s.speaker, opts);
    return { ms: offset + s.startMs, text: who ? `${who}: ${s.text}` : s.text };
  };
  if (recs.length === 1) return { lines: recs[0]!.file.segments.map((s) => line(recs[0]!, s, 0)), clipId: recs[0]!.clip.id, durationMs: recs[0]!.clip.durationMs };
  // Several recordings: times continue from one to the next; citations go to the longest one.
  const lines: StampedLine[] = [];
  let offset = 0;
  for (const r of recs) {
    for (const s of r.file.segments) lines.push(line(r, s, offset));
    offset += r.clip.durationMs;
  }
  const longest = [...recs].sort((a, b) => b.clip.durationMs - a.clip.durationMs)[0]!;
  return { lines, clipId: longest.clip.id, durationMs: offset };
}

/** Marked moments of the note's recordings, on the same timeline as `transcriptLines`. */
export function marksOf(recs: readonly RecordingTranscript[]): number[] {
  const out: number[] = [];
  let offset = 0;
  for (const r of recs) {
    for (const m of r.file.marks ?? []) out.push(offset + m.ms);
    if (recs.length > 1) offset += r.clip.durationMs;
  }
  return out;
}

export interface EnhanceArgs {
  vault: AppVault;
  note: Pick<NoteMeta, 'id' | 'title' | 'recordings' | 'meeting' | 'createdAt'>;
  pages: readonly PageInk[];
  /** Template to use (default: the note's, else one suggested from the title). */
  templateId?: string;
  reason?: MeetingNotesVersion['reason'];
  signal?: AbortSignal;
  onText?: (partial: string) => void;
  ai?: ActiveAI | null;
}

/** Enhances a meeting note and saves the new version. */
export async function enhanceMeetingNotes(a: EnhanceArgs): Promise<MeetingNotesVersion> {
  const ai = a.ai ?? (await getActiveAI({ task: 'heavy', source: 'meetings', label: 'Enhance meeting notes', notes: [a.note] }));
  if (!ai) throw new NoMeetingAIError();
  const custom = useMeetingsLibrary.getState().library.templates;
  const template = a.templateId || a.note.meeting?.template
    ? findTemplate(a.templateId ?? a.note.meeting?.template, custom)
    : suggestTemplate(a.note.title, custom, a.note.meeting?.attendees?.length ? a.note.meeting.attendees.length + 1 : 0);
  const recs = await loadNoteTranscripts(a.vault, a.note);
  const { lines, clipId, durationMs } = transcriptLines(recs, { them: themOf(a.note) });
  // Your notes, each at the moment you wrote it (handwriting and typing both carry their time).
  let offset = 0;
  const clips = recs.map((r) => { const c = { startedAt: r.clip.startedAt, durationMs: r.clip.durationMs, offsetMs: recs.length > 1 ? offset : 0 }; offset += r.clip.durationMs; return c; });
  const inkLines = inkNoteLines(a.pages, clips);
  const notes = inkLines.length ? inkNotesText(inkLines) : notesTextOf(a.pages);
  if (!lines.length && !notes.trim()) throw new Error('There is nothing to enhance yet: write some notes or record the meeting.');
  const budget = ai.contextTokens ? Math.max(3000, Math.min(24000, (ai.contextTokens - 1500) * 3)) : 14000;
  const marks = marksOf(recs);
  const messages = enhanceMessages({ title: a.note.title, at: a.note.meeting?.event?.start ?? a.note.createdAt, attendees: a.note.meeting?.attendees, template, notes, transcript: lines, maxChars: budget, ...(marks.length ? { marks } : {}) });
  const raw = await chat(ai, messages, 1400, a.signal, a.onText);
  const parsed = parseEnhancedNotes(raw, { notes, ...(clipId ? { clipId } : {}), durationMs, headings: template.sections.map((s) => s.heading), transcript: lines });
  if (!parsed.sections.length) throw new Error('The AI didn’t write any notes. Try again, or choose a larger model in Settings › AI.');
  const v = versionFromParsed(parsed, { by: ai.label, template: template.id, clipIds: recs.map((r) => r.clip.id), reason: a.reason ?? 'enhance' });
  await addMeetingNotes(a.vault, a.note.id, v);
  return v;
}

/** "Make it shorter", "add the pricing details"…: a new version with the change. */
export async function editMeetingNotesByAsking(a: { vault: AppVault; note: Pick<NoteMeta, 'id' | 'title' | 'recordings' | 'meeting'>; pages: readonly PageInk[]; request: string; signal?: AbortSignal; onText?: (t: string) => void }): Promise<MeetingNotesVersion> {
  const file = await readMeetingNotes(a.vault, a.note.id);
  const current = currentMeetingNotes(file);
  if (!current) throw new Error('Enhance the notes first.');
  const ai = await getActiveAI({ task: 'heavy', source: 'meetings', label: 'Edit meeting notes', notes: [a.note] });
  if (!ai) throw new NoMeetingAIError();
  const recs = await loadNoteTranscripts(a.vault, a.note);
  const { lines, clipId, durationMs } = transcriptLines(recs, { them: themOf(a.note) });
  const raw = await chat(ai, editNotesMessages({ title: a.note.title, current, request: a.request, transcript: lines }), 1400, a.signal, a.onText);
  const parsed = parseEnhancedNotes(raw, { notes: notesTextOf(a.pages), ...(clipId ? { clipId } : {}), durationMs, headings: current.sections.map((s) => s.heading), transcript: lines });
  if (!parsed.sections.length) throw new Error('The AI didn’t return the notes. Try asking differently.');
  const v = versionFromParsed(parsed, { by: ai.label, template: current.template, clipIds: current.clipIds, reason: 'ask', request: a.request.trim() });
  await addMeetingNotes(a.vault, a.note.id, v);
  return v;
}

/** A hand edit: the version shown with changes, saved as a new version. */
export async function saveHandEdit(vault: AppVault, noteId: string, base: MeetingNotesVersion, sections: MeetingNotesVersion['sections'], tldr?: string): Promise<MeetingNotesVersion> {
  const v: MeetingNotesVersion = { ...base, id: crypto.randomUUID().replace(/-/g, '').slice(0, 26), at: Date.now(), by: 'you', reason: 'edit', sections, ...(tldr !== undefined ? { tldr } : {}) };
  if (tldr === '') delete v.tldr;
  delete v.request;
  await addMeetingNotes(vault, noteId, v);
  return v;
}

/** What a recipe or brief gets from one meeting: its enhanced notes (or your notes), and transcript. */
export async function meetingForRecipe(vault: AppVault, note: NoteMeta, opts: { transcript: boolean }): Promise<RecipeMeeting> {
  const file = await readMeetingNotes(vault, note.id);
  const cur = currentMeetingNotes(file);
  let notes = cur ? notesToLines(cur) : '';
  if (!notes) {
    const pages = await vault.vault.readPages(note).catch(() => [] as PageInk[]);
    notes = notesTextOf(pages);
  }
  const recs = opts.transcript ? await loadNoteTranscripts(vault, note) : [];
  return {
    title: note.title,
    at: note.meeting?.event?.start ?? note.createdAt,
    ...(note.meeting?.attendees ? { attendees: note.meeting.attendees } : {}),
    notes: notes || note.summary || '',
    ...(recs.length ? { transcript: transcriptLines(recs, { them: themOf(note) }).lines } : {}),
  };
}

/** Runs a recipe on one or more meeting notes; streams the answer. */
export async function runRecipe(a: { vault: AppVault; recipe: Recipe; notes: NoteMeta[]; signal?: AbortSignal; onText?: (t: string) => void }): Promise<{ text: string; meetings: NoteMeta[]; by: string }> {
  if (!a.notes.length) throw new Error('No meetings to run this on.');
  const notes = a.notes.slice(0, 40);
  const ai = await getActiveAI({ task: 'heavy', source: 'meetings', label: `Recipe: ${a.recipe.name}`, notes });
  if (!ai) throw new NoMeetingAIError();
  const single = notes.length === 1;
  const meetings = await Promise.all(notes.map((n) => meetingForRecipe(a.vault, n, { transcript: single || notes.length <= 3 })));
  const budget = ai.contextTokens ? Math.max(3000, Math.min(30000, (ai.contextTokens - 1500) * 3)) : 16000;
  // Coaching gets the numbers (talk share, pace, questions, fillers) from the transcript.
  let extra = '';
  if (single && a.recipe.id === 'coach-me') {
    const recs = await loadNoteTranscripts(a.vault, notes[0]!);
    const segs = recs.flatMap((r) => r.file.segments);
    if (segs.some((x) => x.speaker)) extra = `Measured from the recording:\n${statsText(meetingStats(segs), (sp) => speakerName(recs[0]?.file, sp, { them: themOf(notes[0]!) }) ?? sp)}`;
  }
  const text = await chat(ai, recipeMessages(a.recipe, meetings, { maxChars: budget, ...(extra ? { extra } : {}) }), 1500, a.signal, a.onText);
  return { text: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), meetings: notes, by: ai.label };
}

/** A brief before a meeting from earlier meetings with the same people. */
export async function writeBrief(a: { vault: AppVault; title: string; at: number; attendees: MeetingAttendee[]; notes: readonly NoteMeta[]; signal?: AbortSignal; onText?: (t: string) => void }): Promise<{ text: string; meetings: NoteMeta[]; by: string } | null> {
  const ids = relatedMeetings({ title: a.title, attendees: a.attendees, before: a.at }, a.notes, 5);
  const past = ids.map((id) => a.notes.find((n) => n.id === id)!).filter(Boolean);
  if (!past.length) return null;
  const ai = await getActiveAI({ task: 'heavy', source: 'meetings', label: 'Meeting brief', notes: past });
  if (!ai) throw new NoMeetingAIError();
  const meetings = await Promise.all(past.map((n) => meetingForRecipe(a.vault, n, { transcript: false })));
  const text = await chat(ai, briefMessages({ title: a.title, at: a.at, attendees: a.attendees, past: meetings }), 700, a.signal, a.onText);
  return { text: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), meetings: past, by: ai.label };
}
