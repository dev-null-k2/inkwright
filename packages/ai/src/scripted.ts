import { CallbackProvider } from './providers/callback.ts';
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall, Usage } from './types.ts';

/** One scripted model turn. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown>; id?: string }>;
  usage?: Usage;
  stopReason?: ChatResult['stopReason'];
}

export interface ScriptContext {
  request: ChatRequest;
  /** 0-based index of this model call. */
  call: number;
  /** Tool results since the last assistant turn, parsed as JSON when possible. */
  toolResults: Array<{ name: string; ok: boolean; value: unknown; text: string }>;
  /** The latest user message text. */
  userText: string;
}

export type ScriptStep = ScriptedTurn | ((ctx: ScriptContext) => ScriptedTurn);

export type ScriptedProvider = Provider & { requests: ChatRequest[] };

function textOfMessage(m: ChatMessage): string {
  return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/**
 * A deterministic fake model for tests, evals and demo mode. Plays `script` turn by turn (a turn
 * may be computed from the previous tool results, so it can use real ids), streaming text in
 * small deltas like a real provider. After the script runs out it answers `fallbackText`.
 */
export function createScriptedProvider(script: ScriptStep[] | ((ctx: ScriptContext) => ScriptedTurn), opts: { id?: string; fallbackText?: string; chunk?: number } = {}): ScriptedProvider {
  const requests: ChatRequest[] = [];
  let n = 0;
  const provider = new CallbackProvider({
    id: opts.id ?? 'scripted',
    label: 'Scripted model',
    handler: async (req, emit) => {
      requests.push(req);
      const call = n++;
      const tail: ChatMessage[] = [];
      for (let i = req.messages.length - 1; i >= 0 && req.messages[i]!.role === 'tool'; i--) tail.unshift(req.messages[i]!);
      const toolResults = tail.map((m) => {
        const text = textOfMessage(m);
        let value: unknown = text;
        try {
          value = JSON.parse(text);
        } catch {
          /* keep text */
        }
        return { name: m.name ?? '', ok: !m.isError, value, text };
      });
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const ctx: ScriptContext = { request: req, call, toolResults, userText: lastUser ? textOfMessage(lastUser) : '' };
      const step = typeof script === 'function' ? script(ctx) : script[call];
      const turn: ScriptedTurn = step === undefined ? { text: opts.fallbackText ?? 'Done.' } : typeof step === 'function' ? step(ctx) : step;
      const text = turn.text ?? '';
      const size = opts.chunk ?? 12;
      for (let i = 0; i < text.length; i += size) emit({ type: 'text', delta: text.slice(i, i + size) });
      const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `scripted_${call}_${i}`, name: c.name, arguments: c.arguments ?? {} }));
      const out: Partial<ChatResult> = { text, toolCalls, usage: turn.usage ?? { inputTokens: 10, outputTokens: Math.ceil(text.length / 4) + 5 * toolCalls.length } };
      if (turn.stopReason) out.stopReason = turn.stopReason;
      return out;
    },
  });
  return Object.assign(provider, { requests });
}
