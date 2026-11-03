import { runAgent, type AgentEvent, type AgentResult, type AgentTool } from '../agent.ts';
import type { ChatMessage, Provider, ToolCall } from '../types.ts';
import {
  compactTools,
  condenseHistory,
  extractiveAnswer,
  groundedSystemPrompt,
  groundedUserMessage,
  actionUserMessage,
  isActionRequest,
  isDeflection,
  nothingFoundReply,
  type Grounding,
} from './grounding.ts';

export interface GroundedTurnOptions {
  provider: Provider;
  model: string;
  question: string;
  /** Earlier turns of this chat (any shape; condensed for the model). */
  history: readonly ChatMessage[];
  grounding: Grounding;
  /** The note open on screen (its id lets append/update tools act on "this note"). */
  openNote?: { id: string; title: string; currentPage: number; /** `document` for typed documents (edited with edit_document). */ kind?: string } | null;
  /** The app's tools; a compact subset sized to the model is offered. */
  tools?: AgentTool[];
  /** The model's context window in tokens (sizes tools and history). */
  contextTokens: number;
  appName?: string;
  today?: string;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  confirm?: (call: ToolCall, tool: AgentTool) => Promise<boolean> | boolean;
}

export interface GroundedTurnResult {
  /** The reply to show (never empty, never tool syntax). */
  text: string;
  /** Who produced `text`: the model, the model after a nudge, a quoted passage, or the plain "not found". */
  by: 'model' | 'retry' | 'extractive' | 'nothing-found';
  agent: AgentResult;
  /** The turn as it should be remembered: the plain question and the final reply. */
  remember: ChatMessage[];
}

/**
 * One assistant turn for a small model, retrieval first (see grounding.ts): the gathered context
 * and the question in one user turn, earlier turns condensed, a compact tool set for actions, a
 * low temperature. Then the answer guardrails:
 *  - the model dodged ("please provide more context") or said nothing while the context has text →
 *    one nudge without tools ("the answer is in the context");
 *  - still nothing usable → the best-matching line of the context, quoted and cited;
 *  - no context at all → a plain "I couldn't find that", with what to do next.
 */
export async function runGroundedTurn(o: GroundedTurnOptions): Promise<GroundedTurnResult> {
  const tools = o.tools?.length ? compactTools(o.tools, o.contextTokens, { document: o.openNote?.kind === 'document' }) : [];
  const action = tools.length > 0 && isActionRequest(o.question);
  const system = groundedSystemPrompt({ appName: o.appName, today: o.today, memory: o.grounding.memory, hasTools: tools.length > 0, action });
  const historyTurns = o.contextTokens <= 4096 ? 4 : 8;
  const user = action ? actionUserMessage(o.question, o.openNote, o.grounding) : groundedUserMessage(o.question, o.grounding);
  const messages: ChatMessage[] = [...condenseHistory(o.history, { maxTurns: historyTurns, maxChars: o.contextTokens <= 4096 ? 300 : 600 }), { role: 'user', content: user }];
  const agent = await runAgent({
    provider: o.provider,
    model: o.model,
    system,
    messages,
    tools,
    maxSteps: 4,
    temperature: 0.2,
    ...(action ? { firstToolChoice: 'required' as const } : {}),
    maxTokens: 400,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onEvent ? { onEvent: o.onEvent } : {}),
    ...(o.confirm ? { confirm: o.confirm } : {}),
  });
  let text = agent.text.trim();
  let by: GroundedTurnResult['by'] = 'model';
  const acted = agent.toolRuns.some((r) => r.ok);
  if (action && !acted && !o.signal?.aborted) {
    // Asked to do something and nothing was done: say so plainly instead of pretending.
    const tried = agent.toolRuns.find((r) => !r.ok);
    const text = tried?.denied ? 'Okay, I didn’t make that change.' : 'I couldn’t do that on this device’s model. Try saying exactly what to create or add, or use a cloud AI in Settings › AI.';
    return { text, by: 'model', agent, remember: [{ role: 'user', content: o.question }, { role: 'assistant', content: text }] };
  }
  if (isDeflection(text) && !acted && o.grounding.hasContent && !o.signal?.aborted) {
    const nudge = await o.provider.chat({
      model: o.model,
      messages: [{ role: 'system', content: system }, ...messages, { role: 'assistant', content: text || '…' }, { role: 'user', content: 'The answer is in the context above. Answer the question from it now, in one or two sentences, citing the source number.' }],
      temperature: 0.1,
      maxTokens: 300,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (!isDeflection(nudge.text)) {
      text = nudge.text.trim();
      by = 'retry';
    }
  }
  if (isDeflection(text) && !acted) {
    const quoted = o.grounding.hasContent ? extractiveAnswer(o.question, o.grounding) : null;
    text = quoted ?? nothingFoundReply(o.grounding);
    by = quoted ? 'extractive' : 'nothing-found';
  }
  if (!text) text = acted ? 'Done.' : nothingFoundReply(o.grounding);
  return { text, by, agent, remember: [{ role: 'user', content: o.question }, { role: 'assistant', content: text }] };
}
