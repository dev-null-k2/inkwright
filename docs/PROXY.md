# The context-saving proxy

Coding agents spend most of their tokens re-reading tool output: a test run, a `grep`, an API's
JSON, a build log — sent again on every turn of the conversation. `inkwright-mcp proxy` is a
local OpenAI- and Anthropic-compatible endpoint that sits between such a tool and its provider and
shortens large tool output with Inkwright's reversible context budgeter (the same code the app's
own assistant uses; docs/TRUST.md). Nothing is lost: every original is kept on your computer with
a handle, and the model can ask for it back.

```sh
inkwright-mcp proxy --vault ~/Notes/Inkwright            # listens on http://127.0.0.1:8787

ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude          # Claude Code
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 codex           # Codex CLI, Aider, any OpenAI SDK
```

What you saved shows up in the app under **Settings › AI › Usage** as "Context proxy · <client>",
from the vault's usage files (`ai/usage/<month>/proxy-<id>.json`), next to the app's own calls.

Code: `apps/mcp-server/src/proxy/` (`server.ts` the proxy, `formats.ts` the three wire formats,
`originals.ts` the store, `tools.ts` the MCP tools, `cli.ts`). Tests: `test/proxy.test.ts`; the
benchmark below is `test/proxy-bench.test.ts`.

## What happens to a request

1. **Find the blocks.** Tool results anywhere in the conversation (OpenAI `role: "tool"`
   messages, Anthropic `tool_result` blocks, Responses `function_call_output` items) and earlier
   user-supplied text. The latest user text is the question and is never touched.
2. **Shorten** each block over the policy's threshold (`compression.minTokens` in
   `ai/policy.json`, default 600 estimated tokens) by its shape: JSON keeps the first items, the
   items that match the question and a field summary; tables keep the header, matching rows and
   the ends; logs and line-oriented tool output (test runners, grep and compiler diagnostics,
   package managers, tracebacks, `git log`) collapse repeated lines and keep errors with their
   context; prose keeps headings, the start, the end and matching passages. Each shortened block
   ends with a marker naming its `ref`.
3. **Keep the original** in `~/.local/state/inkwright/originals/<ref>.txt` (Windows:
   `%LOCALAPPDATA%\Inkwright\originals`; `--originals-dir`), 0600 in a 0700 folder, outside the
   vault because tool output can hold secrets; at most 512 MiB and 30 days, least recently used
   first.
4. **Forward** to the provider and **meter**: the provider's reported input and output tokens,
   plus what the request would have cost unshortened, into the vault's usage files.

The budgeter is deterministic, and its decisions are remembered per conversation (model, system
prompt and first user message identify one, since requests carry no session id), so every turn
sends byte-identical text and provider prompt caching keeps working. Once the model fetched an
original, later turns of that conversation send it in full.

## Getting an original back

| The request… | Shortening | `retrieve_original` is answered by |
| --- | --- | --- |
| offers a tool named `retrieve_original` (or `…__retrieve_original`): the client has the Inkwright MCP server connected | lossy | the client, through the MCP tool, which reads the same store. The request streams untouched. |
| offers other tools (Chat Completions or Messages) | lossy | the proxy: it adds the tool, and when the model calls it, the proxy answers from the store and asks again (at most 3 rounds). A streamed request is made unstreamed upstream and replayed to the client as a stream — so time to first token is lost on those turns. Other tool calls in a turn that also retrieves are dropped; the model makes them again once it has read. |
| offers no tools, or is a Responses API request without the tool | lossless only (whitespace, blank runs, repeated lines) | — the model could not ask, so nothing is dropped |

To keep streaming everywhere, connect the Inkwright MCP server to the tool as well
(docs/AGENTS.md): its `retrieve_original` and `compress_and_store` tools use the same store.
`--no-context-tools` on the MCP server turns those two tools off.

## Keys

By default the proxy passes the client's own key through (`Authorization` / `x-api-key`), so a
tool keeps working exactly as configured. `--key-from env` uses this process's `OPENAI_API_KEY`
and `ANTHROPIC_API_KEY` instead; `--openai-credential <name>` and `--anthropic-credential <name>`
make the calls through the credential executor, so the proxy holds no key at all
(docs/CREDENTIALS.md). Other endpoints (`/v1/models`, token counting, embeddings) are passed
through unchanged.

## Who can use it

It listens on 127.0.0.1 only and checks the `Host` header (a DNS-rebinding page reaches
127.0.0.1 under its own name and is refused). Requests with an `Origin` header — browsers — are
refused, and so are non-JSON bodies, so a web page can't make "simple" cross-site requests that
spend your key. Requests are capped at 64 MiB.

## Benchmark

`npx vitest run --project mcp apps/mcp-server/test/proxy-bench.test.ts --silent=false` sends
coding-agent turns with large tool output through the real proxy to a fake API whose model reads
only what it receives and calls `retrieve_original` while facts it needs are missing. Same turn,
shortening off and on. Tokens are estimated (~4 characters per token) over **every round trip**;
quality is the share of the needed facts in the final answer.

| Task | Tokens off | Tokens on | Saved | Round trips | Quality |
|---|---:|---:|---:|---|---|
| 1,200-line test run, find the failure | 13,801 | 171 | 98.8% | 1 → 1 | 100% → 100% |
| 1,500 grep matches, question names the symbol | 25,662 | 536 | 97.9% | 1 → 1 | 100% → 100% |
| 300-issue JSON from an API, question names the issue | 13,438 | 803 | 94.0% | 1 → 1 | 100% → 100% |
| 560-line source file, question names the function | 4,633 | 1,060 | 77.1% | 1 → 1 | 100% → 100% |
| Build log, the answer shares no words with the question | 3,660 | 2,145 | 41.4% | 1 → **2** | 100% → 100% |
| Meeting notes, "what was decided?", no shared words | 2,583 | 3,850 | **−49.1%** | 1 → **2** | 100% → 100% |
| Short output (under the threshold) | 86 | 86 | 0% | 1 → 1 | 100% → 100% |
| **All tasks** | 63,863 | 8,651 | 86.5% | | |

What the proxy itself adds: shortening a 50–100 KB block takes single-digit to low tens of
milliseconds on a shared 2-core machine (the benchmark prints median times; they are noisy and
include the fake API). Retrieval round trips cost a full model call each.

**Read these numbers carefully.**

- They are upper bounds on savings. The fake model always asks for the original when a fact is
  missing and always knows what to ask for. A real model may answer from the shortened text
  instead (a wrong answer the benchmark can't show), or fetch originals it didn't need.
- Where the answer needs the whole text and shares no words with the question, the model fetches
  the original and the turn costs more than sending it once (−49% above). Summaries of whole
  documents are the case to watch.
- Code is shortened like prose (by matching passages); a question that names nothing in the file
  will often need the original.
- Estimates are not a tokenizer: real counts differ by provider, by 10–25% on code and JSON.
- Savings repeat on every later turn that re-sends the same output, which the single-turn
  benchmark doesn't count; prompt caching (which shortening keeps intact) also lowers the cost of
  the unshortened baseline on providers that offer it.

Check a specific model with your own traffic: the usage page shows input tokens sent against
what they would have been, per day and per client.

## Limits

- Chat Completions, Messages and Responses are understood; other endpoints are passed through.
- The proxy doesn't answer `retrieve_original` for the Responses API (it would have to replay
  reasoning items); such requests are shortened losslessly unless the client offers the tool.
- Images and documents in requests are left as they are.
- The policy's note-level rules don't apply here: the proxy doesn't know which of your notes a
  tool's output came from, and it doesn't decide where requests go — the tool does.
