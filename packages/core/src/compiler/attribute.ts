/**
 * "Explain this answer" for text a model wrote outside the compiler (assistant replies, summaries):
 * each sentence is attributed to the passages the model was shown, by the links it cited and by
 * how much of the sentence each passage contains. A sentence nothing supports is reported as
 * such — "not from your notes" — rather than given a source it doesn't have.
 */
import type { Rect } from '../geometry.ts';
import { formatAnchor } from './provenance.ts';
import type { ProvClaim, ProvTag } from './provenance.ts';
import type { SourceUnit } from './extract.ts';
import { containment, splitSentences, stripMarkdown, wordSet } from './text.ts';

/** Something the model read: a search hit, a page of a note, a transcript passage. */
export interface Passage {
  noteId: string;
  title: string;
  pageIndex: number;
  text: string;
  rect?: Rect;
  clip?: string;
  ms?: number;
}

export interface AttributedSentence {
  text: string;
  start: number;
  tag: ProvTag | null;
  sources: Passage[];
  /** Share of the sentence's words found in its best source (0..1). */
  support: number;
  /** The sentence cited these places with links. */
  cited: boolean;
}

const LINK = /\[([^\]]*)\]\(#mem\/([^/)]+)\/(\d+)[^)]*\)/g;

/**
 * Attributes each sentence of `text` (Markdown) to `passages`. EXTRACTED when one passage holds
 * ≥ 80 % of its words, INFERRED when passages hold ≥ 40 % or it links to them, otherwise no tag.
 * Citation links (`[Title, p. 2](#mem/…)`) are taken out before splitting, so "p. 2" never ends
 * a sentence, and count as the sentence citing that page.
 */
export function attributeAnswer(text: string, passages: readonly Passage[]): AttributedSentence[] {
  const pw = passages.map((p) => wordSet(p.text));
  const links: Array<{ noteId: string; page: number }> = [];
  const flat = text.replace(LINK, (_m, _label: string, id: string, page: string) => {
    links.push({ noteId: decodeURIComponent(id), page: Number(page) - 1 });
    return `\u2063${links.length - 1}\u2063`;
  });
  return splitSentences(flat).map((s) => {
    const linked = new Set<number>();
    for (const m of s.text.matchAll(/\u2063(\d+)\u2063/g)) {
      const l = links[Number(m[1])]!;
      passages.forEach((p, i) => { if (p.noteId === l.noteId && p.pageIndex === l.page) linked.add(i); });
    }
    const plain = stripMarkdown(s.text.replace(/\s*\(?\s*(?:\u2063\d+\u2063[\s,;]*)+\)?/g, '')).replace(/\s+([.,;:!?])/g, '$1').trim();
    const words = wordSet(plain);
    const scored = passages.map((p, i) => ({ p, i, c: words.size ? containment(words, pw[i]!) : 0 })).sort((a, b) => b.c - a.c);
    const best = scored[0]?.c ?? 0;
    const sources = scored.filter((x) => x.c >= 0.4 || linked.has(x.i)).slice(0, 3).map((x) => x.p);
    const tag: ProvTag | null = best >= 0.8 ? 'E' : sources.length ? 'I' : null;
    return { text: plain, start: s.start, tag, sources, support: Math.round(best * 100) / 100, cited: linked.size > 0 };
  }).filter((s) => /[\p{L}\p{N}]/u.test(s.text));
}

/**
 * Turns attributed sentences into provenance claims, anchoring each source to the sentence of
 * its note that best matches (so staleness works for answers inserted onto a page too).
 */
export function attributedClaims(sentences: readonly AttributedSentence[], unitsOf: (noteId: string) => readonly SourceUnit[] | null): ProvClaim[] {
  const out: ProvClaim[] = [];
  for (const s of sentences) {
    if (!s.tag) continue;
    const words = wordSet(s.text);
    const src: string[] = [];
    for (const p of s.sources) {
      const units = (unitsOf(p.noteId) ?? []).filter((u) => u.pageIndex === p.pageIndex);
      const best = units.map((u) => ({ u, c: containment(words, wordSet(u.text)) })).sort((a, b) => b.c - a.c)[0];
      if (best) src.push(formatAnchor({ noteId: best.u.noteId, page: best.u.pageIndex, ...(best.u.rect ? { rect: best.u.rect } : {}), ...(best.u.clip ? { clip: best.u.clip, ms: best.u.startMs ?? 0 } : {}), h: best.u.hash }));
    }
    if (src.length) out.push({ s: s.text, t: s.tag, src: [...new Set(src)], c: s.support });
  }
  return out;
}
