/**
 * The app's built-in skills, shipped as real Agent Skills (`packages/ai/skills/<name>/SKILL.md`) so
 * users can read, copy and export them like any other skill, and so they follow the same
 * progressive disclosure as imported ones. They mirror the one-tap features in `skills.ts`
 * (transcribe, summarize, to-dos, flashcards, explain, translate, title, tags, answer from notes),
 * written for the tool-using assistant.
 */
import { skillFromMarkdown, type SkillBundle } from './agentskills.ts';
import transcribe from '../skills/transcribe-handwriting/SKILL.md?raw';
import summarize from '../skills/summarize-note/SKILL.md?raw';
import todos from '../skills/extract-todos/SKILL.md?raw';
import flashcards from '../skills/make-flashcards/SKILL.md?raw';
import explain from '../skills/explain-selection/SKILL.md?raw';
import translate from '../skills/translate-text/SKILL.md?raw';
import title from '../skills/suggest-title/SKILL.md?raw';
import tags from '../skills/suggest-tags/SKILL.md?raw';
import answer from '../skills/answer-from-notes/SKILL.md?raw';

const SOURCES: Record<string, string> = {
  'transcribe-handwriting': transcribe,
  'summarize-note': summarize,
  'extract-todos': todos,
  'make-flashcards': flashcards,
  'explain-selection': explain,
  'translate-text': translate,
  'suggest-title': title,
  'suggest-tags': tags,
  'answer-from-notes': answer,
};

let cache: SkillBundle[] | null = null;

/** The nine built-in skills, parsed and validated (a malformed one fails loudly in tests). */
export function builtinSkills(): SkillBundle[] {
  cache ??= Object.entries(SOURCES).map(([dir, md]) => skillFromMarkdown(md, { dirName: dir, builtin: true }));
  return cache;
}
