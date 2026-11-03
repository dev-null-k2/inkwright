/**
 * How much recognized handwriting can be trusted as text, without a recognizer score.
 *
 * Handwriting recognizers return their best guess for every line, including scribbles, arrows and
 * half-written words. Fed to a model, those become questions about "ools" (a teach-back card made
 * from a fragment of "tools"). The bridge to ML Kit does not carry candidate scores, so this judges
 * the text itself: tokens that look like words (letters with a vowel, or a known short word),
 * numbers, amounts and sums count; lone fragments, consonant runs and symbol soup do not.
 */

const VOWEL = /[aeiouyàáâäãåæèéêëìíîïòóôöõøùúûüýÿœ]/i;
const SHORT_WORDS = new Set(['a', 'i', 'o', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we', 'am', 'pm', 'ok', 'tv', 'id', 'vs']);
/** Scripts without spaces or vowels in the Latin sense: judged by length only. */
const NON_LATIN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Cyrillic}\p{Script=Greek}]/u;

export type TokenKind = 'word' | 'number' | 'math' | 'junk';

/** Classifies one whitespace-separated token. */
export function tokenKind(token: string): TokenKind {
  const t = token.replace(/^[("'“‘[]+|[)"'”’\],.;:!?]+$/g, '');
  if (!t) return 'junk';
  if (/^[$€£¥]?[-+]?\d[\d.,]*(?:[%$€£¥]|k|m|st|nd|rd|th|h|am|pm|kg|g|km|m|cm|mm|l|ml)?$/i.test(t)) return 'number';
  if (/^[\d\s+\-*/×x÷=^().√π<>≤≥%]+$/i.test(t) && /\d/.test(t)) return 'math';
  if (/^[+\-*/×÷=<>≤≥]$/.test(t)) return 'math';
  if (NON_LATIN.test(t)) return 'word';
  const letters = t.replace(/[^\p{L}'’-]/gu, '');
  if (!letters || letters.length < t.length * 0.6) return 'junk';
  if (letters.length <= 2) return SHORT_WORDS.has(letters.toLowerCase()) ? 'word' : 'junk';
  if (!VOWEL.test(letters)) return /^[A-Z]{2,5}$/.test(letters) ? 'word' : 'junk'; // acronyms (DNA, HTML)
  // Five consonants in a row or three identical letters: rarely a real word.
  if (/[^aeiouy\W\d]{5,}/i.test(letters) || /(\p{L})\1\1/iu.test(letters)) return 'junk';
  return 'word';
}

export interface TextQuality {
  tokens: number;
  words: number;
  /** Words, numbers and maths over all tokens (0–1). */
  ratio: number;
}

export function textQuality(text: string): TextQuality {
  const toks = text.split(/\s+/).filter(Boolean);
  const kinds = toks.map(tokenKind);
  const good = kinds.filter((k) => k !== 'junk').length;
  return { tokens: toks.length, words: kinds.filter((k) => k === 'word').length, ratio: toks.length ? good / toks.length : 0 };
}

/**
 * A recognized line worth giving to a model as text: most of its tokens read as words, numbers
 * or maths. "Budget Car 4000$", "2+2=" and "milk" pass; "~~ /|", "xkcqzt" and "Iiil" don't.
 */
export function isReadableLine(line: string): boolean {
  const q = textQuality(line);
  if (!q.tokens) return false;
  if (q.tokens === 1) return tokenKind(line.trim()) !== 'junk';
  return q.ratio >= 0.6;
}

/** Recognized text with unreadable lines dropped (typed text is never passed through this). */
export function readableText(text: string): string {
  return text.split('\n').filter((l) => isReadableLine(l)).join('\n');
}

/**
 * Enough real words to teach or test from: at least three word tokens and mostly readable.
 * Study cards, teach-back and flashcards use only units that pass, so a lone fragment like "ools"
 * never becomes a question.
 */
export function isStudyWorthy(text: string): boolean {
  const q = textQuality(text);
  return q.words >= 3 && q.ratio >= 0.7;
}
