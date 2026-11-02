# @inkwright/ai

Bring-your-own-key AI for Inkwright: one chat API over every major provider, an agent loop that
works with the user's notes, one-tap skills, and encrypted key storage. Pure TypeScript using
global `fetch`; runs in the browser, Capacitor and Node. No dependencies besides `@inkwright/core`.

## Providers

```ts
import { createProvider, PROVIDERS } from '@inkwright/ai';

const ai = createProvider({ providerId: 'anthropic', apiKey });          // settings → Provider
const r = await ai.chat({ model: 'claude-sonnet-5-5', messages }, (e) => {
  if (e.type === 'text') append(e.delta);                                // streaming
});
```

| Family | Providers (`providerId`) |
|---|---|
| OpenAI Chat Completions | `openai`, `openrouter`, `groq`, `mistral`, `xai`, `deepseek`, `together`, `fireworks`, `perplexity`, `cerebras`, `azure-openai`, `ollama`, `lmstudio`, `custom` |
| Anthropic Messages | `anthropic` |
| Google Gemini | `gemini` |
| Any function | `CallbackProvider`, `createClaudeSampleProvider(sample)` (Claude via the claude.ai artifact `sample` capability, no key) |

`PROVIDERS` holds UI metadata: label, default base URL, whether a key is needed, where to get one
(`keyUrl`), suggested models (editable: names change; `listModels()` fetches the live list) and
capabilities. Every provider streams (SSE parsed in-house), calls tools, sends images, and throws
one error type, `AIError` (`code`: `auth`, `rate_limit`, `quota`, `network`, `aborted`, …, a
user-facing `message`, the provider's `detail`, and `retryable`). 408/429/5xx are retried twice
with backoff (honouring `retry-after`); aborts stop everything immediately. Pass `fetch` to use
Capacitor's native HTTP (no CORS) or a mock.

Models without native tool calling (Perplexity, the `sample` capability, weak local models with
`promptTools: true`) get it through `withPromptTools`: tools are described in the prompt and
`<tool_call>{…}</tool_call>` blocks are parsed back, so the agent works the same everywhere.

### Adding a provider

- **OpenAI-compatible:** add an entry to `PROVIDERS` in `src/providers/registry.ts` (id, base URL,
  key URL, models, capabilities) and, if needed, a `case` in `createProvider` for quirks
  (`maxTokensField`, `streamUsage`, extra headers, `chatUrl`). That's all.
- **New wire format:** implement `Provider` (`chat(req, onEvent)`, optional `listModels`) using the
  helpers in `http.ts` (`send` for retries/errors, `readSSE` for streams) and `makeToolCall`/`finish`
  from `providers/common.ts`; add a `kind` to the registry. Copy `test/anthropic.test.ts` and feed
  it a recorded SSE stream via `mockFetch`.

## Agent and note tools

```ts
const host = new MyVaultHost(vault, index);            // implements NoteToolHost (see MemoryNoteToolHost)
const result = await runAgent({
  provider: ai, model,
  system: notesAgentSystemPrompt(),
  messages: chatHistory,
  tools: createNoteTools(host),                        // list/search/read/create/append/update/trash…
  confirm: (call) => ui.confirm(`Move this note to Trash?`),
  onEvent: (e) => ui.render(e),                        // text deltas, tool_start/result/error, done
  signal,
});
```

`runAgent` runs model → tools → model until there is a final answer or `maxSteps` (default 8).
Tool calls in one step run in parallel; arguments are checked against each tool's JSON Schema;
bad arguments, unknown tools and thrown errors go back to the model as error results instead of
failing the run. Tools flagged `destructive` (`trash_note`) only run after `confirm` says yes; with
no `confirm` they are refused. `MemoryNoteToolHost` is the reference `NoteToolHost` over a core
`Vault` + `SearchIndex`: it writes agent text as `TextBox`es stacked below existing content and
spills onto a new page when one is full.

## Skills

Prompt builders and tolerant parsers for app buttons: `transcribeHandwriting` (plain or Markdown),
`summarizeNote`, `extractTodos`, `makeFlashcards`, `explainSelection`, `translate`, `suggestTitle`,
`suggestTags`, plus `answerFromNotes` (keyword retrieval + cited answer). Run one with
`runSkill(skill, provider, model, input)`. `extractJson` pulls JSON out of fenced or chatty replies.

## Assistant building blocks

- **Agent Skills** (`agentskills.ts`, `builtin-skills.ts`): `parseSkillMd`/`validateSkillFrontmatter`
  follow the agentskills.io spec; `skillFromFiles` (folder or unzipped archive) and
  `skillFromMarkdown` build bundles; `SkillStore` keeps them in a vault under `ai/skills/`;
  `skillsPromptSection` + `createSkillTools` (`load_skill`, `read_skill_resource`) give progressive
  disclosure. The nine built-ins are `skills/<name>/SKILL.md`.
- **Memory** (`memory.ts`): `MemoryStore` (`ai/memory.json`), `memoryPromptSection`, and
  `createRememberTool`, which only proposes.
- **Activity and undo** (`activity.ts`): `RecordingNoteToolHost` records reversible ops into a
  `RunRecorder`/`ActivityStore`; `undoOp`/`undoRun` revert them against an `UndoTarget`
  (`VaultUndoTarget` for a plain vault).
- **Routines** (`routines.ts`): triggers, `dueTimeTriggers`/`dueDateEvents`/`findDateMentions`,
  `RoutineScheduler` (injected clock and timers), `RoutineStore`, `ROUTINE_TEMPLATES`.
- **MCP client** (`mcp/`): `McpConnection` over `@modelcontextprotocol/client` (Streamable HTTP,
  2026-07-28 with 2025 fallback), `McpOAuthProvider` (PKCE, issuer-keyed secrets),
  `createMcpAgentTools` (per-tool on/off and ask-first), Tasks extension support
  (`taskAwareFetch`, `getTask`/`updateTask`/`cancelTask`), `explainMcpError` (CORS diagnosis),
  `KNOWN_MCP_SERVERS`.
- **Speech** (`transcribe.ts`): the `Transcriber` interface and OpenAI-compatible/Gemini
  implementations (`transcriberForProvider`).

## API keys

`WebCryptoSecretStore` encrypts each key with AES-GCM under a non-extractable device key kept in
IndexedDB (`IndexedDBSecretBackend`); pass `MemorySecretBackend` in tests. Use
`apiKeySecretName(providerId)` for names.

## Tests and evals

```sh
npx vitest run --project ai       # unit tests: wire formats, errors, retry, abort, agent, tools, skills, secrets
npx vitest run --project evals    # evals (scripted model, deterministic) with a score table
INKWRIGHT_EVAL_PROVIDER=openai INKWRIGHT_EVAL_KEY=sk-… INKWRIGHT_EVAL_MODEL=gpt-5-mini \
  npx vitest run --project evals  # same cases against a real model (optional INKWRIGHT_EVAL_BASE_URL, INKWRIGHT_EVAL_MIN_SCORE)
```

Eval cases (`evals/cases.ts`) seed a fresh vault, send one request and score the run on the tool
calls made, the resulting vault state and the reply. For example, "make a note with my grocery
list" must create one note containing every item, and deleting a note must ask for confirmation
and leave the note alone when the user declines. Negative controls check that the checks fail
for a misbehaving model.
