import { extractJsonArray, stripFences } from './json.ts';
import type { NoteToolHost } from './tools/notes.ts';
import type { ChatMessage, ChatRequest, Provider } from './types.ts';

/** A prompt a skill sends: everything needed for one model call. */
export interface SkillPrompt {
  system: string;
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/** A one-shot AI feature behind an app button: a prompt builder plus a robust output parser. */
export interface Skill<I, O> {
  id: string;
  label: string;
  description: string;
  /** Needs a vision-capable model. */
  vision?: boolean;
  build(input: I): SkillPrompt;
  parse(text: string, input: I): O;
}

export interface RunSkillOptions {
  signal?: AbortSignal;
  /** Streams raw model text (useful for long outputs like transcriptions). */
  onText?: (delta: string, soFar: string) => void;
  temperature?: number;
  maxTokens?: number;
}

export async function runSkill<I, O>(skill: Skill<I, O>, provider: Provider, model: string, input: I, opts: RunSkillOptions = {}): Promise<O> {
  const p = skill.build(input);
  const req: ChatRequest = { model, messages: [{ role: 'system', content: p.system }, ...p.messages], signal: opts.signal };
  const temperature = opts.temperature ?? p.temperature;
  if (temperature !== undefined) req.temperature = temperature;
  const maxTokens = opts.maxTokens ?? p.maxTokens;
  if (maxTokens !== undefined) req.maxTokens = maxTokens;
  if (p.json) req.json = true;
  let soFar = '';
  const onText = opts.onText;
  const r = await provider.chat(req, onText ? (e) => (e.type === 'text' ? onText(e.delta, (soFar += e.delta)) : undefined) : undefined);
  return skill.parse(r.text, input);
}

// ---- Text cleanup -----------------------------------------------------------------------------

const PREAMBLE = /^(?:(?:sure|certainly|of course|okay|ok|absolutely)[,!.]?\s*)?(?:here(?:'s| is| are)|below is|this is)\b[^\n]{0,80}:\s*\n+/i;
const SIGNOFF = /\n+(?:let me know|i hope this|feel free|hope this helps|if you(?:'d| would) like)[^\n]*$/i;

/** Strips code fences, chatty preambles ("Here is the summary:") and sign-offs from model text. */
export function cleanText(text: string): string {
  let t = stripFences(text.trim());
  t = t.replace(PREAMBLE, '');
  t = t.replace(SIGNOFF, '');
  return stripFences(t.trim()).trim();
}

function stripLabel(t: string, label: string): string {
  return t.replace(new RegExp(`^\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?`, 'i'), '').trim();
}

function unquote(t: string): string {
  const m = /^(["'“‘«])([\s\S]*)(["'”’»])$/.exec(t.trim());
  return m ? m[2]!.trim() : t.trim();
}

// ---- Handwriting ------------------------------------------------------------------------------

export interface TranscribeInput {
  /** The page or region image. `data` is base64. */
  image: { mediaType: string; data: string };
  /** `plain` keeps lines as written; `markdown` also restores structure (headings, lists, checkboxes). */
  mode?: 'plain' | 'markdown';
  /** e.g. "German", or "mixed English/Hindi". */
  languageHint?: string;
  /** Nearby text (note title, previous page) to help with ambiguous words. */
  context?: string;
}

const NOTHING = /^(?:\(?\[?(?:no (?:handwriting|text)(?: found| detected)?|blank(?: page)?|empty(?: page)?|nothing to transcribe)\]?\)?\.?)$/i;

export const transcribeHandwriting: Skill<TranscribeInput, string> = {
  id: 'transcribe',
  label: 'Convert handwriting to text',
  description: 'Reads the handwriting in a page image and returns it as text.',
  vision: true,
  build(input) {
    const md = input.mode === 'markdown';
    const rules = [
      'You transcribe handwritten notes from images with high accuracy.',
      'Rules:',
      '- Output only the transcription — no commentary, no preamble, no code fences.',
      '- Transcribe exactly what is written, in reading order. Do not translate, summarize or fix grammar; keep the writer\'s abbreviations.',
      md
        ? '- Format as Markdown that mirrors the page: "#" for titles, "- " for bullets, "1." for numbered items, "- [ ] " / "- [x] " for checkboxes, blank lines between blocks, $…$ for math. Describe drawings briefly as _[sketch: …]_.'
        : '- Keep the original line breaks: one output line per written line. Keep bullets and numbering as plain characters. Skip drawings.',
      '- Mark words you cannot read as [?]. Ignore ruled lines, grid, page decorations and crossed-out text.',
      '- If there is no handwriting, output nothing.',
    ];
    if (input.languageHint) rules.push(`- The writing is likely in ${input.languageHint}.`);
    const lead = input.context ? `Context (may help with unclear words): ${input.context.slice(0, 600)}\n\nTranscribe this page.` : 'Transcribe this page.';
    return {
      system: rules.join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: lead }, { type: 'image', mediaType: input.image.mediaType, data: input.image.data }] }],
      temperature: 0,
      maxTokens: 4096,
    };
  },
  parse(text) {
    const t = cleanText(text);
    return NOTHING.test(t) ? '' : t.replace(/[ \t]+$/gm, '');
  },
};

// ---- Summaries & explanations -----------------------------------------------------------------

export interface SummarizeInput {
  title?: string;
  text: string;
  /** `short` (1–2 sentences, for the library card), `bullets`, or `detailed`. */
  style?: 'short' | 'bullets' | 'detailed';
  /** Write the summary in this language (default: the note's language). */
  language?: string;
}

export const summarizeNote: Skill<SummarizeInput, string> = {
  id: 'summarize',
  label: 'Summarize',
  description: 'Summarizes a note.',
  build(input) {
    const style = input.style ?? 'short';
    const how =
      style === 'short'
        ? 'Write a 1–2 sentence summary (max 40 words) that says what the note is about and its key point.'
        : style === 'bullets'
          ? 'Write 3–7 concise Markdown bullet points ("- ") covering the key points, decisions and action items.'
          : 'Write a structured summary in Markdown: a one-sentence overview, then key points, decisions and open questions.';
    return {
      system: [
        'You summarize personal notes. Be faithful: use only what the note says, never invent details.',
        how,
        `Write in ${input.language ?? 'the same language as the note'}. Output only the summary.`,
      ].join('\n'),
      messages: [{ role: 'user', content: `${input.title ? `Title: ${input.title}\n\n` : ''}Note:\n${input.text.slice(0, 60_000)}` }],
      temperature: 0.2,
      maxTokens: style === 'short' ? 200 : 900,
    };
  },
  parse(text) {
    return stripLabel(cleanText(text), 'summary');
  },
};

export interface ExplainInput {
  selection: string;
  /** Surrounding note text. */
  context?: string;
  level?: 'simple' | 'standard' | 'expert';
  /** A specific question about the selection. */
  question?: string;
}

export const explainSelection: Skill<ExplainInput, string> = {
  id: 'explain',
  label: 'Explain',
  description: 'Explains the selected text or formula.',
  build(input) {
    const level = input.level ?? 'standard';
    const tone =
      level === 'simple' ? 'Explain it simply, as to a curious 12-year-old, with an everyday example.' : level === 'expert' ? 'Explain it precisely and technically for an expert.' : 'Explain it clearly and concisely for an educated reader.';
    const parts = [`Selected text:\n"""\n${input.selection.slice(0, 8000)}\n"""`];
    if (input.context) parts.push(`Surrounding note (for context):\n"""\n${input.context.slice(0, 8000)}\n"""`);
    parts.push(input.question ? `Question: ${input.question}` : 'Explain the selected text.');
    return {
      system: `You help a user understand something in their notes. ${tone} Use Markdown sparingly (short paragraphs, a list if it helps). If the selection is a formula, explain each symbol. If it seems to contain a mistake, point it out gently.`,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
      temperature: 0.3,
      maxTokens: 800,
    };
  },
  parse(text) {
    return cleanText(text);
  },
};

export interface TranslateInput {
  text: string;
  /** Target language: a name ("Spanish") or code ("es"). */
  lang: string;
  sourceLang?: string;
}

export const translate: Skill<TranslateInput, string> = {
  id: 'translate',
  label: 'Translate',
  description: 'Translates text, keeping its formatting.',
  build(input) {
    return {
      system: [
        `You are a translator. Translate the user's text ${input.sourceLang ? `from ${input.sourceLang} ` : ''}into ${input.lang}.`,
        'Keep the meaning, tone and formatting exactly: line breaks, Markdown, lists, numbers, names, URLs and [[wiki links]] stay as they are.',
        'Output only the translation — no notes, no quotes, no preamble.',
      ].join('\n'),
      messages: [{ role: 'user', content: input.text }],
      temperature: 0.1,
      maxTokens: Math.min(8000, 200 + Math.ceil(input.text.length / 2)),
    };
  },
  parse(text, input) {
    let t = cleanText(text);
    if (!/^["'“«]/.test(input.text.trim())) t = unquote(t);
    return stripLabel(t, 'translation');
  },
};

// ---- Titles & tags ----------------------------------------------------------------------------

export interface SuggestTitleInput {
  text: string;
  currentTitle?: string;
}

export const suggestTitle: Skill<SuggestTitleInput, string> = {
  id: 'title',
  label: 'Suggest title',
  description: 'Suggests a short title for a note.',
  build(input) {
    return {
      system: 'You name notes. Reply with one short, specific title (2–7 words) in the note\'s language. No quotes, no trailing period, nothing else.',
      messages: [{ role: 'user', content: `${input.currentTitle ? `Current title: ${input.currentTitle}\n\n` : ''}Note:\n${input.text.slice(0, 12_000)}` }],
      temperature: 0.3,
      maxTokens: 30,
    };
  },
  parse(text) {
    const line = cleanText(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    let t = stripLabel(line, '(?:suggested )?title').replace(/^#+\s*/, '').replace(/^[*_]+|[*_]+$/g, '');
    t = unquote(t).replace(/[.。]+$/, '').trim();
    return t.length > 80 ? t.slice(0, 80).replace(/\s+\S*$/, '') : t;
  },
};

export interface SuggestTagsInput {
  text: string;
  title?: string;
  /** Tags already used in the vault: reused when they fit, to keep tags consistent. */
  existingTags?: string[];
  /** Maximum tags (default 5). */
  max?: number;
}

/** "#Project Ideas!" → "project-ideas". */
export function normalizeTag(t: string): string {
  return t
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}/-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export const suggestTags: Skill<SuggestTagsInput, string[]> = {
  id: 'tags',
  label: 'Suggest tags',
  description: 'Suggests tags for a note.',
  build(input) {
    const max = input.max ?? 5;
    const existing = input.existingTags?.length ? `\nTags the user already uses (prefer these when they fit): ${input.existingTags.slice(0, 200).join(', ')}` : '';
    return {
      system: `You tag notes for later retrieval. Suggest 1–${max} short topical tags (lowercase, 1–3 words, hyphenated, no "#"). Respond with JSON: {"tags": ["tag", …]}.${existing}`,
      messages: [{ role: 'user', content: `${input.title ? `Title: ${input.title}\n\n` : ''}Note:\n${input.text.slice(0, 12_000)}` }],
      json: true,
      temperature: 0.2,
      maxTokens: 120,
    };
  },
  parse(text, input) {
    const max = input.max ?? 5;
    let raw: unknown[] | undefined = jsonListOrUndefined(text);
    if (!raw || raw.some((v) => typeof v !== 'string')) {
      raw = cleanText(text)
        .replace(/^tags\s*:/i, '')
        .split(/[,\n]/)
        .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''));
    }
    const existing = new Map((input.existingTags ?? []).map((t) => [normalizeTag(t), t]));
    const out: string[] = [];
    for (const v of raw) {
      const n = normalizeTag(String(v));
      if (!n || n.length > 40) continue;
      const tag = existing.has(n) ? normalizeTag(existing.get(n)!) : n;
      if (!out.includes(tag)) out.push(tag);
    }
    return out.slice(0, max);
  },
};

// ---- Structured extraction ----------------------------------------------------------------------

export interface Todo {
  text: string;
  /** `YYYY-MM-DD` when a date is stated or implied. */
  due?: string;
  done?: boolean;
}

export interface ExtractTodosInput {
  text: string;
  /** `YYYY-MM-DD`, to resolve "tomorrow", "next Friday" (default: today). */
  today?: string;
}

function isoDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (!/\d/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s*(?:\[( |x|X)\]\s*)?(.+?)\s*$/;

/**
 * JSON array from model output, unless the "JSON" is just Markdown brackets in a list
 * (`- [ ] task` contains the valid JSON `[ ]`).
 */
function jsonListOrUndefined(text: string): unknown[] | undefined {
  const raw = extractJsonArray(text);
  if (!raw) return undefined;
  if (raw.length === 0 && !/^\s*(?:[[{]|```)/.test(text) && text.split('\n').some((l) => LIST_LINE.test(l))) return undefined;
  return raw;
}

export const extractTodos: Skill<ExtractTodosInput, Todo[]> = {
  id: 'todos',
  label: 'Extract to-dos',
  description: 'Finds action items in a note.',
  build(input) {
    const today = input.today ?? new Date().toISOString().slice(0, 10);
    return {
      system: [
        'You extract action items (to-dos) from notes: things someone needs to do. Ignore facts, ideas and completed history unless written as a checked task.',
        `Today is ${today}. Resolve relative dates ("tomorrow", "next Friday", "by the 3rd") to YYYY-MM-DD; omit "due" when no date is given.`,
        'Each item: a short imperative phrase in the note\'s language ("Email Sam the budget"). Mark checked boxes (☑, [x], crossed out) as done.',
        'Respond with JSON: {"todos": [{"text": string, "due"?: "YYYY-MM-DD", "done"?: boolean}]}. Use {"todos": []} if there are none.',
      ].join('\n'),
      messages: [{ role: 'user', content: input.text.slice(0, 60_000) }],
      json: true,
      temperature: 0,
      maxTokens: 1500,
    };
  },
  parse(text) {
    const raw = jsonListOrUndefined(text);
    const items: Todo[] = [];
    if (raw) {
      for (const v of raw) {
        if (typeof v === 'string') {
          if (v.trim()) items.push({ text: v.trim() });
          continue;
        }
        if (!v || typeof v !== 'object') continue;
        const o = v as Record<string, unknown>;
        const t = o.text ?? o.task ?? o.title ?? o.todo ?? o.item ?? o.description;
        if (typeof t !== 'string' || !t.trim()) continue;
        const todo: Todo = { text: t.trim() };
        const due = isoDate(o.due ?? o.due_date ?? o.dueDate ?? o.deadline ?? o.date);
        if (due) todo.due = due;
        const done = o.done ?? o.completed ?? o.checked;
        if (done === true || done === 'true') todo.done = true;
        items.push(todo);
      }
    } else {
      for (const line of cleanText(text).split('\n')) {
        const m = LIST_LINE.exec(line);
        if (!m) continue;
        const todo: Todo = { text: m[2]!.replace(/\s*\((?:due|by)[: ]\s*([^)]+)\)\s*$/i, '').trim() };
        const due = /\((?:due|by)[: ]\s*([^)]+)\)\s*$/i.exec(m[2]!);
        const d = due ? isoDate(due[1]) : undefined;
        if (d) todo.due = d;
        if (m[1] && m[1].toLowerCase() === 'x') todo.done = true;
        if (todo.text) items.push(todo);
      }
    }
    const seen = new Set<string>();
    return items.filter((t) => {
      const k = t.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
};

export interface Flashcard {
  q: string;
  a: string;
}

export interface FlashcardsInput {
  text: string;
  title?: string;
  /** Target number of cards (default 10). */
  count?: number;
}

export const makeFlashcards: Skill<FlashcardsInput, Flashcard[]> = {
  id: 'flashcards',
  label: 'Make flashcards',
  description: 'Turns a note into question/answer study cards.',
  build(input) {
    const n = input.count ?? 10;
    return {
      system: [
        `You write study flashcards from notes. Make up to ${n} cards covering the most important facts, definitions and relationships — fewer if the note is short.`,
        'Questions are specific and answerable from the note alone; answers are short (a phrase or one sentence). No duplicates. Use the note\'s language.',
        'Respond with JSON: {"cards": [{"q": string, "a": string}]}.',
      ].join('\n'),
      messages: [{ role: 'user', content: `${input.title ? `Title: ${input.title}\n\n` : ''}${input.text.slice(0, 60_000)}` }],
      json: true,
      temperature: 0.3,
      maxTokens: 2500,
    };
  },
  parse(text, input) {
    const out: Flashcard[] = [];
    const raw = jsonListOrUndefined(text);
    if (raw) {
      for (const v of raw) {
        if (!v || typeof v !== 'object') continue;
        const o = v as Record<string, unknown>;
        const q = o.q ?? o.question ?? o.front ?? o.term ?? o.prompt;
        const a = o.a ?? o.answer ?? o.back ?? o.definition ?? o.response;
        if (typeof q === 'string' && typeof a === 'string' && q.trim() && a.trim()) out.push({ q: q.trim(), a: a.trim() });
      }
    } else {
      const re = /(?:^|\n)\s*(?:\*\*)?(?:Q|Question)\s*\d*(?:\*\*)?\s*[:.]\s*(?:\*\*)?([\s\S]+?)\n\s*(?:\*\*)?(?:A|Answer)\s*\d*(?:\*\*)?\s*[:.]\s*(?:\*\*)?([\s\S]+?)(?=\n\s*\n|\n\s*(?:\*\*)?(?:Q|Question)\s*\d*(?:\*\*)?\s*[:.]|$)/gi;
      for (let m = re.exec(text); m; m = re.exec(text)) out.push({ q: m[1]!.trim(), a: m[2]!.trim() });
    }
    const seen = new Set<string>();
    return out
      .filter((c) => (seen.has(c.q.toLowerCase()) ? false : (seen.add(c.q.toLowerCase()), true)))
      .slice(0, Math.max(1, (input.count ?? 10) * 2));
  },
};

// ---- Answering from notes (RAG) -----------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at by for with about from into over under as is are was were be been being am do does did done have has had having ' +
    'i me my mine we us our you your he she it its they them their this that these those there here what which who whom whose when where why how ' +
    'can could should would will shall may might must not no yes so than too very just also any some all each every more most much many few ' +
    'tell show find give get know say said write wrote written note notes notebook please did anything something thing things'
  ).split(' '),
);

/** Content words of a question, for keyword search ("What did I write about the launch?" → ["launch"]). */
export function keywords(question: string): string[] {
  const words = question
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && (w.length > 1 || /\d/.test(w)) && !STOPWORDS.has(w));
  return [...new Set(words)];
}

export interface RetrievedSource {
  noteId: string;
  title: string;
  pageIndex: number;
  snippet: string;
  score: number;
  /** Note text given to the model (may be truncated). */
  text: string;
}

/**
 * Top-k notes for a question: searches the full keyword query and each keyword alone (the core
 * index requires every token to match), merges scores per note, then reads each note's text.
 */
export async function retrieveNotes(
  host: Pick<NoteToolHost, 'searchNotes' | 'readNote'>,
  question: string,
  opts: { k?: number; maxCharsPerNote?: number } = {},
): Promise<RetrievedSource[]> {
  const k = opts.k ?? 5;
  const maxChars = opts.maxCharsPerNote ?? 4000;
  const kw = keywords(question);
  const queries: Array<{ q: string; w: number }> = [];
  if (kw.length) queries.push({ q: kw.join(' '), w: 2 });
  if (kw.length > 1) for (const w of kw) queries.push({ q: w, w: 1 });
  if (!queries.length && question.trim()) queries.push({ q: question.trim(), w: 1 });
  const merged = new Map<string, { noteId: string; title: string; pageIndex: number; snippet: string; score: number; best: number }>();
  for (const { q, w } of queries) {
    for (const h of await host.searchNotes(q, { limit: Math.max(10, k * 3) })) {
      const cur = merged.get(h.noteId);
      const s = h.score * w;
      if (!cur) merged.set(h.noteId, { noteId: h.noteId, title: h.title, pageIndex: h.pageIndex, snippet: h.snippet, score: s, best: s });
      else {
        cur.score += s;
        if (s > cur.best) Object.assign(cur, { pageIndex: h.pageIndex, snippet: h.snippet, best: s });
      }
    }
  }
  const top = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, k);
  const out: RetrievedSource[] = [];
  for (const t of top) {
    const n = await host.readNote(t.noteId);
    if (!n) continue;
    // The matching page first, then the rest in order.
    const pages = [...n.pages].sort((a, b) => (a.index === t.pageIndex ? -1 : b.index === t.pageIndex ? 1 : a.index - b.index));
    let text = '';
    for (const p of pages) {
      if (!p.text.trim()) continue;
      const chunk = (n.pages.length > 1 ? `(page ${p.index + 1})\n` : '') + p.text.trim() + '\n\n';
      if (text.length + chunk.length > maxChars) {
        text += chunk.slice(0, Math.max(0, maxChars - text.length)) + '…';
        break;
      }
      text += chunk;
    }
    if (!text.trim() && n.meta.summary) text = n.meta.summary;
    out.push({ noteId: t.noteId, title: n.meta.title || t.title || 'Untitled', pageIndex: t.pageIndex, snippet: t.snippet, score: t.score, text: text.trim() });
  }
  return out;
}

export function buildAnswerPrompt(question: string, sources: RetrievedSource[]): SkillPrompt {
  const ctx = sources.map((s, i) => `[${i + 1}] Title: ${s.title}\n${s.text || '(no text)'}`).join('\n\n---\n\n');
  return {
    system: [
      "You answer questions using only the user's own notes, given below.",
      'Cite the note for every fact with its exact title in square brackets, e.g. [Beta launch plan]. Several notes → several citations.',
      "If the notes don't contain the answer, say you couldn't find it in their notes (and mention what related notes do say, if anything). Never use outside knowledge to fill gaps.",
      'Be concise; use bullets for lists.',
    ].join('\n'),
    messages: [{ role: 'user', content: `My notes:\n\n${ctx}\n\n===\n\nQuestion: ${question}` }],
    temperature: 0.2,
    maxTokens: 1000,
  };
}

export interface Citation {
  noteId: string;
  title: string;
}

/** Finds `[Title]` / `[1]` citations in an answer and maps them to sources. */
export function parseCitations(answer: string, sources: RetrievedSource[]): Citation[] {
  const out: Citation[] = [];
  const add = (s: RetrievedSource | undefined) => {
    if (s && !out.some((c) => c.noteId === s.noteId)) out.push({ noteId: s.noteId, title: s.title });
  };
  const norm = (s: string) => s.toLowerCase().replace(/^title:\s*/, '').replace(/["“”]/g, '').trim();
  for (const m of answer.matchAll(/\[([^\][]{1,200})\]/g)) {
    for (const piece of m[1]!.split(/;|,(?=\s*\S)/)) {
      const p = norm(piece);
      if (/^\d+$/.test(p)) add(sources[Number(p) - 1]);
      else add(sources.find((s) => norm(s.title) === p) ?? sources.find((s) => norm(s.title).length > 3 && (p.includes(norm(s.title)) || norm(s.title).includes(p)) && p.length > 3));
    }
  }
  return out;
}

export interface AnswerFromNotesInput {
  question: string;
  host: Pick<NoteToolHost, 'searchNotes' | 'readNote'>;
  /** Notes to retrieve (default 5). */
  k?: number;
}

export interface NotesAnswer {
  answer: string;
  citations: Citation[];
  sources: RetrievedSource[];
}

export const NO_NOTES_ANSWER = "I couldn't find anything about that in your notes.";

/** Retrieval-augmented answer over the user's notes, with `[Note title]` citations. */
export async function answerFromNotes(provider: Provider, model: string, input: AnswerFromNotesInput, opts: RunSkillOptions = {}): Promise<NotesAnswer> {
  const sources = await retrieveNotes(input.host, input.question, { k: input.k });
  if (!sources.length) {
    opts.onText?.(NO_NOTES_ANSWER, NO_NOTES_ANSWER);
    return { answer: NO_NOTES_ANSWER, citations: [], sources };
  }
  const skill: Skill<AnswerFromNotesInput, string> = {
    id: 'answer',
    label: 'Ask my notes',
    description: 'Answers a question from the user\'s notes.',
    build: () => buildAnswerPrompt(input.question, sources),
    parse: (t) => cleanText(t),
  };
  const answer = await runSkill(skill, provider, model, input, opts);
  return { answer, citations: parseCitations(answer, sources), sources };
}

/** All button skills, for UI listing. */
export const SKILLS = { transcribeHandwriting, summarizeNote, extractTodos, makeFlashcards, explainSelection, translate, suggestTitle, suggestTags } as const;
