/**
 * The journal's two assistant tools, used by the evening routine (template `daily-journal`):
 *
 *   journal_sources(date?)            the day's sources with citation ids, and the writing style
 *   write_journal_draft(date, paragraphs[{text, sources}])
 *                                     checks every citation, drops what isn't backed, writes the
 *                                     draft (AI ink or typed text, origin 'ai') with its sources list
 *
 * The model composes; these tools decide what it may say (only what the day's sources back) and
 * how it lands in the vault. The host (the app) supplies `gather` and `write`, so the same tools
 * run against an in-memory vault in tests and evals.
 */
import { parseDayKey } from '@inkwright/core';
import type { AgentTool } from '../agent.ts';
import { checkJournalDraft, composeJournal, journalInstructions, type ComposedJournal, type DraftCheck } from './draft.ts';
import { sourcesForModel, type JournalSource } from './sources.ts';

export type JournalStyle = 'ink' | 'typed';

export interface JournalGathered {
  sources: JournalSource[];
  style: JournalStyle;
  /** What was looked at, for the reply ("3 notes, 2 events, the memory timeline"). */
  looked: string[];
}

export interface JournalWritten {
  noteId: string;
  title: string;
  /** 1-based page the draft starts on. */
  page: number;
}

export interface JournalToolDeps {
  /** Local day key (`YYYY-MM-DD`) of "today". */
  today(): string;
  gather(day: string): Promise<JournalGathered>;
  write(day: string, draft: ComposedJournal, check: DraftCheck, style: JournalStyle): Promise<JournalWritten>;
}

export const JOURNAL_TOOL_NAMES = ['journal_sources', 'write_journal_draft'] as const;

function dayArg(v: unknown, deps: JournalToolDeps): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s === 'today') return deps.today();
  if (!parseDayKey(s)) throw new Error(`"${s}" is not a date like 2026-11-02`);
  return s;
}

export function createJournalTools(deps: JournalToolDeps): AgentTool[] {
  const gathered = new Map<string, JournalGathered>();
  const gather = async (day: string) => {
    let g = gathered.get(day);
    if (!g) gathered.set(day, (g = await deps.gather(day)));
    return g;
  };
  const sourcesTool: AgentTool<{ date?: string }> = {
    name: 'journal_sources',
    description: 'The day\'s sources for the journal entry: the notes written that day (only what was written that day), what was said in recordings, calendar events the user imported and, if the memory timeline is on, what was on screen. Each source has an id to cite. `date` is YYYY-MM-DD (default today).',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD; default today' } } },
    readOnly: true,
    async execute(a) {
      const day = dayArg(a.date, deps);
      const g = await gather(day);
      return { date: day, style: g.style, looked: g.looked, sources: sourcesForModel(g.sources), instructions: journalInstructions(g.style), ...(g.sources.length ? {} : { note: 'Nothing was written, recorded or scheduled that day. Do not write a draft; say so.' }) };
    },
  };
  const writeTool: AgentTool<{ date?: string; paragraphs?: unknown }> = {
    name: 'write_journal_draft',
    description: 'Writes the journal draft for the day as AI writing the user then corrects with the pen. Each paragraph cites the source ids it rests on; paragraphs without a valid citation are dropped. Call journal_sources first.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD; default today' },
        paragraphs: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } }, required: ['text', 'sources'] },
        },
      },
      required: ['paragraphs'],
    },
    async execute(a) {
      const day = dayArg(a.date, deps);
      const g = gathered.get(day);
      if (!g) throw new Error('Call journal_sources for this date first.');
      const check = checkJournalDraft(a.paragraphs, g.sources);
      if (!check.kept.length) {
        return { written: false, dropped: check.dropped, reason: 'No paragraph cited a source from journal_sources, so nothing was written. Cite source ids like "s1".' };
      }
      const draft = composeJournal(check.kept);
      const at = await deps.write(day, draft, check, g.style);
      return { written: true, noteId: at.noteId, title: at.title, page: at.page, style: g.style, paragraphs: check.kept.length, sources: draft.cited.length, dropped: check.dropped };
    },
  };
  return [sourcesTool, writeTool];
}
