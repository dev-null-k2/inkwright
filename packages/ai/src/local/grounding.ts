import type { ChatMessage } from '../types.ts';
import type { ToolDef } from '../types.ts';
import type { MemoryHit } from '../tools/memory.ts';
import type { MemoryItem } from '../memory.ts';

/**
 * Retrieval first, for small models.
 *
 * A 1–4B model on a phone does not plan "search, then read, then answer" reliably: asked "what's
 * the budget here?" it either calls a tool in a format nobody parses or asks for more context
 * while the answer is on the page in front of it. So for on-device engines the app gathers the
 * context *before* generation, deterministically — the selection, the page being looked at (its
 * handwriting recognized right then if it wasn't yet), the most relevant other pages, the best
 * hits from every note, and the memory items that matter — and puts it in the prompt as numbered,
 * labelled sources the model cites as [n]. Tools stay for actions (create a note, add a to-do),
 * cut down to a few with short descriptions so they fit a small context window. Cloud models keep
 * the full agent. Everything here is pure, so the evals (packages/ai/evals) run the same prompts
 * against real models that the app sends.
 */

export interface GroundingSource {
  /** Citation number, 1-based. */
  n: number;
  kind: 'selection' | 'page' | 'note' | 'search' | 'memory';
  /** Short label shown to the model and the person: `"Budget", page 2 (this page)`. */
  label: string;
  text: string;
  noteId?: string;
  /** 1-based page. */
  page?: number;
  /** `#mem/…` link to the exact place, when known. */
  link?: string;
}

export interface GroundingPage {
  /** 1-based page number. */
  page: number;
  /** Typed and recognized text of the page ('' when there is none). */
  text: string;
  /** The page has handwriting that could not be turned into text. */
  unreadInk?: boolean;
}

export interface GroundingInput {
  question: string;
  /** The note open in the editor. */
  openNote?: { id: string; title: string; currentPage: number; pages: GroundingPage[] };
  /** What the person lassoed, already recognized. */
  selection?: { page: number; text: string; unreadInk?: boolean };
  /** Search hits over every note (memory index, keyword index). */
  hits?: readonly MemoryHit[];
  /** The app's long-term memory (only `active` items are used). */
  memory?: readonly MemoryItem[];
  /** Characters of context the model can take (see `contextBudget`). */
  budgetChars?: number;
}

export interface Grounding {
  sources: GroundingSource[];
  /** The numbered context block that goes before the question. */
  context: string;
  /** Standing instructions and facts from memory, for the system prompt. */
  memory: string;
  /** Some source has real text. */
  hasContent: boolean;
  /** The current page or the selection has handwriting nothing could read. */
  unreadInk: boolean;
}

const STOP = new Set('a an and are as at be but by can could did do does for from had has have here how i i\'m in is it its me my of on or our please s so tell that the their them there these this to us was we were what whats what\'s when where which who why will with would you your about any some'.split(' '));

/** Lower-case content words of a question (stop words and 1-letter tokens dropped). */
export function questionKeywords(s: string): string[] {
  return [...new Set(s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}$€£%+\-=*/.]+/gu, ' ').split(/\s+/).map((w) => w.replace(/^[.]+|[.]+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w)))];
}

/** How many of the question's keywords (or their prefixes, for plurals) a text contains. */
export function overlap(text: string, words: readonly string[]): number {
  const t = text.toLowerCase();
  return words.reduce((n, w) => n + (t.includes(w) || (w.length > 4 && t.includes(w.slice(0, -1))) ? 1 : 0), 0);
}

/**
 * Characters of context for a model with `contextTokens`, leaving room for the system prompt,
 * the tools, the history and the answer. Roughly 3.2 characters per token for mixed text.
 */
export function contextBudget(contextTokens: number, reserveTokens = 1400): number {
  return Math.max(1200, Math.min(14_000, Math.floor((contextTokens - reserveTokens) * 0.6 * 3.2)));
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`);

/** Memory items for a question: standing instructions always, facts that share a keyword. */
export function relevantMemory(items: readonly MemoryItem[], question: string, maxFacts = 4): MemoryItem[] {
  const words = questionKeywords(question);
  const active = items.filter((i) => i.status === 'active');
  const ins = active.filter((i) => i.kind === 'instruction').slice(0, 4);
  const facts = active
    .filter((i) => i.kind === 'fact')
    .map((i) => ({ i, score: overlap(i.text, words) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFacts)
    .map((x) => x.i);
  return [...ins, ...facts];
}

/** Builds the numbered sources for a question, in priority order, within the budget. */
export function buildGrounding(input: GroundingInput): Grounding {
  const words = questionKeywords(input.question);
  let budget = input.budgetChars ?? 6000;
  const sources: GroundingSource[] = [];
  const add = (s: Omit<GroundingSource, 'n'>) => {
    const text = s.text.trim();
    if (!text || budget < 80) return;
    // The same words already given (a hit on the page we already included): skip.
    if (sources.some((x) => x.text.includes(text.slice(0, 120)))) return;
    const t = clip(text, Math.min(budget, s.kind === 'page' || s.kind === 'selection' ? 4000 : 1200));
    budget -= t.length + s.label.length + 8;
    sources.push({ ...s, text: t, n: sources.length + 1 });
  };
  const note = input.openNote;
  if (input.selection?.text.trim() && note) add({ kind: 'selection', label: `What you selected on page ${input.selection.page} of "${note.title}"`, text: input.selection.text, noteId: note.id, page: input.selection.page });
  if (note) {
    const here = note.pages.find((p) => p.page === note.currentPage);
    if (here?.text.trim()) add({ kind: 'page', label: `"${note.title}", page ${here.page} (the page you are on)`, text: here.text, noteId: note.id, page: here.page });
    const others = note.pages
      .filter((p) => p.page !== note.currentPage && p.text.trim())
      .map((p) => ({ p, score: overlap(p.text, words) }))
      .sort((a, b) => b.score - a.score || Math.abs(a.p.page - note.currentPage) - Math.abs(b.p.page - note.currentPage));
    // Other pages of a short note are all useful; of a long one, only those that match.
    for (const { p, score } of others) if (score > 0 || note.pages.length <= 3) add({ kind: 'note', label: `"${note.title}", page ${p.page}`, text: p.text, noteId: note.id, page: p.page });
  }
  for (const h of input.hits ?? []) {
    if (note && h.noteId === note.id && sources.some((s) => s.noteId === h.noteId && s.page === h.pageIndex + 1 && s.kind !== 'search')) continue;
    add({ kind: 'search', label: `"${h.title}", page ${h.pageIndex + 1}${h.source === 'handwriting' ? ' (handwriting)' : h.source === 'speech' ? ' (recording)' : ''}`, text: h.text, noteId: h.noteId, page: h.pageIndex + 1 });
  }
  const mem = relevantMemory(input.memory ?? [], input.question);
  const memory = mem.length
    ? ['What you know about the user (saved memory):', ...mem.map((m) => `- ${m.kind === 'instruction' ? 'Instruction: ' : ''}${clip(m.text, 300)}`)].join('\n')
    : '';
  const here = note?.pages.find((p) => p.page === note.currentPage);
  const unreadInk = !!(input.selection ? input.selection.unreadInk && !input.selection.text.trim() : here?.unreadInk && !here.text.trim());
  const context = sources.map((s) => `[${s.n}] ${s.label}:\n${s.text}`).join('\n\n');
  return { sources, context, memory, hasContent: sources.length > 0, unreadInk };
}

/** The system prompt for a small model answering from gathered context. */
export function groundedSystemPrompt(opts: { appName?: string; today?: string; memory?: string; hasTools?: boolean; action?: boolean } = {}): string {
  return [
    `You are the assistant in ${opts.appName ?? 'Inkwright'}, a handwriting notes app.${opts.today ? ` Today is ${opts.today}.` : ''}`,
    opts.action ? 'The user asks you to do something with their notes, using the tools below.' : 'The user\'s message starts with numbered context taken from their notes. Answer from it.',
    'Rules:',
    '- If the context answers the question, answer directly in one to three short sentences and cite the source number like [1].',
    '- "Here" or "this page" means the page the user is on. Handwriting was read by a recognizer and can have small errors; read through them ("4000$" is 4000 dollars).',
    '- For sums or questions written in the context (like "2+2="), work out the answer yourself.',
    '- Never ask the user for more context when the context has text. If the context does not contain the answer, say "I couldn\'t find that in your notes" and say what the context does cover.',
    '- Never invent notes, numbers or sources.',
    opts.action ? '- The user asked you to do something: call the matching tool with complete arguments (for a note: a short title and the full text; to-dos as "- [ ] item"). After the tool result, confirm in one sentence what you did.' : '',
    opts.hasTools && !opts.action ? '- Use a tool only when the user asks you to do something (create a note, add a to-do, search for something that is not in the context). Do not use a tool to answer a question the context already answers.' : '',
    opts.memory ?? '',
  ].filter(Boolean).join('\n');
}

/** The user turn: the numbered context, then the question. */
export function groundedUserMessage(question: string, g: Pick<Grounding, 'context' | 'hasContent' | 'unreadInk'> & { sources?: readonly GroundingSource[] }): string {
  const ctx = g.hasContent ? g.context : '(Nothing in the notes matched this question.)';
  const note = g.unreadInk ? '\n(The page has handwriting that could not be read as text yet.)' : '';
  // A question asked on a lasso is about the selection: say so, with its words, so a short
  // "How much" over "2+2=" is read as "what is 2+2".
  const sel = g.sources?.find((s) => s.kind === 'selection');
  const about = sel ? `\n\nI selected this on the page [${sel.n}]: ${sel.text.replace(/\s+/g, ' ').slice(0, 200)}\nMy question is about it.` : '';
  return `Context from my notes:\n${ctx}${note}${about}\n\nQuestion: ${question}`;
}

const ACTION = [
  /^(?:please\s+|can you\s+|could you\s+|would you\s+)?(?:make|create|start|open)\s+(?:me\s+)?(?:a|an)\s+(?:new\s+)?(?:note|list|page|checklist|to-?do)/i,
  /\bnew note\b/i,
  /^(?:please\s+)?add\b.*\b(?:to-?do|task|reminder|item|line|bullet|checklist)\b/i,
  /^(?:please\s+)?(?:add|append|put|write)\b.*\b(?:to|in|on|into)\s+(?:this|the|my|that)\s+(?:note|page|list)\b/i,
  /^(?:please\s+)?(?:save|note down|jot down|write down)\b/i,
  /^(?:please\s+)?remind me\b/i,
  /^(?:please\s+)?(?:tag|rename|retitle)\b/i,
  /^(?:please\s+)?write\b.*\bin ink\b/i,
];

/**
 * Whether the person asked the assistant to *do* something (create a note, add a to-do, save,
 * tag) rather than to answer. Small models given context and a request tend to describe the
 * action ("Here is a new note called Groceries") instead of calling the tool; for these the first
 * turn requires a tool call. Deliberately narrow: "add up these numbers" is a question.
 */
export function isActionRequest(question: string): boolean {
  const q = question.trim();
  if (/^(?:please\s+)?add\s+(?:up|together)\b/i.test(q)) return false;
  return ACTION.some((re) => re.test(q));
}

/** The user turn for an action: the request, and the note it is about (with its id for the tools). */
export function actionUserMessage(request: string, openNote?: { id: string; title: string; currentPage: number; kind?: string } | null, g?: Pick<Grounding, 'context' | 'hasContent'>): string {
  const where = openNote
    ? openNote.kind === 'document'
      ? `The note open on screen is the document "${openNote.title}" (note_id: ${openNote.id}); change it with edit_document (operation "append" to add at the end).\n`
      : `The note open on screen is "${openNote.title}" (note_id: ${openNote.id}), page ${openNote.currentPage}.\n`
    : '';
  const ctx = g?.hasContent ? `Context from my notes, in case the request refers to it:\n${g.context}\n\n` : '';
  return `${ctx}${where}Request: ${request}`;
}

/** Tools a small model is best at, most useful first. Names not offered by the app are skipped. */
export const COMPACT_TOOL_ORDER = ['create_note', 'append_to_note', 'edit_document', 'search_memory', 'search_notes', 'read_note', 'write_in_ink', 'update_note', 'remember'] as const;

/**
 * A reduced tool set sized to the model: 3 tools for a 4k context, 5 up to 8k, 7 above, with
 * descriptions cut to their first sentence (small models read long tool lists badly, and every
 * description costs context). `search_notes` is dropped when `search_memory` is there.
 */
export function compactTools<T extends ToolDef>(tools: readonly T[], contextTokens: number, opts: { document?: boolean } = {}): T[] {
  const max = contextTokens <= 4096 ? 3 : contextTokens <= 8192 ? 5 : 7;
  const names = new Set(tools.map((t) => t.name));
  const picked: T[] = [];
  // On a document note, edit_document is how text is added (append_to_note doesn't work there);
  // elsewhere it only earns a place in larger windows.
  const order = opts.document ? ['edit_document', ...COMPACT_TOOL_ORDER.filter((n) => n !== 'edit_document' && n !== 'append_to_note')] : COMPACT_TOOL_ORDER.filter((n) => n !== 'edit_document' || max > 3);
  for (const name of order) {
    if (picked.length >= max) break;
    if (name === 'search_notes' && names.has('search_memory')) continue;
    const t = tools.find((x) => x.name === name);
    if (t) picked.push(shortDescription(t));
  }
  return picked;
}

function shortDescription<T extends ToolDef>(t: T): T {
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(t.description)?.[0] ?? t.description;
  const props = (t.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((t.parameters.required as string[] | undefined) ?? []);
  const slim: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(props)) {
    // Optional ids (a notebook to file into) need a lookup small models skip: they invent
    // "groceries_notebook" and the call fails. Leave them out; the tool's default applies.
    if (!required.has(k) && (/_id$|Id$/.test(k) || v.type === 'object')) continue;
    const { description, ...rest } = v;
    slim[k] = typeof description === 'string' ? { ...rest, description: clip(description, 80) } : rest;
  }
  const keep = new Set(Object.keys(slim));
  // Extra arguments are dropped below rather than rejected, so a stray one doesn't fail the call.
  const { additionalProperties: _strict, ...params } = t.parameters;
  const out: T = { ...t, description: clip(first, 160), parameters: { ...params, properties: slim } };
  // An agent tool keeps working, with any argument outside the slim schema dropped before it runs.
  const exec = (t as unknown as { execute?: (a: Record<string, unknown>, ctx: unknown) => unknown }).execute;
  if (typeof exec === 'function') {
    (out as unknown as { execute: (a: Record<string, unknown>, ctx: unknown) => unknown }).execute = (a, ctx) =>
      exec.call(t, Object.fromEntries(Object.entries(a ?? {}).filter(([k]) => keep.has(k))), ctx);
  }
  return out;
}

/**
 * Earlier turns for a small model: plain user/assistant text only (tool calls and results of
 * earlier turns are dropped — their outcome is in the assistant's reply), the last `maxTurns`
 * messages, each cut to `maxChars`. The newest turns matter most for follow-ups.
 */
export function condenseHistory(messages: readonly ChatMessage[], opts: { maxTurns?: number; maxChars?: number } = {}): ChatMessage[] {
  const maxTurns = opts.maxTurns ?? 8;
  const maxChars = opts.maxChars ?? 600;
  const plain: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).trim();
    if (!text || m.role === 'user' && /^<tool_result/.test(text)) continue;
    const prev = plain[plain.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = clip(`${prev.content as string}\n${text}`, maxChars);
      continue;
    }
    plain.push({ role: m.role, content: clip(text, maxChars) });
  }
  const recent = plain.slice(-maxTurns);
  while (recent[0]?.role === 'assistant') recent.shift();
  return recent;
}

const DEFLECT = /(provide|give|share)( me)? (more|additional|some) (context|information|details)|could you (please )?(clarify|provide|specify)|i (don'?t|do not|cannot|can'?t) (have access|see|access)|as an ai|i'?m not sure what you(?:'re| are) (asking|referring)/i;

/** The reply dodges the question (asks for context, claims no access) or is empty. */
export function isDeflection(reply: string): boolean {
  return !reply.trim() || DEFLECT.test(reply);
}

/**
 * What to say when the model gave nothing usable although the context has text: the passage that
 * best matches the question, quoted and cited, so the person still gets their answer.
 */
export function extractiveAnswer(question: string, g: Pick<Grounding, 'sources'>): string | null {
  if (!g.sources.length) return null;
  const words = questionKeywords(question);
  // Single lines and pairs of neighbouring lines (a heading and its value: "Budget" / "Car 4000$").
  const lines = g.sources.flatMap((s) => {
    const ls = s.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const cands = [...ls, ...ls.slice(0, -1).map((l, i) => `${l} ${ls[i + 1]}`).filter((c) => c.length <= 200)];
    const bonus = s.kind === 'selection' ? 0.5 : s.kind === 'page' ? 0.25 : 0;
    return cands.map((line) => ({ s, line, score: overlap(line, words) + bonus + (/\d/.test(line) && /\b(how much|how many|budget|cost|price|total|amount|when|date|time|number)\b/i.test(question) ? 0.5 : 0) }));
  });
  const best = lines.filter((l) => l.line).sort((a, b) => b.score - a.score)[0];
  if (!best || (best.score < 1 && best.s.kind !== 'selection' && best.s.kind !== 'page')) return null;
  return `Here is what your notes say: “${clip(best.line, 240)}” [${best.s.n}]`;
}

/** The plain answer when nothing relevant was found, with what to do next. */
export function nothingFoundReply(g: Pick<Grounding, 'unreadInk' | 'hasContent'>): string {
  if (g.unreadInk) return 'I couldn’t read the handwriting here yet, so I can’t answer from it. Use “Transcribe page” in the assistant, or write a little larger, then ask again.';
  return 'I couldn’t find that in your notes. Try other words, or open the note it’s in and ask from there.';
}
