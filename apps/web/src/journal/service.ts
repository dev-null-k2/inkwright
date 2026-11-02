/**
 * The journal that writes itself, in the app: gathers a day's sources from the vault, writes the
 * checked draft as a note, and provides the two assistant tools the evening routine uses
 * (packages/ai journal/tools.ts).
 *
 * Where the draft goes: the day's daily note when there is none yet (the draft *is* the daily
 * note, so Today opens it), otherwise its own note "<day> · journal" in the Journal notebook. It
 * is AI writing (origin 'ai': AI ink or typed text) committed through `NoteDocument`, so
 * authorship never counts it as the user's, and the user corrects it with the pen like any page.
 * It ends with a typed "Sources" list linking every source; typed drafts also get provenance, so
 * Explain shows each sentence's sources. The creation is recorded in AI activity, where it can be
 * undone.
 */
import {
  NoteDocument,
  addGen,
  candidateNotes,
  dayBounds,
  dayKey,
  decodeTranscript,
  expandEvents,
  textBoxHeight,
  findDailyNote,
  newId,
  parseICalendar,
  setItem,
  textItemKey,
  transcriptAssetName,
  type NoteMeta,
  type TextBox,
} from '@inkwright/core';
import {
  JOURNAL_PROMPT_ID,
  RunRecorder,
  captureSources,
  collectJournalSources,
  createJournalTools,
  eventSources,
  noteSourcesForDay,
  speechSourcesForDay,
  type AgentTool,
  type ComposedJournal,
  type JournalGathered,
  type JournalStyle,
  type JournalWritten,
  type SourceDraft,
} from '@inkwright/ai';
import { useApp } from '../state/app.ts';
import { activeSession } from '../lib/session.ts';
import { requireHub } from '../lib/agent/hub.ts';
import { aiMaySend } from '../lib/trust/state.ts';
import { isModuleOn } from '../modules/registry.ts';
import type { AppVault } from '../lib/vault.ts';
import { calendarPath, loadJournalConfig, refreshCalendars } from './config.ts';

const dec = new TextDecoder();
const JOURNAL_TAG = 'journal';

function requireVault(): AppVault {
  const v = useApp.getState().vault;
  if (!v) throw new Error('The vault is not open');
  return v;
}

/** Notes that are earlier journal drafts are not sources for the next one. */
const isJournalDraft = (n: Pick<NoteMeta, 'tags'>) => n.tags.includes(JOURNAL_TAG);

/** Everything the day held, as citable sources. */
export async function gatherDay(vault: AppVault, day: string): Promise<JournalGathered> {
  const b = dayBounds(day);
  if (!b) throw new Error(`Not a day: ${day}`);
  const cfg = await loadJournalConfig(vault);
  const parts: SourceDraft[] = [];
  const looked: string[] = [];

  // Notes written that day. Local-only and hidden notebooks stay out: the draft is written by
  // whichever AI the routine uses, which may be a cloud model (docs/TRUST.md).
  const notes = candidateNotes(useApp.getState().notes, b.from, b.to).filter((n) => !n.lock && !isJournalDraft(n) && aiMaySend(n.id));
  let noteCount = 0;
  let recordingCount = 0;
  for (const meta of notes) {
    const pages = await vault.vault.readPages(meta).catch(() => []);
    const found = noteSourcesForDay(meta, pages, b.from, b.to);
    if (found.length) noteCount++;
    parts.push(...found);
    for (const clip of meta.recordings ?? []) {
      const bytes = await vault.vault.readAsset(meta.id, transcriptAssetName(clip.id)).catch(() => null);
      if (!bytes) continue;
      try {
        const said = speechSourcesForDay(meta, [decodeTranscript(dec.decode(bytes))], b.from, b.to);
        if (said.length) recordingCount++;
        parts.push(...said);
      } catch { /* an unreadable transcript is skipped */ }
    }
  }
  if (noteCount) looked.push(`${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`);
  if (recordingCount) looked.push(`${recordingCount} ${recordingCount === 1 ? 'recording' : 'recordings'}`);

  // Calendars the user imported (subscriptions refreshed first, when this device has the address).
  if (cfg.calendars.length) {
    await refreshCalendars(vault).catch(() => null);
    let events = 0;
    for (const c of cfg.calendars) {
      const text = await vault.fs.readText(calendarPath(c.id)).catch(() => null);
      if (!text) continue;
      const occ = expandEvents(parseICalendar(text), b.from, b.to);
      events += occ.length;
      parts.push(...eventSources(occ));
    }
    if (events) looked.push(`${events} calendar ${events === 1 ? 'event' : 'events'}`);
  }

  // The memory timeline, when it is on and the journal may use it.
  if (cfg.includeTimeline && isModuleOn('memory-timeline')) {
    const { recallStore } = await import('../recall/state.ts');
    const caps = await recallStore(vault).readRange(b.from, b.to);
    if (caps.length) looked.push('the memory timeline');
    parts.push(...captureSources(caps));
  }
  return { sources: collectJournalSources(parts), style: cfg.style, looked };
}

const titleFor = (day: string) => `${day} · journal`;

/** True when nobody but AI has written on the note (it can be replaced by a new draft). */
function untouched(doc: NoteDocument): boolean {
  for (let i = 0; i < doc.pageCount; i++) {
    const p = doc.page(i);
    if (p.strokes.some((s) => s.origin !== 'ai') || (p.texts ?? []).some((t) => t.origin !== 'ai') || (p.images ?? []).length) return false;
  }
  return true;
}

const HEADER = 'Journal draft, written by AI from your day. Correct it with your pen.';

/** Writes a checked draft for `day` and returns where it is. */
export async function writeDraft(vault: AppVault, day: string, draft: ComposedJournal, style: JournalStyle, opts: { animate?: boolean } = {}): Promise<JournalWritten> {
  const cfg = await loadJournalConfig(vault);
  const app = useApp.getState();
  const recorder = new RunRecorder(activityLog(), { source: 'routine', label: 'Journal that writes itself', prompt: `Draft for ${day}` });
  const daily = findDailyNote(app.notes, day);
  const previous = app.notes.find((n) => n.trashedAt == null && isJournalDraft(n) && (n.title === titleFor(day) || (n.daily === day && n.id === daily?.id)));

  // A draft nobody has corrected yet is replaced; one with the user's writing is kept.
  if (previous) {
    const pages = await vault.vault.readPages(previous);
    if (untouched(new NoteDocument(previous, pages))) {
      await vault.vault.trashNote(previous.id);
      vault.search.remove(previous.id);
      recorder.record({ kind: 'note_trashed', tool: 'write_journal_draft', noteId: previous.id, title: previous.title, summary: `Replaced the earlier draft “${previous.title}”` });
    }
  }
  const stillDaily = findDailyNote((await vault.listNotes()).filter((n) => n.trashedAt == null), day);
  const { ensureJournal } = await import('../lib/knowledge.ts');
  const { useKnowledge } = await import('../state/knowledge.ts');
  const prefs = useKnowledge.getState();
  const notebookId = await ensureJournal();
  const asDaily = !stillDaily;
  const title = asDaily ? day : titleFor(day);
  const { note } = await vault.vault.createNote({ title, paper: prefs.journalPaper, pageSize: prefs.journalPageSize, notebookId, tags: [JOURNAL_TAG] });
  const meta = (await vault.vault.updateNote(note.id, (n) => ({ ...n, ...(asDaily ? { daily: day } : {}) }), { touch: false })) ?? note;
  const doc = new NoteDocument(meta, await vault.vault.readPages(meta));

  const width = (meta.pageSize.width || 794) - 128;
  const box = (y: number, text: string, fontSize = 16): TextBox => ({ id: newId(), x: 64, y, width, text, fontSize, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'ai' });
  doc.upsertText(0, box(40, `${HEADER}${asDaily ? '' : ` Your daily note: [[${day}]].`}`, 12), 'Journal draft');
  // Where the body's provenance is kept: `text:<box id>` or, for ink, `ink:<first stroke id>`
  // (the convention AI answers in ink use, docs/VAULT_FORMAT.md § Ink actions).
  let provKey: string | null = null;
  let bottom: number;
  if (style === 'ink') {
    const { writeInInk } = await import('../inkanswer/write.ts');
    const placed = await writeInInk(doc, 0, draft.body.replace(/\n\n+/g, '\n'), { near: { minX: 64, minY: 70, maxX: 64 + width, maxY: 80 }, style: cfg.hand, animate: opts.animate ?? false, label: 'Journal draft' });
    bottom = placed.rect.maxY;
    if (placed.strokeIds[0]) provKey = `ink:${placed.strokeIds[0]}`;
  } else {
    const b = box(76, draft.body);
    doc.upsertText(0, b, 'Journal draft');
    provKey = textItemKey(b.id);
    bottom = 76 + textBoxHeight(b);
  }
  // The sources go after the body, on the page the body ended on.
  const lastPage = doc.pageCount - 1;
  const footer = box(bottom + 28, draft.footer, 12);
  doc.upsertText(lastPage, footer, 'Journal sources');

  const snap = doc.takeDirty();
  if (snap) {
    await vault.vault.saveNote(snap.meta, [...snap.pages], { changedPageIds: [...snap.changedPageIds] });
    vault.indexNote(snap.meta, [...snap.pages]);
  }
  if (provKey) {
    // Explain: each sentence of the draft with its sources.
    const { readNoteProvenance, writeNoteProvenance } = await import('../compiler/target.ts');
    const file = await readNoteProvenance(vault, meta.id);
    const gen = { by: 'Journal that writes itself', prompt: JOURNAL_PROMPT_ID, at: Date.now() };
    addGen(file, gen);
    await writeNoteProvenance(vault, meta.id, setItem(file, provKey, gen, draft.claims));
  }
  recorder.record({ kind: 'note_created', tool: 'write_journal_draft', noteId: meta.id, title, summary: `Drafted the journal for ${day} (${style === 'ink' ? 'in AI handwriting' : 'typed'}, ${draft.cited.length} ${draft.cited.length === 1 ? 'source' : 'sources'})` });
  await recorder.finish('done', { alwaysLog: true });
  await app.refresh();
  return { noteId: meta.id, title, page: 1 };
}

/** The AI activity log (the assistant hub), or none when the assistant hasn't started. */
function activityLog() {
  try {
    return requireHub().activity;
  } catch {
    return null;
  }
}

/** The tools the evening routine (and the assistant) use. */
export function journalAgentTools(): AgentTool[] {
  return createJournalTools({
    today: () => dayKey(new Date()),
    gather: (day) => gatherDay(requireVault(), day),
    write: (day, draft, _check, style) => writeDraft(requireVault(), day, draft, style, { animate: activeSession() == null ? false : undefined }),
  });
}
