/**
 * Real-model evals for the on-device assistant (the cases and the two flows). A real small model
 * (Qwen3 1.7B by default, q4 on the CPU through transformers.js — the app's own engine code, see
 * node-engine.ts) answers the questions that failed on the founder's phone, through two flows:
 *
 *  - `before`: the assistant as it was at 8ccf6be — the full notes agent (long system prompt, every
 *    note tool), handwriting not recognized before asking ("(handwriting not yet transcribed)"), a
 *    lasso sent as an image the text-only model never sees, and the Hermes-only tool parser;
 *  - `after`: retrieval first (packages/ai/src/local/grounding.ts) — the page and selection as
 *    recognized text, search hits and memory as numbered sources, a compact tool set, the
 *    multi-dialect parser and the answer guardrails.
 *
 * Run it with `npm run eval:local` (run-local-model.ts; see docs/LOCAL_AI.md › Real-model evals).
 */
import { MemoryCorpus, chunkNote, hybridSearch, pageText } from '@inkwright/core';
import {
  CallbackProvider,
  MemoryNoteToolHost,
  ThinkFilter,
  buildGrounding,
  contextBudget,
  createLocalProvider,
  createMemoryTools,
  createNoteTools,
  memoryPromptSection,
  notesAgentSystemPrompt,
  parseToolCalls,
  runAgent,
  runGroundedTurn,
  stripThinking,
  toLocalMessages,
  type AgentTool,
  type ChatMessage,
  type MemoryHit,
  type MemoryItem,
  type Provider,
} from '../src/index.ts';
import { withLegacyPromptTools } from './legacy-prompt-tools.ts';
import { nodeModelRef, type NodeEngine } from './node-engine.ts';

export interface EvalSettings {
  /** Catalog id of the chat model (qwen3-1.7b, qwen3-0.6b, …). */
  model: string;
  /** Context window to budget for, tokens (4096 is a phone engine's window). */
  context: number;
}
const NOW = new Date('2026-11-02T10:00:00Z');

interface SeedNote { title: string; text: string; handwritten?: boolean }

export interface Case {
  id: string;
  what: string;
  question: string;
  /** Notes in the vault. The first is open in the editor when `open` is set. */
  notes: SeedNote[];
  open?: boolean;
  /** A lasso over handwriting (its recognized text). */
  selection?: string;
  memory?: Array<Pick<MemoryItem, 'kind' | 'text'>>;
  history?: ChatMessage[];
  pass: (r: Run) => boolean;
}

export interface Run {
  reply: string;
  rawTurns: string[];
  tools: Array<{ name: string; args: Record<string, unknown>; ok: boolean }>;
  host: MemoryNoteToolHost;
  ids: string[];
}

const has = (re: RegExp) => (r: Run) => re.test(r.reply);
const noteText = async (h: MemoryNoteToolHost, id: string) => (await h.vault.readPages((await h.vault.readNote(id))!)).map(pageText).join('\n');

export const CASES: Case[] = [
  { id: 'page-budget', what: 'answer from the handwriting on the open page', question: 'What\'s the budget here?', open: true, notes: [{ title: 'Budget', text: 'Budget\nCar 4000$', handwritten: true }], pass: has(/4[,.]?000/) },
  { id: 'page-total', what: 'answer from typed text on the page', question: 'How much do I spend on rent and food together?', open: true, notes: [{ title: 'Monthly', text: 'Rent 1200\nFood 350\nPhone 40' }], pass: has(/1[,.]?550/) },
  { id: 'lasso-sum', what: 'arithmetic in a lasso selection', question: 'How much', open: true, selection: '2+2=', notes: [{ title: 'Scratch', text: '2+2=', handwritten: true }], pass: (r) => /\b4\b|\bfour\b/i.test(r.reply) && !/provide more context/i.test(r.reply) },
  { id: 'lasso-mult', what: 'a sum written by hand, "solve this"', question: 'Solve this', open: true, selection: '12 x 3 =', notes: [{ title: 'Homework', text: '12 x 3 =', handwritten: true }], pass: has(/\b36\b/) },
  { id: 'search-notes', what: 'find the answer in another note', question: 'I had written a budget, what is it for car', notes: [{ title: 'Groceries', text: 'milk, eggs, bread' }, { title: 'Budget 2026', text: 'Budget\nCar 4000$\nHoliday 1500$', handwritten: true }, { title: 'Lecture 3', text: 'Photosynthesis turns light into chemical energy.' }], pass: has(/4[,.]?000/) },
  {
    id: 'create-note', what: 'create a note with a tool', question: 'Make a new note called Groceries with milk and eggs', notes: [{ title: 'Budget', text: 'Car 4000$' }],
    pass: (r) => r.tools.some((t) => t.name === 'create_note' && t.ok && /grocer/i.test(String(t.args.title)) && /milk/i.test(String(t.args.text)) && /egg/i.test(String(t.args.text))),
  },
  {
    id: 'add-todo', what: 'add a to-do to the open note', question: 'Add a to-do to this note: call the hotel', open: true, notes: [{ title: 'Trip to Lisbon', text: 'Flights booked for March 3.' }],
    pass: (r) => r.tools.some((t) => t.name === 'append_to_note' && t.ok && /hotel/i.test(String(t.args.text))),
  },
  {
    id: 'follow-up', what: 'a follow-up that needs the previous turn', question: 'And what is half of that?', open: true, notes: [{ title: 'Budget', text: 'Budget\nCar 4000$', handwritten: true }],
    history: [{ role: 'user', content: 'What\'s the budget here?' }, { role: 'assistant', content: 'Your car budget is 4000$ [1].' }], pass: has(/2[,.]?000/),
  },
  {
    id: 'no-hallucination', what: 'say so when the notes don\'t have it', question: 'What time is my dentist appointment?', open: true, notes: [{ title: 'Lecture 3', text: 'Photosynthesis turns light into chemical energy in the chloroplasts.' }],
    pass: (r) => !/\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b/i.test(r.reply) && /(couldn.?t|could not|can.?t|cannot|don.?t|do not|didn.?t|no)\b.{0,40}(find|see|mention|information|appointment)|not (in|mentioned)/i.test(r.reply),
  },
  { id: 'memory', what: 'use long-term memory', question: 'What is my sister called?', notes: [{ title: 'Ideas', text: 'Start a herb garden.' }], memory: [{ kind: 'fact', text: 'The user\'s sister is called Mira.' }, { kind: 'fact', text: 'The user prefers metric units.' }], pass: has(/Mira/) },
  { id: 'explain-page', what: 'no "provide more context" when the page has content', question: 'Explain this', open: true, notes: [{ title: 'Biology', text: 'Mitochondria are the powerhouse of the cell.\nThey make ATP.', handwritten: true }], pass: (r) => /mitochondri|ATP|energy/i.test(r.reply) && !/provide more context|clarify/i.test(r.reply) },
];

export const RAW_SYNTAX = /<\|?tool_call|tool_call\|>|<\/?tool_call>|\[TOOL_CALLS\]|<\|python_tag\|>|call:[a-z_]+\{/;

// ---- The two flows ------------------------------------------------------------------------------

async function seed(c: Case) {
  let t = NOW.getTime() - 86_400_000;
  const host = await MemoryNoteToolHost.create({ clock: () => (t += 1000) });
  const ids: string[] = [];
  for (const n of c.notes) ids.push((await host.createNote({ title: n.title, text: n.text })).id);
  return { host, ids };
}

async function searchHost(host: MemoryNoteToolHost) {
  const corpus = new MemoryCorpus();
  for (const n of await host.vault.listNotes()) corpus.setNote(n.id, chunkNote(n, await host.vault.readPages(n)));
  return {
    searchMemory: async (q: string, o: { limit?: number; noteId?: string } = {}): Promise<MemoryHit[]> =>
      hybridSearch(corpus, q, { limit: o.limit ?? 6, noteId: o.noteId, noteHits: host.index.search(q, { limit: 20 }) }).map((r) => ({ noteId: r.chunk.noteId, title: r.chunk.title, pageIndex: r.chunk.pageIndex, source: r.chunk.source, text: r.chunk.text, score: r.score })),
  };
}

const memItems = (c: Case): MemoryItem[] => (c.memory ?? []).map((m, i) => ({ id: `m${i}`, ...m, status: 'active', source: 'user', createdAt: 0, updatedAt: 0 }));

/** The on-device provider over the Node engine, with the old (Hermes-only) tool protocol. */
function legacyLocalProvider(engine: NodeEngine, s: EvalSettings): Provider {
  const ref = nodeModelRef(s.model);
  const CONTEXT = s.context;
  return withLegacyPromptTools(new CallbackProvider({
    id: 'on-device', label: 'On this device', capabilities: { vision: false, tools: false, streaming: true, listModels: false, json: false },
    handler: async (req, emit) => {
      const maxTokens = Math.min(req.maxTokens ?? 1024, Math.floor(CONTEXT / 2));
      const messages = toLocalMessages(req.messages, { budgetTokens: CONTEXT - maxTokens - 64 });
      const f = new ThinkFilter((s) => emit({ type: 'text', delta: s }));
      const r = await engine.generate(ref, { messages, maxTokens, temperature: req.temperature }, (d) => f.push(d));
      f.end();
      return { text: stripThinking(r.text).trim() };
    },
  }));
}

/** Records what the model wrote, turn by turn, before any parsing. */
function recording(p: Provider, raw: string[]): Provider {
  return { ...p, chat: async (req, on) => { let s = ''; const r = await p.chat(req, (e) => { if (e.type === 'text') s += e.delta; on?.(e); }); raw.push(s || r.text); return r; } };
}

export async function runBefore(c: Case, engine: NodeEngine, s: EvalSettings): Promise<Run> {
  const { host, ids } = await seed(c);
  const tools: AgentTool[] = [...createNoteTools(host, { exclude: ['get_page_image'] }), ...createMemoryTools(await searchHost(host))];
  const open = c.open ? c.notes[0]! : null;
  // As the panel built it: unrecognized handwriting shows as a placeholder; the lasso was an image.
  const pageCtx = open ? `The user has this note open: "${open.title}" (id ${ids[0]}, 1 pages, currently on page 1).\n--- Page 1 ---\n${open.handwritten ? '(handwriting not yet transcribed)' : open.text}` : '';
  const system = notesAgentSystemPrompt({ appName: 'Inkwright', now: NOW, extra: [memoryPromptSection(memItems(c)), pageCtx].filter(Boolean).join('\n\n') });
  const raw: string[] = [];
  const res = await runAgent({ provider: recording(legacyLocalProvider(engine, s), raw), model: s.model, system, messages: [...(c.history ?? []), { role: 'user', content: c.question }], tools, maxSteps: 5 });
  return { reply: res.text, rawTurns: raw, tools: res.toolRuns.map((t) => ({ name: t.call.name, args: t.call.arguments, ok: t.ok })), host, ids };
}

export async function runAfter(c: Case, engine: NodeEngine, s: EvalSettings): Promise<Run> {
  const CONTEXT = s.context;
  const { host, ids } = await seed(c);
  const search = await searchHost(host);
  const tools: AgentTool[] = [...createNoteTools(host, { exclude: ['get_page_image'] }), ...createMemoryTools(search)];
  const open = c.open ? c.notes[0]! : null;
  // Recognition runs before asking (lib/assistant/context.ts); here the recognizer is exact.
  const grounding = buildGrounding({
    question: c.question,
    ...(open ? { openNote: { id: ids[0]!, title: open.title, currentPage: 1, pages: [{ page: 1, text: open.text }] } } : {}),
    ...(c.selection ? { selection: { page: 1, text: c.selection } } : {}),
    hits: await search.searchMemory(c.question, { limit: 4 }),
    memory: memItems(c),
    budgetChars: contextBudget(CONTEXT),
  });
  const raw: string[] = [];
  const provider = recording(createLocalProvider(engine, nodeModelRef(s.model), { contextTokens: CONTEXT }), raw);
  const res = await runGroundedTurn({ provider, model: s.model, question: c.question, openNote: open ? { id: ids[0]!, title: open.title, currentPage: 1 } : null, history: c.history ?? [], grounding, tools, contextTokens: CONTEXT, today: NOW.toISOString().slice(0, 10) });
  return { reply: res.text, rawTurns: raw, tools: res.agent.toolRuns.map((t) => ({ name: t.call.name, args: t.call.arguments, ok: t.ok })), host, ids };
}

// ---- Running and reporting ----------------------------------------------------------------------

export interface EvalResult { flow: 'before' | 'after'; id: string; pass: boolean; rawSyntaxShown: boolean; reply: string; tools: string[]; rawTurns: string[]; ms: number; error?: string }

/** Runs one case through one flow and scores it (a thrown error is a failed case). */
export async function evaluate(flow: 'before' | 'after', c: Case, engine: NodeEngine, s: EvalSettings): Promise<EvalResult> {
  const t0 = Date.now();
  let r: Run | null = null;
  let error: string | undefined;
  try {
    r = flow === 'before' ? await runBefore(c, engine, s) : await runAfter(c, engine, s);
  } catch (e) {
    error = (e as Error).message;
  }
  const reply = r?.reply ?? '';
  const rawSyntaxShown = RAW_SYNTAX.test(reply);
  return {
    flow, id: c.id, pass: !!r && !rawSyntaxShown && c.pass(r), rawSyntaxShown, reply: reply.slice(0, 400),
    tools: r?.tools.map((t) => `${t.name}${t.ok ? '' : ' (failed)'}`) ?? [], rawTurns: (r?.rawTurns ?? []).map((t) => t.slice(0, 400)), ms: Date.now() - t0, ...(error ? { error } : {}),
  };
}

export function describeResult(r: EvalResult): string {
  return `[${r.flow}] ${r.id}: ${r.pass ? 'PASS' : 'FAIL'} (${(r.ms / 1000).toFixed(0)} s) tools=[${r.tools.join(', ')}] reply=${JSON.stringify(r.reply.slice(0, 200))}${r.error ? ` error=${r.error}` : ''}`;
}

/** Pass rates per flow and a per-case table. */
export function summarize(results: readonly EvalResult[], s: EvalSettings): string {
  const flows = [...new Set(results.map((r) => r.flow))];
  const lines = flows.map((f) => {
    const rs = results.filter((r) => r.flow === f);
    const n = rs.filter((r) => r.pass).length;
    return `${f}: ${n}/${rs.length} passed (${rs.length ? Math.round((100 * n) / rs.length) : 0}%); raw tool syntax shown in ${rs.filter((r) => r.rawSyntaxShown).length}`;
  });
  const ids = [...new Set(results.map((r) => r.id))];
  const table = ids.map((id) => `  ${id.padEnd(18)} ${flows.map((f) => `${f}: ${results.find((r) => r.flow === f && r.id === id)?.pass ? 'pass' : 'FAIL'}`).join('   ')}`);
  return [`${s.model}, ${s.context}-token context`, ...lines, ...table].join('\n');
}
