/**
 * Agent session journals: transcripts from coding agents become readable notes, and the lessons
 * worth keeping become lines in an AGENTS.md note — proposed by an AI, accepted by the user.
 *
 * Formats read (all local files the user picks; nothing is fetched):
 * - **Claude Code** — `~/.claude/projects/<project>/<session>.jsonl`: one JSON object per line,
 *   `type` `user` | `assistant` | `summary` (| `system`, snapshots — skipped), with `message.content`
 *   a string or blocks (`text`, `thinking`, `tool_use {id,name,input}`, `tool_result
 *   {tool_use_id,content,is_error}`), plus `timestamp`, `cwd`, `gitBranch`, `sessionId`.
 * - **Codex CLI** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`: `{timestamp, type, payload}`
 *   lines; `session_meta` (id, cwd, git), `response_item` payloads `message {role, content:
 *   [{type: input_text|output_text, text}]}`, `function_call {name, arguments, call_id}`,
 *   `function_call_output {call_id, output}`. Older rollouts have the payloads as the lines.
 * - **Gemini CLI** — `~/.gemini/tmp/<project>/chats/session-*.json`: one JSON document
 *   `{sessionId, startTime, lastUpdated, messages: [{type: user|gemini|info|error|warning,
 *   content, toolCalls?: [{name, args, result?, status?}], timestamp}]}`.
 */
import type { VaultFS } from '../fs.ts';

export type SessionTool = 'claude-code' | 'codex' | 'gemini';

export interface SessionTurn {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at?: number;
  tool?: { name: string; input?: string; output?: string; error?: boolean };
}

export interface AgentSession {
  tool: SessionTool;
  id: string;
  title: string;
  startedAt?: number;
  endedAt?: number;
  cwd?: string;
  branch?: string;
  model?: string;
  turns: SessionTurn[];
}

export const SESSION_TOOL_NAMES: Record<SessionTool, string> = { 'claude-code': 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' };

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const time = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(t) ? t : undefined; };
const short = (v: unknown, n = 600) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? `${s.slice(0, n)}…` : s ?? ''; };

function jsonLines(text: string): J[] {
  const out: J[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const v = JSON.parse(t); if (isObj(v)) out.push(v); } catch { /* a torn last line while the agent was writing */ }
  }
  return out;
}

/** Which agent wrote a transcript, from its shape. */
export function detectSessionTool(text: string): SessionTool | null {
  const head = text.trimStart();
  if (head.startsWith('{') && !head.slice(0, 4000).includes('\n{')) {
    try { const d = JSON.parse(text); if (isObj(d) && Array.isArray(d.messages)) return 'gemini'; } catch { /* JSONL */ }
  }
  const lines = jsonLines(text.slice(0, 200_000)).slice(0, 50);
  if (lines.some((l) => 'payload' in l && typeof l.type === 'string') || lines.some((l) => l.type === 'message' && 'role' in l)) return 'codex';
  if (lines.some((l) => (l.type === 'user' || l.type === 'assistant') && isObj(l.message))) return 'claude-code';
  if (lines.some((l) => l.type === 'summary' && 'leafUuid' in l)) return 'claude-code';
  return null;
}

/** Text of Claude/Gemini content: a string, or blocks/parts with `text`. */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : isObj(p) && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  return '';
}

/** Harness noise that is not what anyone said (injected context, command echoes). */
const NOISE = /^\s*<(environment_context|user_instructions|system-reminder|local-command-stdout|local-command-stderr|command-message)>/;

function parseClaude(text: string, fallbackId: string): AgentSession {
  const s: AgentSession = { tool: 'claude-code', id: fallbackId, title: '', turns: [] };
  const pending = new Map<string, SessionTurn>();
  let summary = '';
  for (const l of jsonLines(text)) {
    if (l.type === 'summary') { summary ||= str(l.summary) ?? ''; continue; }
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    if (l.isSidechain === true || l.isMeta === true) continue;
    const at = time(l.timestamp);
    if (at) { s.startedAt ??= at; s.endedAt = at; }
    s.id = str(l.sessionId) ?? s.id;
    s.cwd ??= str(l.cwd);
    s.branch ??= str(l.gitBranch) || undefined;
    const msg = isObj(l.message) ? l.message : {};
    s.model ??= str(msg.model);
    const content = msg.content;
    if (typeof content === 'string') {
      if (!NOISE.test(content)) s.turns.push({ role: l.type, text: commandText(content), at });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !NOISE.test(b.text)) s.turns.push({ role: l.type, text: commandText(b.text), at });
      else if (b.type === 'tool_use') {
        const turn: SessionTurn = { role: 'tool', text: '', at, tool: { name: str(b.name) ?? 'tool', input: short(b.input) } };
        s.turns.push(turn);
        if (typeof b.id === 'string') pending.set(b.id, turn);
      } else if (b.type === 'tool_result') {
        const t = typeof b.tool_use_id === 'string' ? pending.get(b.tool_use_id) : undefined;
        if (t?.tool) { t.tool.output = short(contentText(b.content)); if (b.is_error === true) t.tool.error = true; }
      }
    }
  }
  s.title = summary || firstUserLine(s) || 'Claude Code session';
  return s;
}

/** `<command-name>/review</command-name>…` → `/review …` */
function commandText(t: string): string {
  const m = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (!m) return t;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1]?.trim();
  return `${m[1]!.trim()}${args ? ` ${args}` : ''}`;
}

function parseCodex(text: string, fallbackId: string): AgentSession {
  const s: AgentSession = { tool: 'codex', id: fallbackId, title: '', turns: [] };
  const calls = new Map<string, SessionTurn>();
  const fallbackMsgs: SessionTurn[] = [];
  let sawMessages = false;
  for (const l of jsonLines(text)) {
    const at = time(l.timestamp);
    if (at) { s.startedAt ??= at; s.endedAt = at; }
    const type = str(l.type);
    const p = isObj(l.payload) ? l.payload : l;
    if (type === 'session_meta') {
      s.id = str(p.id) ?? str(p.session_id) ?? s.id;
      s.cwd ??= str(p.cwd);
      const git = isObj(p.git) ? p.git : {};
      s.branch ??= str(git.branch);
      s.startedAt = time(p.timestamp) ?? s.startedAt;
      continue;
    }
    if (type === 'turn_context') { s.model ??= str(p.model); continue; }
    if (type === 'event_msg') {
      // The same words as response items; kept only for rollouts that lack those.
      if (p.type === 'user_message' && typeof p.message === 'string') fallbackMsgs.push({ role: 'user', text: p.message, at });
      if (p.type === 'agent_message' && typeof p.message === 'string') fallbackMsgs.push({ role: 'assistant', text: p.message, at });
      continue;
    }
    if (type && type !== 'response_item' && type !== 'message' && type !== 'function_call' && type !== 'function_call_output') continue;
    if (p.type === 'message') {
      const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null;
      const t = Array.isArray(p.content) ? p.content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('\n').trim() : contentText(p.content);
      if (role && t && !NOISE.test(t)) { s.turns.push({ role, text: t, at }); sawMessages = true; }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input = str(p.arguments) ?? str(p.input) ?? short(p.action);
      try { const a = JSON.parse(input ?? ''); input = isObj(a) && 'command' in a ? short(Array.isArray(a.command) ? a.command.join(' ') : a.command) : short(a); } catch { /* keep text */ }
      const turn: SessionTurn = { role: 'tool', text: '', at, tool: { name: str(p.name) ?? 'shell', input: short(input) } };
      s.turns.push(turn);
      const id = str(p.call_id);
      if (id) calls.set(id, turn);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const t = calls.get(str(p.call_id) ?? '');
      let out = p.output;
      if (typeof out === 'string') { try { const o = JSON.parse(out); if (isObj(o) && 'output' in o) out = o.output; } catch { /* plain */ } }
      if (t?.tool) t.tool.output = short(isObj(out) && 'content' in out ? out.content : out);
    }
  }
  if (!sawMessages) s.turns.unshift(...fallbackMsgs);
  s.title = firstUserLine(s) || 'Codex session';
  return s;
}

function parseGemini(text: string, fallbackId: string): AgentSession {
  const d = JSON.parse(text) as J;
  const s: AgentSession = { tool: 'gemini', id: str(d.sessionId) ?? fallbackId, title: '', turns: [], startedAt: time(d.startTime), endedAt: time(d.lastUpdated) };
  for (const m of Array.isArray(d.messages) ? d.messages : []) {
    if (!isObj(m)) continue;
    const at = time(m.timestamp);
    const t = contentText(m.content).trim();
    if (m.type === 'user' && t) s.turns.push({ role: 'user', text: t, at });
    else if (m.type === 'gemini' || m.type === 'model') {
      s.model ??= str(m.model);
      if (t) s.turns.push({ role: 'assistant', text: t, at });
      for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        if (!isObj(c)) continue;
        const result = Array.isArray(c.result) ? c.result.map((r) => (isObj(r) && isObj(r.functionResponse) ? short(isObj(r.functionResponse.response) ? r.functionResponse.response.output ?? r.functionResponse.response : r.functionResponse) : short(r))).join('\n') : c.result != null ? short(c.result) : undefined;
        s.turns.push({ role: 'tool', text: '', at, tool: { name: str(c.displayName) ?? str(c.name) ?? 'tool', input: short(c.args), ...(result ? { output: result } : {}), ...(c.status === 'error' ? { error: true } : {}) } });
      }
    }
  }
  s.title = str(d.summary) || firstUserLine(s) || 'Gemini CLI session';
  return s;
}

function firstUserLine(s: AgentSession): string {
  const t = s.turns.find((x) => x.role === 'user' && x.text.trim())?.text.trim().split('\n')[0] ?? '';
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

/** Parses a transcript file of any supported agent. Throws with a plain explanation when it is none of them. */
export function parseAgentSession(fileName: string, text: string): AgentSession {
  const id = fileName.replace(/^.*[\\/]/, '').replace(/\.(jsonl|json)$/i, '');
  const tool = detectSessionTool(text);
  if (tool === 'gemini') return parseGemini(text, id);
  if (tool === 'codex') return parseCodex(text, id);
  if (tool === 'claude-code') return parseClaude(text, id);
  throw new Error(`${fileName} is not a Claude Code, Codex CLI or Gemini CLI session transcript.`);
}

const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '');

/** A session as a readable note: who asked what, what the agent did (tools collapsed to one line each), what it said. */
export function sessionToMarkdown(s: AgentSession, o: { maxText?: number } = {}): string {
  const max = o.maxText ?? 4000;
  const cut = (t: string) => (t.length > max ? `${t.slice(0, max)}…` : t);
  const meta = [`${SESSION_TOOL_NAMES[s.tool]} session`, s.startedAt ? day(s.startedAt) : '', s.cwd ? `in ${s.cwd}` : '', s.branch ? `on ${s.branch}` : '', s.model ? `· ${s.model}` : ''].filter(Boolean).join(' ');
  const out: string[] = [`# ${s.title}`, '', meta, ''];
  let tools: string[] = [];
  const flush = () => {
    if (!tools.length) return;
    out.push(...tools, '');
    tools = [];
  };
  for (const t of s.turns) {
    if (t.role === 'tool' && t.tool) {
      const io = t.tool.input ? ` \`${t.tool.input.replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 160)}\`` : '';
      tools.push(`- ${t.tool.error ? '✗' : '·'} ${t.tool.name}${io}${t.tool.error && t.tool.output ? ` — ${t.tool.output.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      continue;
    }
    flush();
    out.push(`## ${t.role === 'user' ? 'You' : 'Agent'}${t.at ? ` · ${day(t.at).slice(11)}` : ''}`, '', cut(t.text.trim()), '');
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** A session in a compact form for a model reading it to find lessons. */
export function sessionDigest(s: AgentSession, maxChars = 24_000): string {
  const parts: string[] = [];
  for (const t of s.turns) {
    if (t.role === 'tool' && t.tool) parts.push(`[tool ${t.tool.name}${t.tool.error ? ' FAILED' : ''}] ${(t.tool.input ?? '').slice(0, 200)}${t.tool.error && t.tool.output ? ` → ${t.tool.output.slice(0, 300)}` : ''}`);
    else parts.push(`${t.role === 'user' ? 'USER' : 'AGENT'}: ${t.text.slice(0, 1500)}`);
  }
  let text = parts.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars / 2)}\n…\n${text.slice(-maxChars / 2)}`;
  return text;
}

// ---- Lessons -----------------------------------------------------------------------------------

/** A durable lesson an AI proposed from a session; the user accepts it into AGENTS.md or dismisses it. */
export interface LessonProposal {
  id: string;
  text: string;
  /** Why it is worth keeping (what went wrong or right in the session). */
  why?: string;
  /** The session note it came from. */
  noteId?: string;
  noteTitle?: string;
  status: 'proposed' | 'accepted' | 'dismissed';
  createdAt: number;
  decidedAt?: number;
}

export const LESSONS_PATH = 'ai/lessons.json';

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** `ai/lessons.json`: lesson proposals waiting for the user, and what they decided. */
export class LessonStore {
  constructor(private fs: VaultFS, private clock: () => number = Date.now, private newId: () => string = () => Math.random().toString(36).slice(2, 12)) {}

  async list(): Promise<LessonProposal[]> {
    const raw = await this.fs.readText(LESSONS_PATH);
    if (!raw) return [];
    try {
      const d = JSON.parse(raw) as { items?: LessonProposal[] };
      return Array.isArray(d.items) ? d.items.filter((x) => x && typeof x.text === 'string') : [];
    } catch {
      return [];
    }
  }

  private async save(items: LessonProposal[]) {
    // Keep decided ones for a while (they stop the same lesson being proposed again), newest 300.
    await this.fs.writeText(LESSONS_PATH, JSON.stringify({ version: 1, items: items.slice(-300) }, null, 2));
  }

  /** Adds proposals, skipping ones already proposed, accepted or dismissed (same words). */
  async propose(lessons: readonly { text: string; why?: string }[], from?: { noteId?: string; noteTitle?: string }): Promise<LessonProposal[]> {
    const items = await this.list();
    const known = new Set(items.map((x) => norm(x.text)));
    const added: LessonProposal[] = [];
    for (const l of lessons) {
      const text = l.text.trim().replace(/\s+/g, ' ').slice(0, 400);
      if (!text || known.has(norm(text))) continue;
      known.add(norm(text));
      const p: LessonProposal = { id: this.newId(), text, ...(l.why ? { why: l.why.trim().slice(0, 300) } : {}), ...(from?.noteId ? { noteId: from.noteId } : {}), ...(from?.noteTitle ? { noteTitle: from.noteTitle } : {}), status: 'proposed', createdAt: this.clock() };
      items.push(p);
      added.push(p);
    }
    if (added.length) await this.save(items);
    return added;
  }

  async decide(id: string, accept: boolean): Promise<LessonProposal | null> {
    const items = await this.list();
    const p = items.find((x) => x.id === id);
    if (!p || p.status !== 'proposed') return null;
    p.status = accept ? 'accepted' : 'dismissed';
    p.decidedAt = this.clock();
    await this.save(items);
    return p;
  }
}

/**
 * The Markdown to append to an AGENTS.md note for accepted lessons: only lessons not already in
 * it, under a dated heading. Null when there is nothing new.
 */
export function lessonsToAppend(existing: string, lessons: readonly string[], date: Date): string | null {
  const have = norm(existing);
  const fresh = [...new Set(lessons.map((l) => l.trim()).filter((l) => l && !have.includes(norm(l))))];
  if (!fresh.length) return null;
  return `## Lessons · ${date.toISOString().slice(0, 10)}\n\n${fresh.map((l) => `- ${l}`).join('\n')}`;
}

/** What the starting AGENTS.md note says (it is a normal note; agents read it as instructions). */
export const AGENTS_MD_INTRO = '# AGENTS.md\n\nDurable lessons for coding agents working in my repositories, collected from past sessions. Keep each one short and specific.';
