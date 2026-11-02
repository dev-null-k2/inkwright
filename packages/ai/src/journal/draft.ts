/**
 * Checking and composing the model's journal draft. The model proposes paragraphs, each citing
 * the source ids it rests on; only paragraphs with at least one real citation survive (a
 * sentence the day's sources don't back is not written, however plausible). The kept paragraphs
 * become the journal body with numbered markers ("… went over Fourier series [1].") and a typed
 * "Sources" list that links back to the ink, the recording moment, the event or the screen
 * moment — and, for typed drafts, provenance claims so Explain shows each sentence's sources
 * (docs/COMPILER.md § Provenance).
 */
import { splitSentences, type ProvClaim } from '@inkwright/core';
import type { JournalSource } from './sources.ts';

export interface DraftParagraph {
  text: string;
  sources: string[];
}

export interface CheckedParagraph {
  text: string;
  sources: JournalSource[];
}

export interface DraftCheck {
  kept: CheckedParagraph[];
  dropped: Array<{ text: string; reason: string }>;
}

export const MAX_PARAGRAPHS = 12;
const MAX_PARAGRAPH_CHARS = 900;

/** Citation markers the model may have typed into its text ("[s3]", "(s1, s2)", "【s2】"). */
const MARKER = /\s*[[(【]\s*s\d+(?:\s*[,;]\s*s\d+)*\s*[\])】]/gi;

/** Validates the model's paragraphs against the day's sources. */
export function checkJournalDraft(raw: unknown, sources: readonly JournalSource[]): DraftCheck {
  const byId = new Map(sources.map((s) => [s.id.toLowerCase(), s]));
  const out: DraftCheck = { kept: [], dropped: [] };
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const p = item as Partial<DraftParagraph> | null;
    const text = typeof p?.text === 'string' ? p.text.replace(MARKER, '').replace(/\s+\n/g, '\n').trim() : '';
    if (!text) continue;
    if (out.kept.length >= MAX_PARAGRAPHS) { out.dropped.push({ text, reason: 'too many paragraphs' }); continue; }
    const ids = Array.isArray(p?.sources) ? p!.sources.filter((x): x is string => typeof x === 'string') : [];
    const cited = [...new Set(ids.map((x) => x.trim().toLowerCase()))].map((x) => byId.get(x)).filter((x): x is JournalSource => !!x);
    if (!cited.length) { out.dropped.push({ text, reason: ids.length ? 'cites sources that do not exist' : 'cites no source' }); continue; }
    out.kept.push({ text: text.length > MAX_PARAGRAPH_CHARS ? `${text.slice(0, MAX_PARAGRAPH_CHARS - 1).trimEnd()}…` : text, sources: cited });
  }
  return out;
}

export interface ComposedJournal {
  /** The body with numbered citation markers, one paragraph per kept paragraph. */
  body: string;
  /** Markdown list of the cited sources, numbered in order of first citation. */
  footer: string;
  /** Sources in citation order (index + 1 is the number shown). */
  cited: JournalSource[];
  /** Provenance claims for the body (one per paragraph). */
  claims: ProvClaim[];
}

const KIND_LABEL: Record<JournalSource['kind'], string> = { note: 'your note', speech: 'recording', event: 'calendar', screen: 'memory timeline', audio: 'memory timeline, heard' };
const hhmm = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mdEscape = (s: string) => s.replace(/([[\]\\*_`])/g, '\\$1');

/** Builds the body, the sources list and the provenance claims. */
export function composeJournal(kept: readonly CheckedParagraph[]): ComposedJournal {
  const cited: JournalSource[] = [];
  const num = (s: JournalSource) => {
    let i = cited.indexOf(s);
    if (i < 0) { cited.push(s); i = cited.length - 1; }
    return i + 1;
  };
  const paragraphs = kept.map((p) => {
    const nums = p.sources.map(num);
    // The marker goes before the closing punctuation, so it stays part of the last sentence.
    const m = /([.!?…]+["”’)]*)$/.exec(p.text);
    const marker = ` [${nums.join(', ')}]`;
    const marked = m ? `${p.text.slice(0, m.index)}${marker}${m[1]}` : `${p.text}${marker}`;
    return { text: p.text, marked, sources: p.sources };
  });
  const footer = ['Sources', ...cited.map((s, i) => {
    const label = `${mdEscape(s.title)}`;
    const linked = s.link ? `[${label}](${s.link})` : label;
    return `${i + 1}. ${linked} — ${KIND_LABEL[s.kind]}, ${hhmm(s.at)}`;
  })].join('\n');
  // One claim per sentence (Explain finds sentences by their text), each with its paragraph's sources.
  const claims: ProvClaim[] = paragraphs.flatMap((p) => {
    const anchors = p.sources.map((s) => s.anchor).filter((a): a is string => !!a);
    const other = [...new Set(p.sources.filter((s) => !s.anchor).map((s) => KIND_LABEL[s.kind]))];
    return splitSentences(p.marked).map(({ text }) => {
      const claim: ProvClaim = { s: text, t: 'I', src: anchors };
      if (other.length) claim.why = `Also from: ${other.join(', ')}`;
      return claim;
    });
  });
  return { body: paragraphs.map((p) => p.marked).join('\n\n'), footer, cited, claims };
}

/** The instructions the journal routine gives the model (prompt id `journal.draft/1`). */
export const JOURNAL_PROMPT_ID = 'journal.draft/1';

export function journalInstructions(style: 'ink' | 'typed'): string {
  return [
    'Write my journal entry for the day from the sources journal_sources returned.',
    '- First person, past tense, plain and warm; what I did, learned, decided and still have to do. No headings, no lists.',
    `- ${style === 'ink' ? 'It will be written in handwriting, so keep it short: 2–5 short paragraphs, under 120 words in all.' : '3–6 short paragraphs, under 250 words in all.'}`,
    '- Every paragraph must cite the ids of the sources it rests on (e.g. ["s2", "s5"]). Write nothing the sources do not say; do not guess feelings or reasons.',
    '- Screen moments and things heard nearby are context: mention them only when they matter to the day.',
    '- Then call write_journal_draft once with the date and the paragraphs. Reply with one line saying where the draft is.',
  ].join('\n');
}
