import {
  formatStamp,
  newId,
  parseStamp,
  type MeetingAttendee,
  type MeetingItem,
  type MeetingNotesVersion,
  type MeetingSection,
  type MeetingTemplate,
  type Recipe,
} from '@inkwright/core';
import { fitLines, type StampedLine } from '../speech/prompts.ts';
import type { ChatMessage } from '../types.ts';

/**
 * Meetings: notes made better with what was said.
 *
 * The model writes notes in a plain line format small on-device models follow reliably (not JSON):
 *
 *   TLDR: one sentence
 *   ## Section heading
 *   - a point [1:02]
 *     - a detail under it [1:05, 2:10]
 *   - [ ] an action item — Owner [12:30]
 *
 * `parseEnhancedNotes` reads it back. Which lines are the writer's own words is decided here, by
 * comparing with their notes, not taken from the model: their notes are shown in ink colour and
 * must never be lost, so any note line the model dropped is put back.
 */

const render = (lines: readonly StampedLine[]) => lines.map((l) => `[${formatStamp(l.ms)}] ${l.text}`).join('\n');
const strip = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```[a-z]*\n?|```\s*$/gm, '').trim();

export interface EnhanceInput {
  title: string;
  /** When it happened (shown to the model as a date). */
  at?: number;
  attendees?: readonly MeetingAttendee[];
  template: MeetingTemplate;
  /** The writer's own notes, one point per line (typed, and handwriting read from the pages). */
  notes: string;
  transcript: readonly StampedLine[];
  /** Language of the material ("en-US"); the notes are written in it. */
  language?: string;
  /** Moments they marked as important while recording (ms): these must be in the notes. */
  marks?: readonly number[];
  maxChars?: number;
}

const FORMAT = [
  'Format (nothing else):',
  'TLDR: <one sentence: the outcome>',
  '## <section heading>',
  '- <point> [m:ss]',
  '  - <detail of the point above> [m:ss]',
  'Action items: - [ ] <task> — <owner> [m:ss]',
  'Put the time of the transcript line each point came from in square brackets.',
  'Example:',
  '## Decisions',
  '- Launch moves to May [4:12]',
  '  - Waiting on the security review, about three weeks [4:40]',
  '## Action items',
  '- [ ] Send the SOC 2 report — Sam [9:02]',
].join('\n');

export function enhanceMessages(a: EnhanceInput): ChatMessage[] {
  const lines = fitLines(a.transcript, a.maxChars ?? 12000, 'spread');
  const sections = a.template.sections.map((s) => `## ${s.heading} — ${s.guide}${s.actions ? ' (action items: "- [ ] task — owner")' : ''}`).join('\n');
  const system = [
    'You write clear meeting notes from someone’s rough notes and the meeting transcript.',
    'Keep each of their notes as a point, in their own words, and put the important details from the transcript under it. Add anything important they missed.',
    'Be specific: names, numbers, prices, dates, durations, decisions, who does what. Short lines. Only what was said or written; never guess.',
    `Sections, in order (skip a section with nothing in it):\n${sections}`,
    a.template.context ?? '',
    FORMAT,
    `Write in the language of the material${a.language ? ` (${a.language})` : ''}.`,
  ].filter(Boolean).join('\n\n');
  const who = a.attendees?.length ? `Attendees: ${a.attendees.map((p) => p.name).join(', ')}` : '';
  const user = [
    `Meeting: ${a.title || 'Untitled'}${a.at ? ` (${new Date(a.at).toDateString()})` : ''}`,
    who,
    `Their notes${/^\[\d/m.test(a.notes) ? ' (with the time each was written; the details are in the transcript around then; "[ ]" marks an action item)' : ''}:\n${a.notes.trim() || '(none — write the notes from the transcript)'}`,
    a.marks?.length ? `They marked these moments as important; make sure what was said then is in the notes: ${a.marks.map((m) => `[${formatStamp(m)}]`).join(', ')}` : '',
    `Transcript, with times from the start of the recording:\n${render(lines) || '(nothing was recorded)'}`,
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** The notes back in the line format (for "edit by asking" and as context for recipes). */
export function notesToLines(v: Pick<MeetingNotesVersion, 'tldr' | 'sections'>, opts: { stamps?: boolean } = {}): string {
  const out: string[] = [];
  if (v.tldr) out.push(`TLDR: ${v.tldr}`);
  for (const s of v.sections) {
    out.push(`## ${s.heading}`);
    const actions = isActionsHeading(s.heading);
    for (const it of s.items) {
      const st = opts.stamps !== false && it.cites?.length ? ` [${it.cites.map(formatStamp).join(', ')}]` : '';
      out.push(`${it.depth ? '  ' : ''}- ${actions ? (it.done ? '[x] ' : '[ ] ') : ''}${it.text}${it.owner ? ` — ${it.owner}` : ''}${st}`);
    }
  }
  return out.join('\n');
}

export function editNotesMessages(a: { title: string; current: Pick<MeetingNotesVersion, 'tldr' | 'sections'>; request: string; transcript: readonly StampedLine[]; maxChars?: number }): ChatMessage[] {
  const lines = fitLines(a.transcript, a.maxChars ?? 8000, 'spread');
  const system = [
    'You edit meeting notes as asked. Change only what the request asks for; keep everything else, including the times in brackets. Use the transcript when the request needs more detail.',
    FORMAT,
  ].join('\n\n');
  const user = [
    `Meeting: ${a.title || 'Untitled'}`,
    `The notes now:\n${notesToLines(a.current)}`,
    `The request: ${a.request.trim()}`,
    lines.length ? `Transcript:\n${render(lines)}` : '',
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function isActionsHeading(h: string): boolean {
  return /action|next step|to.?do|follow.?up|tasks?\b/i.test(h);
}

/** A light stem so "hates"/"hate", "rolled"/"roll", "meetings"/"meeting" compare equal. */
function stem(w: string): string {
  let x = w;
  if (x.length > 4 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`;
  else if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3);
  else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  if (x.length > 3 && x.endsWith('e')) x = x.slice(0, -1);
  return x;
}

const words = (t: string) => (t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);

/**
 * How close a line is to one of the writer's notes (0..1): the Dice overlap of their words, so a
 * one-word note doesn't claim a long line that merely mentions the word.
 */
export function noteOverlap(note: string, line: string): number {
  const n = new Set(words(note));
  const l = new Set(words(line));
  if (!n.size || !l.size) return 0;
  let common = 0;
  for (const w of n) if (l.has(w)) common++;
  return (2 * common) / (n.size + l.size);
}

/** The writer's note lines: one point each, bullets and empty lines removed. */
export function noteLines(notes: string): string[] {
  return notes.split('\n').map((l) => l.replace(/^\s*(?:(?:[-*•–]|\d+[.)]|\[[ x]\]|\[(?:\d+:)?\d{1,2}:\d{2}\])\s*)+/i, '').trim()).filter((l) => l.length > 0 && /[\p{L}\p{N}]/u.test(l)).slice(0, 300);
}

const STAMP = /\[((?:\d+:)?\d{1,2}:\d{2}(?:\s*[,–-]\s*(?:\d+:)?\d{1,2}:\d{2})*)\]\s*$/;

export interface ParseOptions {
  /** The writer's own notes (to mark their lines, and to put back any the model dropped). */
  notes: string;
  /** The recording the times refer to, and its length (later times are dropped). */
  clipId?: string;
  durationMs?: number;
  /** Section headings in template order (sections the model invented go after). */
  headings?: readonly string[];
  /** The transcript, to give lines without times the moments they came from (`groundCitations`). */
  transcript?: readonly StampedLine[];
}

export interface ParsedNotes {
  tldr?: string;
  sections: MeetingSection[];
  /** Note lines that were missing from the reply and were put back. */
  restored: number;
}

/** Reads the line format into sections, marks the writer's lines, restores dropped ones. */
export function parseEnhancedNotes(text: string, opts: ParseOptions): ParsedNotes {
  const clean = strip(text);
  let tldr: string | undefined;
  const sections: MeetingSection[] = [];
  let cur: MeetingSection | null = null;
  const ensure = () => (cur ??= (sections.push({ heading: 'Notes', items: [] }), sections[sections.length - 1]!));
  for (const raw of clean.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const t = /^\s*(?:\*\*)?TL;?DR(?:\*\*)?\s*:\s*(.+)$/i.exec(line);
    if (t) { tldr = t[1]!.replace(STAMP, '').trim(); continue; }
    const h = /^\s*#{1,4}\s+(.+?)\s*#*\s*$/.exec(line) ?? /^\s*\*\*(.+?)\*\*:?\s*$/.exec(line);
    if (h) {
      const heading = h[1]!.replace(/\s+[—–-]\s+.*$/, '').replace(/:$/, '').trim();
      cur = sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase()) ?? null;
      if (!cur) { cur = { heading, items: [] }; sections.push(cur); }
      continue;
    }
    const b = /^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!b) {
      // A sentence outside a list: a point of its own (models sometimes drop the dash).
      if (line.trim().length > 2) ensure().items.push(itemFrom(line.trim(), 0, opts));
      continue;
    }
    const depth = b[1]!.replace(/\t/g, '  ').length >= 2 ? 1 : 0;
    const body = b[2]!.trim();
    if (!body) continue;
    const it = itemFrom(body, depth, opts);
    const sec = ensure();
    if (it.depth && !sec.items.length) delete it.depth;
    sec.items.push(it);
  }
  // Template order first, then any sections the model added.
  if (opts.headings?.length) {
    const rank = (hd: string) => { const i = opts.headings!.findIndex((x) => x.toLowerCase() === hd.toLowerCase()); return i < 0 ? 1000 : i; };
    sections.sort((a, b) => rank(a.heading) - rank(b.heading));
  }
  const kept = sections.filter((s) => s.items.length);
  // Mark the writer's lines. A note line the reply only paraphrased is put back, word for word,
  // just above the line it is closest to (which becomes its detail), so it reads like the
  // writer's point with the AI's details under it; one with no close line goes to the end.
  const mine = noteLines(opts.notes);
  const all = kept.flatMap((s) => s.items);
  for (const it of all) delete it.mine;
  const textOf = (it: MeetingItem) => (it.owner ? `${it.text} ${it.owner}` : it.text);
  const used = new Set<MeetingItem>();
  const missing: string[] = [];
  for (const n of mine) {
    let best: MeetingItem | null = null;
    let score = 0;
    for (const it of all) {
      if (used.has(it)) continue;
      const sc = noteOverlap(n, textOf(it));
      if (sc > score) { score = sc; best = it; }
    }
    if (best && (score >= 0.5 || coverage(n, textOf(best)) >= 0.75 && words(best.text).length <= words(n).length * 1.5 + 1)) { best.mine = true; used.add(best); }
    else missing.push(n);
  }
  let restored = 0;
  const leftover: string[] = [];
  for (const n of missing) {
    let at: { sec: MeetingSection; i: number } | null = null;
    let score = 0;
    for (const sec of kept) {
      sec.items.forEach((it, i) => {
        if (it.mine || it.depth) return;
        const sc = Math.max(noteOverlap(n, textOf(it)), coverage(n, textOf(it)) * 0.6);
        if (sc > score) { score = sc; at = { sec, i }; }
      });
    }
    restored++;
    if (at && score >= 0.2) {
      const { sec, i } = at as { sec: MeetingSection; i: number };
      // The matched line and its own details move under the writer's line.
      let j = i;
      do { sec.items[j]!.depth = 1; j++; } while (j < sec.items.length && sec.items[j]!.depth === 1);
      sec.items.splice(i, 0, { id: newId(), text: n, mine: true });
    } else leftover.push(n);
  }
  if (leftover.length) kept.push({ heading: 'Also in your notes', items: leftover.map((text) => ({ id: newId(), text, mine: true })) });
  if (opts.transcript?.length) groundCitations(kept, opts.transcript, opts.clipId);
  return { ...(tldr ? { tldr } : {}), sections: kept, restored };
}

/** Share of the note's words found in the line (0..1). */
function coverage(note: string, line: string): number {
  const n = new Set(words(note));
  if (!n.size) return 0;
  const l = new Set(words(line));
  let c = 0;
  for (const w of n) if (l.has(w)) c++;
  return c / n.size;
}

/**
 * Times for lines the model wrote without them (small models often drop them), and a check of
 * those it gave: each AI line gets the transcript moments it overlaps most (word overlap of
 * content words), so every grey line links to where it was said. Lines with no clear source get
 * none rather than a guess.
 */
export function groundCitations(sections: MeetingSection[], transcript: readonly StampedLine[], clipId?: string): number {
  const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'it', 'that', 'this', 'we', 'you', 'i', 'they', 'be', 'with', 'at', 'by', 'so', 'as', 'about', 'can', 'will', 'our', 'your', 'their', 'have', 'has', 'do', 'not', 'if', 'but', 'from', 'up', 'just', 'what', 'all', 'any']);
  const content = (t: string) => new Set(words(t).filter((w) => w.length > 2 && !STOP.has(w)));
  const lines = transcript.map((l) => ({ ms: l.ms, w: content(l.text) }));
  let added = 0;
  for (const s of sections) {
    for (const it of s.items) {
      if (it.mine && !it.cites?.length) continue;
      const w = content(it.text + (it.owner ? ` ${it.owner}` : ''));
      if (w.size < 2) continue;
      const scored = lines.map((l) => {
        let c = 0;
        for (const x of w) if (l.w.has(x)) c++;
        return { ms: l.ms, sc: c / Math.min(w.size, Math.max(1, l.w.size)) };
      }).filter((x) => x.sc >= 0.34).sort((a, b) => b.sc - a.sc);
      if (it.cites?.length) {
        // Keep the model's times that are near a supporting line; otherwise use ours.
        const ok = it.cites.filter((c) => scored.some((x) => Math.abs(x.ms - c) < 20_000));
        if (ok.length) { it.cites = ok; continue; }
      }
      if (!scored.length) { delete it.cites; continue; }
      it.cites = [...new Set(scored.slice(0, 2).map((x) => x.ms))].sort((a, b) => a - b);
      if (clipId) it.clipId = clipId;
      added++;
    }
  }
  return added;
}

function itemFrom(body: string, depth: 0 | 1, opts: ParseOptions): MeetingItem {
  let text = body;
  const it: MeetingItem = { id: newId(), text: '' };
  if (depth) it.depth = 1;
  // "[ ] task", "[x] task"
  const cb = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (cb) { if (cb[1]!.toLowerCase() === 'x') it.done = true; else it.done = false; text = cb[2]!; }
  // trailing times
  const st = STAMP.exec(text);
  if (st) {
    const cites = st[1]!.split(/\s*[,–-]\s*/).map((x) => parseStamp(x.trim())).filter((ms): ms is number => ms != null && (opts.durationMs == null || ms <= opts.durationMs + 1000));
    if (cites.length) { it.cites = [...new Set(cites)].slice(0, 4); if (opts.clipId) it.clipId = opts.clipId; }
    text = text.slice(0, st.index).trim();
  }
  // "task — Owner" on action items
  if (it.done !== undefined) {
    const ow = /^(.*\S)\s+[—–]\s+([^—–]{1,60})$/.exec(text) ?? /^(.*\S)\s+-\s+([A-Z][\p{L} .'-]{0,40})$/u.exec(text);
    if (ow && !/^(unassigned|no one|tbd|none)$/i.test(ow[2]!.trim())) { text = ow[1]!; it.owner = ow[2]!.trim(); }
    else if (ow) text = ow[1]!;
  }
  it.text = text.replace(/^\[(?:me|mine|you)\]\s*/i, '').replace(/\*\*/g, '').trim();
  return it;
}

/** A version from a parsed reply. */
export function versionFromParsed(p: ParsedNotes, a: { by: string; template: string; clipIds: string[]; reason: MeetingNotesVersion['reason']; request?: string; at?: number }): MeetingNotesVersion {
  return {
    id: newId(), at: a.at ?? Date.now(), by: a.by, template: a.template, clipIds: a.clipIds, reason: a.reason,
    ...(a.request ? { request: a.request } : {}),
    ...(p.tldr ? { tldr: p.tldr } : {}),
    sections: p.sections,
  };
}

// ---- Recipes ------------------------------------------------------------------------------------------

export interface RecipeMeeting {
  title: string;
  at?: number;
  attendees?: readonly MeetingAttendee[];
  /** Enhanced notes in the line format, or the writer's notes when not enhanced. */
  notes: string;
  transcript?: readonly StampedLine[];
}

/**
 * A recipe on one meeting (citations `[m:ss]`) or several (citations `[M2]` or `[M2 12:03]`,
 * meetings numbered in the order given).
 */
export function recipeMessages(recipe: Pick<Recipe, 'prompt' | 'name'>, meetings: readonly RecipeMeeting[], opts: { maxChars?: number; extra?: string } = {}): ChatMessage[] {
  const budget = opts.maxChars ?? 14000;
  const many = meetings.length > 1;
  const per = Math.max(1200, Math.floor(budget / Math.max(1, meetings.length)));
  const blocks = meetings.map((m, i) => {
    const head = `${many ? `[M${i + 1}] ` : ''}${m.title || 'Untitled'}${m.at ? ` — ${new Date(m.at).toDateString()}` : ''}${m.attendees?.length ? ` — with ${m.attendees.map((p) => p.name).join(', ')}` : ''}`;
    const notes = m.notes.slice(0, Math.floor(per * 0.6));
    const tr = m.transcript?.length ? render(fitLines(m.transcript, Math.floor(per * (notes ? 0.4 : 0.9)), 'spread')) : '';
    return [head, notes ? `Notes:\n${notes}` : '', tr ? `Transcript:\n${tr}` : ''].filter(Boolean).join('\n');
  });
  const cite = many
    ? 'Cite the meeting each point comes from as [M1], [M2]… (add the time when you use a transcript line, like [M2 12:03]).'
    : 'When you use a transcript line, cite its time like [12:03].';
  const system = [
    `You help someone get more out of their meeting notes. Task: ${recipe.name}.`,
    'Use only the meetings given. Be specific and concise. Write Markdown. If the meetings don’t cover something the task needs, say so in one line rather than guessing.',
    cite,
    opts.extra ?? '',
  ].filter(Boolean).join('\n');
  const user = `${recipe.prompt}\n\n${many ? `${meetings.length} meetings:` : 'The meeting:'}\n\n${blocks.join('\n\n---\n\n')}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** `[M2]` / `[M2 12:03]` in a recipe reply → the meeting index (0-based) and time. */
export function meetingCitations(text: string): Array<{ match: string; index: number; ms?: number }> {
  const out: Array<{ match: string; index: number; ms?: number }> = [];
  for (const m of text.matchAll(/\[M(\d{1,3})(?:[ ,]+((?:\d+:)?\d{1,2}:\d{2}))?\]/g)) {
    const ms = m[2] ? parseStamp(m[2]) : null;
    out.push({ match: m[0], index: Number(m[1]) - 1, ...(ms != null ? { ms } : {}) });
  }
  return out;
}

// ---- Briefs -------------------------------------------------------------------------------------------

/** Before a meeting: who is coming, what happened last time, what is still open, what to ask. */
export function briefMessages(a: { title: string; at: number; attendees: readonly MeetingAttendee[]; past: readonly RecipeMeeting[]; maxChars?: number }): ChatMessage[] {
  const budget = a.maxChars ?? 9000;
  const per = Math.max(800, Math.floor(budget / Math.max(1, a.past.length)));
  const past = a.past.map((m, i) => `[M${i + 1}] ${m.title} — ${m.at ? new Date(m.at).toDateString() : 'earlier'}${m.attendees?.length ? ` — with ${m.attendees.map((p) => p.name).join(', ')}` : ''}\n${m.notes.slice(0, per)}`);
  const system = [
    'You prepare someone for a meeting that is about to start, from their notes of earlier meetings with the same people.',
    'Write a short brief in Markdown with these parts, each only if the notes support it:',
    '**Who** — one line per person: role or company and what they care about.',
    '**Last time** — the main outcomes of the most recent meetings.',
    '**Still open** — promises and action items not known to be done, with owners.',
    '**To raise** — 2 to 4 questions or topics worth bringing up.',
    'Cite the meeting for each point as [M1], [M2]…. Under 180 words. No preamble.',
  ].join('\n');
  const user = [
    `Upcoming: ${a.title} — ${new Date(a.at).toString().slice(0, 21)}`,
    a.attendees.length ? `Attendees: ${a.attendees.map((p) => `${p.name}${p.email ? ` <${p.email}>` : ''}`).join(', ')}` : '',
    past.length ? `Earlier meetings (newest first):\n\n${past.join('\n\n---\n\n')}` : 'No earlier meetings with these people.',
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ---- During the meeting -------------------------------------------------------------------------------

/** "Catch me up": what was said in the last few minutes, briefly, with times. */
export function catchUpMessages(lines: readonly StampedLine[], minutes = 3): ChatMessage[] {
  const end = lines.length ? lines[lines.length - 1]!.ms : 0;
  const recent = lines.filter((l) => l.ms >= end - minutes * 60_000);
  return [
    { role: 'system', content: `Someone in a meeting lost the thread. Tell them what was said in the last ${minutes} minutes: 2 to 4 short bullets ("- …"), the most important first, each with the time of the line it comes from like [12:03]. Then one line starting "Now:" saying what is being discussed right now. Only what is in the transcript.` },
    { role: 'user', content: recent.length ? render(recent) : '(nothing transcribed yet)' },
  ];
}

/** Translation of transcript lines, for live captions: numbered in, numbered out. */
export function translateLinesMessages(lines: readonly string[], language: string): ChatMessage[] {
  return [
    { role: 'system', content: `Translate each numbered line into ${language}. Reply with the same numbers, one line each ("1. …"), nothing else. Keep names, numbers and product terms as they are. If a line is already in ${language}, repeat it.` },
    { role: 'user', content: lines.map((l, i) => `${i + 1}. ${l.replace(/\s+/g, ' ').trim()}`).join('\n') },
  ];
}

export function parseNumberedLines(text: string, count: number): Array<string | null> {
  const out: Array<string | null> = Array.from({ length: count }, () => null);
  for (const raw of strip(text).split('\n')) {
    const m = /^\s*(\d{1,3})[.):]\s*(.+)$/.exec(raw);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i >= 0 && i < count && !out[i]) out[i] = m[2]!.trim();
  }
  return out;
}

// ---- Audio overview -----------------------------------------------------------------------------------

export interface OverviewLine { voice: 'A' | 'B'; text: string }

/**
 * A short two-voice conversation about notes (like a podcast), to listen to on the way to the next
 * meeting. Read aloud on the device with two system voices.
 */
export function audioOverviewMessages(a: { title: string; notes: string; minutes?: number }): ChatMessage[] {
  const words = Math.round((a.minutes ?? 3) * 150);
  return [
    { role: 'system', content: [
      `Write a lively two-person conversation (about ${words} words) that walks a listener through these notes, like a short podcast. Speaker A guides; speaker B asks the questions a listener would and adds the interesting details.`,
      'Format: each line starts with "A:" or "B:". No stage directions, no sound effects, no headings. Plain spoken English (or the notes\' language). Mention names, numbers and decisions exactly as in the notes; never invent any.',
      'Start straight in with what matters most; end with what happens next.',
    ].join('\n') },
    { role: 'user', content: `Notes: ${a.title}\n\n${a.notes.slice(0, 9000)}` },
  ];
}

export function parseOverview(text: string): OverviewLine[] {
  const out: OverviewLine[] = [];
  for (const raw of strip(text).split('\n')) {
    const m = /^\s*\**\s*(A|B|Host A|Host B|Speaker A|Speaker B)\s*\**\s*[:：]\s*(.+)$/i.exec(raw);
    if (m) {
      const voice = /b$/i.test(m[1]!.trim()) ? 'B' : 'A';
      const text = m[2]!.replace(/\*+/g, '').replace(/\[[^\]]*\]|\([^)]*(laughs|pause|music)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
      if (text) out.push({ voice, text });
    } else if (out.length && raw.trim() && !/^#/.test(raw)) out[out.length - 1]!.text += ` ${raw.trim()}`;
  }
  return out;
}
