/**
 * The agent session journal: coding-agent transcripts (Claude Code, Codex CLI, Gemini CLI)
 * become readable notes in a "Sessions" notebook; the assistant reads one and *proposes* durable
 * lessons (`propose_lessons`); the user accepts each into the AGENTS.md note or dismisses it.
 * Also the "Incident (RCA)" note template.
 */
import { create } from 'zustand';
import {
  AGENTS_MD_INTRO, LessonStore, TemplateStore, lessonsToAppend, newId, newPage, parseAgentSession, sessionToMarkdown,
  type LessonProposal, type NoteMeta, type NoteTemplate,
} from '@inkstone/core';
import { createLessonTool, runAgent } from '@inkstone/ai';
import { importText, noteChanged } from '../lib/actions.ts';
import { AppNoteToolHost, getActiveAI } from '../lib/ai.ts';
import { activeSession } from '../lib/session.ts';
import { useApp } from '../state/app.ts';

const SESSIONS = 'Sessions';
export const SESSION_TAG = 'agent-session';
export const AGENTS_TITLE = 'AGENTS.md';
const app = () => useApp.getState();

async function sessionsNotebook(): Promise<string> {
  const v = app().vault!;
  const nb = (await v.vault.listNotebooks()).find((n) => n.name === SESSIONS && !n.parentId);
  if (nb) return nb.id;
  const created = await v.vault.createNotebook(SESSIONS, '#FF4A5D6E');
  await app().refresh();
  return created.id;
}

/** Imports transcript files as notes in "Sessions". Returns the new notes (and per-file errors). */
export async function importSessions(files: File[]): Promise<{ ids: string[]; errors: string[] }> {
  const v = app().vault;
  if (!v) throw new Error('Your notes are still opening.');
  const notebookId = await sessionsNotebook();
  const ids: string[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      const s = parseAgentSession(f.name, await f.text());
      const id = await importText(sessionToMarkdown(s), s.title, notebookId);
      await v.vault.updateNote(id, (m) => ({ ...m, tags: [...new Set([...m.tags, SESSION_TAG, s.tool])], createdAt: s.startedAt ?? m.createdAt }));
      await noteChanged(id);
      ids.push(id);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { ids, errors };
}

export const isSessionNote = (m: Pick<NoteMeta, 'tags'>) => m.tags.includes(SESSION_TAG);

// ---- Lessons ----------------------------------------------------------------------------------

export const useLessons = create<{ items: LessonProposal[] }>(() => ({ items: [] }));
const lessonStore = () => new LessonStore(app().vault!.fs, Date.now, () => newId());

export async function loadLessons(): Promise<void> {
  if (!app().vault) return;
  useLessons.setState({ items: await lessonStore().list() });
}

/** Plain text of a note (typed text and recognized handwriting). */
async function noteText(id: string): Promise<{ meta: NoteMeta; text: string }> {
  const v = app().vault!;
  const meta = await v.vault.readNote(id);
  if (!meta) throw new Error('That note no longer exists.');
  const pages = await v.vault.readPages(meta);
  return { meta, text: pages.map((p) => [...(p.texts ?? []).map((t) => t.text), p.recognizedText ?? ''].join('\n')).join('\n\n') };
}

/**
 * Asks the active AI to read a session note and propose lessons. Returns how many new proposals
 * there are; they wait in Settings › Developer › Lessons for the user.
 */
export async function findLessons(noteId: string): Promise<number> {
  const ai = await getActiveAI();
  if (!ai) throw new Error('Set up an AI in Settings › AI first.');
  const { meta, text } = await noteText(noteId);
  const agentsNote = app().notes.find((n) => n.title === AGENTS_TITLE);
  const agents = agentsNote ? (await noteText(agentsNote.id)).text : '';
  let proposed = 0;
  const tool = createLessonTool({
    codeGraphs: async () => [],
    proposeLessons: async (lessons, from) => {
      const added = await lessonStore().propose(lessons, { noteId: from?.noteId, noteTitle: meta.title });
      proposed += added.length;
      await loadLessons();
      return added.length;
    },
  }, { noteId });
  await runAgent({
    provider: ai.provider,
    model: ai.model,
    system: 'You read a coding agent\'s session and propose durable lessons for the user\'s AGENTS.md: specific, reusable rules that would have saved time or prevented a mistake (commands, conventions, pitfalls of this codebase). Not a summary; at most 5; skip anything already in AGENTS.md. Call propose_lessons once, then reply with one short sentence.',
    // The note is already the readable digest of the session (sessionToMarkdown); keep it in budget.
    messages: [{ role: 'user', content: `Session note “${meta.title}”:\n\n${clipMiddle(text, 24_000)}\n\nCurrent AGENTS.md:\n${agents.slice(0, 4000) || '(empty)'}` }],
    tools: [tool],
    maxSteps: 3,
  });
  return proposed;
}

const clipMiddle = (t: string, n: number) => (t.length > n ? `${t.slice(0, n / 2)}\n…\n${t.slice(-n / 2)}` : t);

/** Accepts a lesson: appends it to the AGENTS.md note (created on first use). */
export async function acceptLesson(id: string): Promise<void> {
  const v = app().vault!;
  const p = await lessonStore().decide(id, true);
  await loadLessons();
  if (!p) return;
  let agents = app().notes.find((n) => n.title === AGENTS_TITLE);
  if (!agents) {
    const nid = await importText(AGENTS_MD_INTRO, AGENTS_TITLE, await sessionsNotebook());
    agents = (await v.vault.readNote(nid)) ?? undefined;
  }
  if (!agents) return;
  const { text } = await noteText(agents.id);
  const md = lessonsToAppend(text, [p.text], new Date());
  if (!md) return;
  // The same append the assistant's append_to_note uses (below what is on the page, into an open note live).
  await new AppNoteToolHost(v, activeSession()?.doc ?? null).appendText(agents.id, md);
  await noteChanged(agents.id);
}

export async function dismissLesson(id: string): Promise<void> {
  await lessonStore().decide(id, false);
  await loadLessons();
}

// ---- Incident template ------------------------------------------------------------------------

export const INCIDENT_TEMPLATE_ID = 'incident-rca';

const INCIDENT_TEXT = `# Incident: {{title}}
Opened {{date:YYYY-MM-DD HH:mm}} · severity: SEV-? · status: investigating

## Impact
- Who is affected, since when, how badly:

## Timeline
- {{time}} — detected:

## Checks
\`\`\`http health
GET https://example.com/health
\`\`\`

## Root cause
-

## Actions
- [ ] Mitigate:
- [ ] Follow-up:
`;

/** The "Incident (RCA)" note template, written into the vault's templates (once) so New note offers it. */
export async function ensureIncidentTemplate(): Promise<NoteTemplate> {
  const v = app().vault!;
  const store = new TemplateStore(v.fs);
  const existing = (await store.list()).find((t) => t.id === INCIDENT_TEMPLATE_ID);
  if (existing) return existing;
  const now = Date.now();
  const page = { ...newPage('p1'), texts: [{ id: 't1', x: 96, y: 96, width: 600, text: INCIDENT_TEXT, fontSize: 16, color: '#FF1B1F24', font: 'sans' as const, createdAt: now }] };
  const t: NoteTemplate = { id: INCIDENT_TEMPLATE_ID, name: 'Incident (RCA)', kind: 'paged', paper: { style: 'blank', tint: 'white', texture: 'smooth', spacing: 0 }, pageSize: { name: 'A4', width: 793.7, height: 1122.5 }, tags: ['incident'], pages: [page], createdAt: now, updatedAt: now, formatVersion: 2 };
  await store.write(t);
  return t;
}
