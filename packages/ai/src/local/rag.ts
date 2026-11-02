import type { ChatMessage } from '../types.ts';

/**
 * "Ask your notes": retrieval-augmented answers with numbered citations. The passages come from
 * the hybrid memory index; the model is told to answer only from them and to cite each claim as
 * [n]. Citations are then parsed back so the UI can link each [n] to the exact page region.
 */
export interface AskPassage {
  /** 1-based citation number. */
  n: number;
  title: string;
  /** 1-based page number for display. */
  page: number;
  /** Where the words come from: typed text, handwriting, PDF, note details. */
  kind: string;
  text: string;
  /** When the note was last edited (helps "last week" style questions). */
  updated?: string;
}

export function askSystemPrompt(opts: { today?: string; appName?: string } = {}): string {
  return [
    `You answer questions about the user's own notes in ${opts.appName ?? 'Inkwright'}, a handwriting note app${opts.today ? `. Today is ${opts.today}` : ''}.`,
    'You are given numbered passages from the notes (typed text, recognized handwriting and PDF text). Use only these passages.',
    'Cite every fact with the passage number in square brackets right after it, like this: The transform is linear [2]. Use several numbers when several passages support it: [1][3].',
    'If the passages do not answer the question, say so briefly and mention what they do cover. Never invent notes, pages or citations.',
    'Be concise: a few sentences or a short list. Handwriting recognition can contain small errors; read through them.',
  ].join('\n');
}

export function formatPassages(passages: readonly AskPassage[], maxChars = 6000): string {
  let budget = maxChars;
  const out: string[] = [];
  for (const p of passages) {
    const head = `[${p.n}] "${p.title}", page ${p.page} (${p.kind}${p.updated ? `, edited ${p.updated}` : ''})`;
    const text = p.text.length > budget ? `${p.text.slice(0, Math.max(0, budget))}…` : p.text;
    budget -= text.length;
    out.push(`${head}\n${text}`);
    if (budget <= 0) break;
  }
  return out.join('\n\n');
}

export function buildAskMessages(question: string, passages: readonly AskPassage[], opts: { today?: string; maxChars?: number } = {}): ChatMessage[] {
  const body = passages.length ? formatPassages(passages, opts.maxChars) : '(No passages matched this question.)';
  return [
    { role: 'system', content: askSystemPrompt({ today: opts.today }) },
    { role: 'user', content: `Passages from my notes:\n\n${body}\n\nQuestion: ${question}` },
  ];
}

export type AnswerSegment = { type: 'text'; text: string } | { type: 'cite'; n: number };

/**
 * Splits an answer into text and citation markers. Accepts [1], [1, 3], [1][2] and 【1】;
 * numbers that don't refer to a passage stay as plain text (the model invented them).
 */
export function parseAnswerCitations(answer: string, passageCount: number): { segments: AnswerSegment[]; cited: number[] } {
  const segments: AnswerSegment[] = [];
  const cited: number[] = [];
  const re = /[[【]\s*(\d{1,3}(?:\s*[,，;]\s*\d{1,3})*)\s*[\]】]/g;
  let last = 0;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    const nums = m[1]!.split(/[,，;]/).map((x) => Number(x.trim()));
    if (!nums.every((n) => n >= 1 && n <= passageCount)) continue;
    if (m.index > last) segments.push({ type: 'text', text: answer.slice(last, m.index) });
    for (const n of nums) {
      segments.push({ type: 'cite', n });
      if (!cited.includes(n)) cited.push(n);
    }
    last = m.index + m[0].length;
  }
  if (last < answer.length) segments.push({ type: 'text', text: answer.slice(last) });
  // Merge adjacent text segments (skipped invalid markers split them).
  const merged: AnswerSegment[] = [];
  for (const s of segments) {
    const prev = merged[merged.length - 1];
    if (s.type === 'text' && prev?.type === 'text') prev.text += s.text;
    else merged.push({ ...s });
  }
  return { segments: merged, cited };
}
