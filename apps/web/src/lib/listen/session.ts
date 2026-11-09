/**
 * "Notes that listen": the live transcript of the recording in progress, what happens when it
 * ends (save the transcript next to the clip, index it, summarize pages, hand it to routines), and
 * the jumps between speech and ink — a sentence (or an `[m:ss]` citation) highlights the ink
 * written while it was said and plays it; a tap on ink finds the sentence.
 *
 * One recording at a time (the editor owns the microphone), so the state is a single store.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { linkStampCitations, liveTranscriptContext } from '@inkwright/ai';
import {
  assignSides,
  clipAtTime,
  formatStamp,
  inkForSegment,
  newId,
  pageText,
  segmentAtTime,
  sortSegments,
  transcriptText,
  type AudioClip,
  type NoteDocument,
  type NoteMeta,
  type SpeechWhere,
  type TranscriptFile,
  type SideEnergy,
  type TranscriptSegment,
} from '@inkwright/core';
import type { InkEngine } from '../../canvas/engine.ts';
import { useApp } from '../../state/app.ts';
import { appMemory } from '../memory.ts';
import type { AppVault } from '../vault.ts';
import { resolveSpeech, speechLanguage, startLiveTranscription, useSpeechPrefs, type LiveTranscription, type ResolvedSpeech } from './engines.ts';
import { addPageNote, summarizeLecture, summarizePages } from './summaries.ts';
import { loadNoteTranscripts, onListenFilesChanged, writeTranscript } from './transcripts.ts';

export interface ListenState {
  /** The note and recording being transcribed live (null when not recording). */
  noteId: string | null;
  clipId: string | null;
  startedAt: number;
  segments: TranscriptSegment[];
  partial: string;
  working: boolean;
  status: 'idle' | 'listening' | 'finishing';
  where: SpeechWhere | null;
  label: string;
  error: string | null;
  /** Set when nothing private is ready: the panel offers the download. */
  offer: ResolvedSpeech | null;
  /** Summaries being written after a recording ended. */
  summarizing: boolean;
  /** A moment to show: set by citations, transcript taps and ink taps. */
  focus: { noteId: string; clipId: string; ms: number; seq: number; from: 'transcript' | 'link' | 'ink' } | null;
  /** Bumped when a transcript file of a note changes (panels re-read). */
  version: number;
  /** Moments marked during this recording (saved with its transcript). */
  marks: Array<{ id: string; ms: number; label?: string }>;
}

const initial: ListenState = { noteId: null, clipId: null, startedAt: 0, segments: [], partial: '', working: false, status: 'idle', where: null, label: '', error: null, offer: null, summarizing: false, focus: null, version: 0, marks: [] };

export const useListen = create<ListenState>(() => initial);
// Any transcript or summary written (here, by a re-transcription or a summary) refreshes panels.
onListenFilesChanged(() => useListen.setState((s) => ({ version: s.version + 1 })));

let engine: LiveTranscription | null = null;
/** The last finished live transcript, so citations made during it stay linked afterwards. */
let lastLive: { noteId: string; clipId: string; segments: TranscriptSegment[] } | null = null;
const settled = new Map<string, Promise<void>>();
let seq = 0;

/** Starts the live transcript of a recording that just started. Never throws: problems show in the panel. */
export async function startListening(a: { noteId: string; clipId: string; startedAt: number; stream: MediaStream }): Promise<void> {
  engine?.cancel();
  engine = null;
  const prefs = useSpeechPrefs.getState();
  useListen.setState({ ...initial, focus: useListen.getState().focus, version: useListen.getState().version, noteId: a.noteId, clipId: a.clipId, startedAt: a.startedAt, status: 'listening' });
  if (prefs.engine === 'off') {
    useListen.setState({ label: 'Speech to text is off', status: 'idle' });
    return;
  }
  const r = await resolveSpeech();
  if (r.choice.kind === 'offer-download' || r.choice.kind === 'none' || r.choice.kind === 'off') {
    useListen.setState({ status: 'idle', offer: r.choice.kind === 'offer-download' ? r : null, label: r.label, error: r.choice.kind === 'none' ? r.label : null });
    return;
  }
  if (useListen.getState().clipId !== a.clipId) return; // stopped while resolving
  try {
    const live = await startLiveTranscription(a.stream, a.startedAt, r, {
      onSegments: (segs) => useListen.setState((s) => (s.clipId === a.clipId ? { segments: sortSegments([...s.segments, ...segs]), error: null } : s)),
      onPartial: (partial) => useListen.setState((s) => (s.clipId === a.clipId ? { partial } : s)),
      onWorking: (working) => useListen.setState((s) => (s.clipId === a.clipId ? { working } : s)),
      onError: (error) => useListen.setState((s) => (s.clipId === a.clipId ? { error } : s)),
    });
    engine = live;
    useListen.setState({ where: live.where, label: live.label });
  } catch (e) {
    useListen.setState({ status: 'idle', error: (e as Error).message, label: r.label });
  }
}

/**
 * The recording ended and its clip is saved: finish transcribing what was heard, store the
 * transcript next to the clip, index it, then (if enabled) summarize the pages and the recording.
 * Routines with "when a recording ends" wait for this (`whenListenSettled`).
 */
export function finishListening(a: { vault: AppVault; doc: NoteDocument; clip: AudioClip; /** Both sides' loudness, for a recorded call (who spoke). */ energy?: SideEnergy[] }): Promise<void> {
  const job = (async () => {
    const st = useListen.getState();
    if (st.clipId !== a.clip.id) return;
    useListen.setState({ status: 'finishing' });
    const live = engine;
    engine = null;
    try {
      await live?.stop();
    } catch (e) {
      useListen.setState({ error: (e as Error).message });
    }
    const s = useListen.getState();
    const segments = s.segments.filter((x) => x.text.trim());
    useListen.setState({ status: 'idle', partial: '', working: false });
    if (!live || !segments.length) {
      useListen.setState({ noteId: null, clipId: null, segments: [] });
      return;
    }
    const file: TranscriptFile = {
      formatVersion: 1, clipId: a.clip.id, run: newId(), engine: live.engineId, where: live.where, language: speechLanguage(),
      ...(s.marks.length ? { marks: s.marks } : {}),
      complete: true, updatedAt: Date.now(), segments: assignSides(segments.map((x) => ({ ...x, endMs: Math.min(x.endMs, a.clip.durationMs) })), a.energy ?? []),
    };
    await writeTranscript(a.vault, a.doc.meta.id, file);
    lastLive = { noteId: a.doc.meta.id, clipId: a.clip.id, segments: file.segments };
    useListen.setState({ noteId: null, clipId: null, segments: [] });
    await reindexTranscripts(a.vault, a.doc.meta.id, a.doc.meta);
    if (useSpeechPrefs.getState().autoSummary) await summarizeAfterRecording(a.vault, a.doc, a.clip.id).catch((e) => useListen.setState({ error: (e as Error).message }));
  })();
  const all = (settled.get(a.doc.meta.id) ?? Promise.resolve()).then(() => job).catch(() => {});
  settled.set(a.doc.meta.id, all);
  void all.then(() => { if (settled.get(a.doc.meta.id) === all) settled.delete(a.doc.meta.id); });
  return job;
}

/** Summaries of the pages a recording covers, and of the recording itself. */
export async function summarizeAfterRecording(vault: AppVault, doc: NoteDocument, clipId: string): Promise<void> {
  useListen.setState({ summarizing: true });
  try {
    const pages = [...doc.pages];
    const pageNotes = useSpeechPrefs.getState().pageNotes;
    await summarizePages(vault, doc.meta, pages, { clipIds: [clipId], onPage: (i, s) => { if (pageNotes) addPageNote(doc, i, s.text); } });
    await summarizeLecture(vault, doc.meta, pages, clipId);
  } finally {
    useListen.setState({ summarizing: false });
  }
}

/** Resolves when transcripts and summaries of the note's latest recording are saved (or after `timeoutMs`). */
export function whenListenSettled(noteId: string, timeoutMs = 5 * 60_000): Promise<void> {
  const p = settled.get(noteId);
  if (!p) return Promise.resolve();
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

/** Marks this moment of the recording in progress as important; returns its time, or null when not recording. */
export function markMoment(label?: string): number | null {
  const s = useListen.getState();
  if (!s.clipId || s.status === 'idle') return null;
  const ms = Math.max(0, Date.now() - s.startedAt - 1500); // what was just said, not the tap
  useListen.setState({ marks: [...s.marks, { id: newId(), ms, ...(label ? { label } : {}) }] });
  return ms;
}

/** Stops without saving (the editor closed mid-recording). */
export function cancelListening(): void {
  engine?.cancel();
  engine = null;
  useListen.setState({ ...initial, version: useListen.getState().version });
}

/** Tells the memory index about a note's transcripts (after a write). */
export async function reindexTranscripts(vault: AppVault, noteId: string, meta?: Pick<NoteMeta, 'id' | 'recordings'>): Promise<void> {
  useListen.setState((s) => ({ version: s.version + 1 }));
  const m = appMemory();
  // The open note's meta may be ahead of the saved file (a recording just added).
  const note = meta ?? (await vault.vault.readNote(noteId));
  if (!m || !note) return;
  m.setTranscripts(noteId, await loadNoteTranscripts(vault, note));
}

// ---- Asking during a recording ------------------------------------------------------------------

/** Assistant context while the open note is being recorded ('' otherwise). */
export function liveAskContext(noteId: string, pageIndex: number, page: Parameters<typeof pageText>[0] | undefined): string {
  const s = useListen.getState();
  if (s.noteId !== noteId || (s.status === 'idle' && !s.segments.length)) return '';
  return liveTranscriptContext({ elapsedMs: Date.now() - s.startedAt, segments: s.segments, pageNumber: pageIndex + 1, pageText: page ? pageText(page) : '' });
}

/** `#said/<note>/<clip>/<ms>`: a moment in a recording (tapping it shows the ink and plays it). */
export const saidHref = (noteId: string, clipId: string, ms: number) => `#said/${encodeURIComponent(noteId)}/${encodeURIComponent(clipId)}/${Math.round(ms)}`;

export function parseSaidHref(href: string): { noteId: string; clipId: string; ms: number } | null {
  const m = /#said\/([^/]+)\/([^/]+)\/(\d+)$/.exec(href);
  return m ? { noteId: decodeURIComponent(m[1]!), clipId: decodeURIComponent(m[2]!), ms: Number(m[3]) } : null;
}

/**
 * Turns `[m:ss]` citations in an assistant reply into links to that moment of the live recording
 * (or of the note's latest transcript). Times that match nothing stay plain text.
 */
export function linkLiveCitations(text: string, noteId: string, transcripts?: { clipId: string; segments: TranscriptSegment[] } | null): string {
  if (!/\[(?:\d+:)?\d{1,2}:\d{2}\]/.test(text)) return text;
  const s = useListen.getState();
  const src = s.noteId === noteId && s.clipId ? { clipId: s.clipId, segments: s.segments } : transcripts ?? (lastLive?.noteId === noteId ? lastLive : null);
  if (!src?.segments.length) return text;
  return linkStampCitations(text, src.segments, (seg) => saidHref(noteId, src.clipId, seg.startMs));
}

/** Shows a moment: opens the note if needed; the editor highlights the ink and plays the audio. */
export function focusSaid(noteId: string, clipId: string, ms: number, from: 'transcript' | 'link' | 'ink' = 'link'): void {
  useListen.setState({ focus: { noteId, clipId, ms, seq: ++seq, from } });
  const app = useApp.getState();
  if (app.route.name !== 'editor' || (app.route as { noteId?: string }).noteId !== noteId) app.navigate({ name: 'editor', noteId });
}

let linksInstalled = false;

/** Handles clicks on `#said/…` links anywhere in the app (assistant replies, transcripts). */
export function installSaidLinks(): void {
  if (linksInstalled || typeof document === 'undefined') return;
  linksInstalled = true;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="#said/"]');
    if (!a) return;
    const p = parseSaidHref(a.getAttribute('href') ?? '');
    if (!p) return;
    e.preventDefault();
    focusSaid(p.noteId, p.clipId, p.ms, 'link');
  });
}

// ---- Editor wiring ------------------------------------------------------------------------------------

/**
 * Editor hook: applies `focus` to the open note — highlights the ink written while that sentence
 * was said and plays the recording from there (a recording still in progress can't play yet).
 */
export function useListenFocus(a: { engine: InkEngine | null; doc: NoteDocument | null; vault: AppVault | null; onSeek: (clipId: string, ms: number) => void; openTranscript: () => void }): void {
  const focus = useListen((s) => s.focus);
  useEffect(() => {
    const { engine: eng, doc, vault } = a;
    if (!focus || !eng || !doc || !vault || focus.noteId !== doc.meta.id || focus.from === 'ink') return;
    let alive = true;
    void (async () => {
      const s = useListen.getState();
      const live = s.clipId === focus.clipId;
      const clip = live ? { id: focus.clipId, startedAt: s.startedAt, durationMs: Date.now() - s.startedAt } : doc.meta.recordings?.find((c) => c.id === focus.clipId);
      if (!clip) return;
      const segments = live ? s.segments : (await loadNoteTranscripts(vault, doc.meta)).find((r) => r.clip.id === focus.clipId)?.file.segments ?? [];
      if (!alive) return;
      const seg = segments.find((x) => focus.ms >= x.startMs && focus.ms <= x.endMs) ?? segments.find((x) => Math.abs(x.startMs - focus.ms) < 1500) ?? { startMs: focus.ms, endMs: focus.ms + 4000 };
      if (focus.from === 'link') a.openTranscript();
      const ink = inkForSegment(doc.pages, clip, seg);
      const best = [...ink].sort((x, y) => y.strokeIds.length - x.strokeIds.length)[0];
      if (best?.strokeIds.length) eng.focusStrokes(best.pageIndex, best.strokeIds);
      else if (best) eng.flashRegion(best.pageIndex, best.bounds);
      if (!live) a.onSeek(focus.clipId, seg.startMs);
    })();
    return () => { alive = false; };
  }, [focus?.seq, a.engine, a.doc]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A tap on ink (transcript open): find the sentence being said when it was written. */
export function focusInkMoment(noteId: string, clips: readonly AudioClip[], createdAt: number): boolean {
  const s = useListen.getState();
  if (s.noteId === noteId && s.clipId && createdAt >= s.startedAt) {
    const seg = segmentAtTime(s.segments, { startedAt: s.startedAt, durationMs: Date.now() - s.startedAt }, createdAt);
    useListen.setState({ focus: { noteId, clipId: s.clipId, ms: seg ? seg.startMs : createdAt - s.startedAt, seq: ++seq, from: 'ink' } });
    return true;
  }
  const clip = clipAtTime(clips, createdAt);
  if (!clip) return false;
  useListen.setState({ focus: { noteId, clipId: clip.id, ms: Math.max(0, createdAt - clip.startedAt), seq: ++seq, from: 'ink' } });
  return true;
}

// ---- Routines ------------------------------------------------------------------------------------------

/**
 * What a "when a recording ends" routine gets to work with: the latest recording's summary, key
 * terms, to-dos and transcript (with times), so a routine like "email me the lecture's to-dos"
 * needs no tool calls to find them.
 */
export async function recordingRoutineContext(vault: AppVault, noteId: string, maxChars = 8000): Promise<string> {
  const note = await vault.vault.readNote(noteId);
  if (!note?.recordings?.length) return '';
  const latest = (await loadNoteTranscripts(vault, note)).at(-1);
  if (!latest) return 'The recording has no transcript (speech to text was off or unavailable).';
  const { clip, file } = latest;
  const lines = [`The recording that ended: ${clip.title ?? 'Recording'}, ${formatStamp(clip.durationMs)} long, transcribed ${file.where === 'device' ? 'on this device' : file.where === 'browser' ? 'by the browser' : 'by the AI provider'}.`];
  if (file.lecture) {
    lines.push(`Summary: ${file.lecture.summary}`);
    if (file.lecture.keyTerms.length) lines.push(`Key terms: ${file.lecture.keyTerms.join(', ')}`);
    if (file.lecture.todos.length) lines.push(`To-dos mentioned:\n${file.lecture.todos.map((t) => `- ${t}`).join('\n')}`);
  }
  const transcript = transcriptText(file.segments);
  lines.push(`Transcript${transcript.length > maxChars ? ' (beginning)' : ''}, times from the start of the recording:\n${transcript.slice(0, maxChars)}`);
  return lines.join('\n');
}
