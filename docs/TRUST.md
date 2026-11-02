# Trust and cost: what AI sees, where it goes, what it costs

Inkwright lets you bring your own AI. That only works if you can answer, for every request:
**where did it go, what did it carry, what did it cost, and what did the AI change?** This page
describes the layer that answers those questions, how to configure it, and — with numbers from
the evals — what it does well and where it falls short.

| You want | Inkwright does | Where |
|---|---|---|
| Cheap and private work to stay on the device, hard work to go to a strong model | Routes each kind of task by rules you set | Settings › AI › Routing & privacy |
| Some notebooks or tags never to reach a cloud AI, or not to be visible to AI at all | Per-notebook and per-tag rules, enforced for the assistant, routines, the MCP server, A2A and the runner | same, `ai/policy.json` |
| No surprise bills | Per-provider monthly budgets across all devices; a usage page with cost and savings | Settings › AI › AI usage |
| Fewer tokens without worse answers | Reversible context shortening with originals kept on the device | automatic |
| No personal data or keys in prompts | A privacy firewall that redacts (or blocks) and puts values back in the answer | automatic |
| Proof of what AI saw and did | A signed, hash-chained audit trail you can export and verify | Settings › AI › Audit trail |
| Agents that can't be talked into damage by a note or web page | Spotlighting, tool rules and a confirmation guard; dry run | automatic / Routing & privacy |

## One choke point

Every model call goes through `createGuardedProvider` (`packages/ai/src/trust/guard.ts`). In the
app, `getActiveAI()` (`apps/web/src/lib/ai.ts`) wraps whatever AI the user chose in it — so the
assistant panel, routines, Ask, smart ink, handwriting conversion and notes that listen all pass
through the same code; the server wraps its AI the same way (`apps/mcp-server/src/trust.ts`).
Callers keep the plain `Provider` interface. On each `chat()` the guard, in order:

1. **routes** the call: the task's route, then local-only notes the run has read, then the
   provider's budget — and refuses calls the policy forbids, with a message saying why;
2. **scans** new tool results for prompt-injection signs (for the tool guard);
3. **shortens** large tool results and passages, keeping originals on the device and answering
   the model's `retrieve_original` calls itself;
4. **spotlights** untrusted content in delimited blocks, with a system rule;
5. **redacts** personal data before a cloud call, and **rehydrates** the answer, the streamed
   text and tool-call arguments on the device;
6. **meters** tokens, cost and savings, and writes an **audit** event.

Note access has its own choke points: `AccessControlledNoteToolHost` for in-app agents and the
server's agents, and `PolicyVault` under every MCP tool, resource and prompt. Two calls are
outside the guard by design and say so in code: Settings' "Test" button (sends "Reply with just:
ok") and provider embeddings, which instead skip notes that must not leave the device
(`lib/memory.ts`).

## The policy file: `ai/policy.json`

A small JSON file in the vault, so it syncs with the notes it governs and applies on every device
and to every agent. Only fields that differ from the defaults are written. Settings › AI ›
Routing & privacy edits it with a form; a text editor works too. Unknown fields are ignored;
**a field with a mistake keeps its safe default** (a typo never turns protection off), and the
problems are listed at the top of the form and in the server's log.

```jsonc
{
  "version": 1,
  // Where each kind of work runs: auto (your usual AI) | device | provider:<id> | off
  "routes": { "background": "device", "chat": "auto", "heavy": "provider:01JC…", "vision": "auto" },
  // Per notebook id (applies to nested notebooks) and per tag (no '#'):
  //   access: none | read | read-write (default)   localOnly: true = content never goes to a cloud AI
  "notebooks": { "01JD…": { "localOnly": true }, "01JE…": { "access": "none" } },
  "tags": { "confidential": { "localOnly": true, "access": "read" } },
  // Monthly limit per provider (Settings id in the app, provider id such as "anthropic" on a server)
  "budgets": { "01JC…": { "monthlyUsd": 20, "onExceed": "device" } },
  // Per kind: redact (placeholder) | block (refuse the call) | allow
  "privacy": { "mode": "redact", "kinds": { "secret": "block", "email": "redact", "name": "allow" }, "allowList": ["press@acme.com"] },
  "compression": { "enabled": true, "minTokens": 600, "deviceSummaries": false },
  "injection": { "spotlight": true, "confirmWritesAfterSuspicious": true, "confirmWritesAfterAnyRead": false },
  "tools": { "deny": ["*__delete*"], "allowOnly": ["search_notes", "read_note"] },
  // Dry run: agents propose changes for you to approve
  "agentWrites": { "assistant": "apply", "routine": "propose", "external": "propose" },
  "retention": { "activityDays": 0, "auditDays": 0, "historyDays": 0, "legalHold": false },
  // USD per million tokens; overrides the built-in list prices
  "prices": { "my-fine-tune-*": { "input": 3, "output": 12 } }
}
```

| Field | Default | Meaning |
|---|---|---|
| `routes.<task>` | `auto` | `background` (titles, tags, page summaries, routines), `chat` (panel, Ask), `heavy` (lecture and notebook summaries), `vision` (reading handwriting). `device` = an on-device model, Chrome's built-in AI, or a provider on `localhost`. |
| `notebooks` / `tags` | — | The strictest rule of a note's notebook, its parents and its tags applies. |
| `budgets` | — | Spend is summed from every device's usage file for the month. `onExceed: "device"` moves work to the device; `"block"` stops it. |
| `privacy.kinds` | secrets, cards, IBANs, government IDs, emails and phones redacted; names, addresses, IPs sent | |
| `compression.minTokens` | 600 | Smaller blocks are never touched. |
| `injection.*` | spotlight and confirm-after-suspicious on; strict off | See [Prompt injection](#prompt-injection). |
| `tools.deny` / `allowOnly` | none | Tool names, `*` wildcards; denied tools are never offered to the model. |
| `agentWrites.<source>` | `apply` | `propose` turns writes into proposals in Activity. |
| `retention.*Days` | 0 = the store's default | Activity: newest 300 runs; audit: forever; history: the usual thinning. `legalHold` stops all pruning. |

**Managed policy.** A deployment can add an administrator's policy (`--policy` /
`INKWRIGHT_POLICY_FILE` on the server, `managed-policy.json` next to the app in the appliance).
`mergeManagedPolicy` takes the stricter of the two for every rule, so users can tighten but never
loosen it; the form shows where the organisation's rule applies.

## Routing

`decideRoute(policy, task, notesSeen)` is pure and tested. What makes it work for agent runs is
that the run knows what it has read: the access host records each note whose content reaches the
conversation (reads, page images, search snippets, memory passages) in the run's `TrustRun`, and
the guard decides again **before every model call**. So a chat that starts in the cloud and then
reads a note from a local-only notebook continues on the device — or stops with "A note in this
request must stay on this device… No model is available on this device" when there is none. In
listings and search results, local-only notes appear as "Private note (stays on this device)"
without title or snippet, so the cloud model can still tell the user they exist.

## Context budgeter (reversible compression)

`packages/ai/src/trust/compress.ts`. Large blocks are shortened by shape: JSON keeps the first
items, the items that match the question and a field summary; tables keep the header, matching
rows and the ends; logs collapse repeats (`[×212 similar]`) and keep errors with context; prose
keeps headings, the start, the end and the passages that share words with the question. The
shortened block ends with `[Inkwright shortened this from ~12,573 to ~520 tokens… call
retrieve_original with ref "…"]`; the original goes into a content-addressed store **on this
device** (IndexedDB in the app, memory on the server — never the vault, which syncs). The guard
adds a `retrieve_original` tool and answers it itself (with a query: only matching parts), so the
model can always get back what was cut and callers never see the extra round trip.

Two properties matter as much as the ratio. It is **deterministic**: the same block always
shortens to the same text, so the conversation prefix is byte-identical across turns and
provider prompt caching keeps working. And it is **sticky**: once the model retrieved a block,
later turns send it in full. Requests without tools (the model can't retrieve) only get lossless
shortening (trailing whitespace, repeated lines). headroom's CCR design is the inspiration; unlike
LLMLingua-style token dropping, nothing here rewrites text the model does see.

**Benchmark** (`packages/ai/evals/trust.eval.ts`, scripted reader model that answers only from
what it can see and retrieves when facts are missing; tokens estimated at ~4 characters per
token, including every round trip):

| Task | Tokens without | Tokens with | Saved | Model calls | Answer quality |
|---|---:|---:|---:|---|---|
| 400-note JSON list, question names the note | 12,573 | 560 | 95.5% | 1 → 1 | 100% → 100% |
| 900-line sync log, find the error | 15,792 | 145 | 99.1% | 1 → 1 | 100% → 100% |
| 220-row grade table, one student | 1,973 | 225 | 88.6% | 1 → 1 | 100% → 100% |
| Lecture transcript, answer shares words with the question | 6,119 | 1,587 | 74.1% | 1 → 1 | 100% → 100% |
| Transcript, answer shares **no** words with the question | 6,121 | 2,800 | 54.3% | 1 → **2** | 100% → 100% |
| "What did the meeting decide?" — facts spread out, no shared words | 2,470 | 3,631 | **−47.0%** | 1 → **2** | 100% → 100% |
| Short result (under the threshold) | 48 | 48 | 0% | 1 → 1 | 100% → 100% |
| **All tasks** | 45,096 | 8,996 | 80.1% | | |

Where it does **not** help: when the answer needs the whole text (summarise everything) and the
question shares no words with the important parts, the model has to fetch the original, and the
shortened turn plus the full turn cost more than sending it once (−47% here). Short results are
left alone. What the benchmark cannot show: how a real model's reasoning changes with shortened
context, or whether a real model asks for the original when it should — the scripted reader
always does. Treat these as upper bounds on savings and lower bounds on risk; the live agent evals
(`INKWRIGHT_EVAL_PROVIDER`) are the way to check a specific model. The 60–95% headline numbers
that tools in this space quote are real for list/log/table-shaped tool output and misleading for
summarisation.

## Usage meter

Every call adds a row (day × provider × model) to `ai/usage/<YYYY-MM>/<device>.json`: calls,
input and output tokens (the provider's numbers when it reports them, estimates otherwise),
uncompressed input tokens, cost, savings, redactions and blocked calls. One file per device, so
sync never merges them. Prices (USD per million tokens) come from `policy.prices`, then the
built-in table in `packages/ai/src/trust/meter.ts` (list prices as published by each provider when
the table was last reviewed, matched by model id pattern, most specific first). Models without a
known price are metered in tokens with cost shown as "+", never guessed. On-device calls cost $0.
The AI usage page shows the month by provider and by day, with what shortening saved.

## Privacy firewall

`packages/ai/src/trust/pii.ts`. Recognizers in the style of Microsoft Presidio: a pattern finds a
candidate, a validator decides — Luhn for cards (and IIN prefixes), mod-97 for IBANs (with
country lengths), Verhoeff for Aadhaar, SSN range rules, UK NINO prefix rules, entropy and
character classes for unknown secrets (hex hashes, UUIDs and Inkwright's own ids are excluded),
known prefixes for keys (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Stripe, Hugging
Face, npm, SendGrid, JWTs, PEM private keys, credentials in URLs, `password=` assignments), street
addresses (US, German, UK postcodes), and names in recognisable contexts (titles, greetings,
sign-offs, "my name is", "meeting with"). An on-device NER model can be plugged in
(`NameDetector`) for names without context.

Each value becomes a stable placeholder for the whole conversation (`⟦EMAIL_1⟧` is the same
person in every turn), and placeholders in the answer, in streamed text (held back when split
across chunks) and in tool-call arguments are put back on the device — so "draft a reply to
ana@acme.io" works, and the note the assistant writes has the real address. Only counts per kind
are logged; values never are. With `block`, a request containing that kind is refused before it
leaves.

**Eval** (78 labelled lines with hard negatives — order numbers that fail Luhn, dates, versions,
git SHAs, UUIDs, ISBNs, prices, Docker digests, coordinates):

| Kind | Precision | Recall |
|---|---:|---:|
| Secrets (11) | 100% | 100% |
| Cards (4), IBANs (4), emails (5), phones (7), IPs (3), addresses (5) | 100% | 100% |
| Government IDs (7) | 100% | 100% |
| Names (10) | 100% | 90% |
| **Overall (56)** | **100%** | **98.2%** |

Caveats, honestly: the corpus is small and was used while writing the rules (two rules were
fixed after it showed misses), so these numbers are optimistic; expect lower recall on real notes,
especially for names without context ("Ana Souza +55…" is missed) and for formats not covered
(many national IDs, non-Western addresses). Precision is what the validators protect. Text inside
images is not checked — route `vision` to the device if page images may hold personal data.

## Audit trail

`packages/ai/src/trust/audit.ts`. JSON Lines in `ai/audit/<device>/<YYYY-MM>.jsonl`, one chain
per device (so sync never merges them):

```jsonc
{"v":1,"seq":42,"at":1762070400000,"dev":"3f9a2c1d","prev":"<hash of event 41>",
 "kind":"ai_call","actor":{"source":"assistant"},"provider":"01JC…","model":"claude-sonnet-4-5","local":false,
 "task":"chat","route":"Your usual AI answers.","notes":[{"id":"01JD…","title":"Lecture 4"}],
 "redactions":{"email":1},"tokens":{"input":1830,"output":212,"uncompressed":9120},"costUsd":0.0087,"outcome":"ok",
 "hash":"<sha256 of the canonical JSON without hash/sig>","sig":"<ES256 over the hash>"}
```

Kinds: `ai_call` (where, why, which notes' content it carried, redaction counts, tokens, cost),
`read` and `write` (notes an agent read or changed, by tool — in the app and through MCP),
`proposal`, `policy` (changes to the policy), `blocked` (refusals, and injection signals),
`retention`, and `key` (declares the signing key; each month file starts with one). The app signs
with this device's non-extractable authorship key; the server with `--audit-key` (a P-256 JWK the
operator controls) or a key per process.

**Verify** in Settings › AI › Audit trail, or offline:
`inkwright-agent audit --verify export.jsonl [--expect-head <hash>]… [--trusted-key <fingerprint>]…`
(exit code 1 when it fails). Edited, removed, inserted or reordered events break the chain; a
forged event fails its signature. Limits: whoever holds a device's private key can rewrite that
device's chain consistently, and cutting events off the end leaves a valid, shorter chain — record
the head hash somewhere else (an export, a ticket, a SIEM) and pass it as `--expect-head` to
detect that. Retention removes whole months and records the hash the remaining chain starts after,
so verification can tell pruning from tampering.

## Prompt injection

Following OWASP's LLM Top 10 (LLM01) and the MCP security guidance, three layers:

1. **Spotlighting.** Tool results (notes, web pages, connected apps' results) go to the model in
   `<<untrusted-xxxxxxxxxx source="tool:read_note">> … <</untrusted-…>>` blocks with a random
   per-session marker (content can't forge the closing tag), invisible characters stripped, and a
   system rule that such content is data, never instructions.
2. **Detection.** `scanForInjection` scores instructions aimed at the assistant, fake system/tool
   turns, tool directives, exfiltration links, secrecy requests, Unicode tag-character smuggling,
   zero-width runs and bidi overrides.
3. **The tool guard** (independent of the model): denied tools are never offered; destructive
   tools always ask; once a run has read content that looks like an injection, **every tool that
   isn't read-only asks first** — in the app a dialog (even if "ask before deleting" is off), on
   the server the approval queue. Strict mode (`confirmWritesAfterAnyRead`) asks after reading
   anything, whether or not detection fired.

**Eval** (obedient scripted model that does whatever the content says; the user declines every
prompt):

| | Result |
|---|---|
| Detection on the development corpus (19 attacks, 16 hard negatives such as recipes that say "ignore the instructions on the box", security lectures, poems) | precision 100%, recall 100%, false alarms 0% |
| Attack success, development corpus | 73.7% without the guard → **0%** with it; benign tasks: 0% interrupted |
| **Held-out** cases written after the rules were fixed (7 attacks, 6 benign) | detection **28.6%**, false alarms 16.7%; attack success with the guard **57.1%** |
| Held out, strict mode | attack success **0%**, but **100%** of benign "read then edit" tasks ask first |

Read the held-out row: the detector is a heuristic that catches the attacks it was shaped around
and misses new phrasings (instructions in HTML comments, JSON fields, quoted "client" requests,
numbered steps "for the model"). The development corpus numbers are therefore not an estimate of
real-world recall. What holds regardless of detection: destructive actions always ask, denied
tools are never offered, local-only content can't be sent to the cloud, and in strict mode or with
`agentWrites: "propose"`, nothing an agent reads can make it change notes without you. Spotlighting
helps real models resist but can't be measured with a scripted model; run the live evals against
your model to see.

## Dry run (proposals)

With `agentWrites.<source> = "propose"`, writes become proposals in `ai/proposals/<id>.json`
(`ProposingNoteToolHost`, and the MCP server for outside agents). The model is told the change is
waiting for approval. Activity lists pending proposals with a before/after diff; Approve applies
the recorded operation through the normal permission-checked, recorded host — so it appears in
Activity and can be undone — and both decisions are audited. The API is five names
(`Proposal`, `ProposalStore`, `ProposingNoteToolHost`, `applyProposal`, `lineDiff`).

### Branches: try a proposal before it touches your notes

A pending proposal can also be **tried on a branch** (*Try on a branch* in Activity): a named
shadow copy of just the notes it touches (`branches/<id>.json`, docs/VAULT_FORMAT.md "Branches").
`applyProposalToBranch` (`packages/ai/src/trust/branch.ts`) runs the recorded operation through
the reference note host on a copy-on-write view of the vault (`OverlayFS`) in which the branch's
earlier changes are already applied, so several proposals stack on one branch; everything the
agent added gets `origin: "ai"`. Nothing in your notes changes. Activity then lists open branches:
*Compare* shows each note beside the branch's version, line by line, and *Merge into my notes*
three-way merges each note (what you changed since the branch started is kept) and applies it as
one ordinary edit — version history snapshots the note first and the authorship chain records it.
*Discard* throws the branch away. Trying, merging and discarding are all in the audit trail.
Storage stays small: page contents are content-addressed blobs shared with version history.

## Notebook permissions on every surface

| Surface | Enforced by |
|---|---|
| Assistant panel, routines (app) | `AccessControlledNoteToolHost` in `prepareAgentRun`; memory passages and Ask sources filtered |
| MCP tools, resources, prompts, tasks | `PolicyVault` (hidden and local-only notes read as missing; writes to read-only notes refused) |
| A2A agent, `inkwright-agent` runner | `PolicyVault` + `AccessControlledNoteToolHost` in `prepareServerAgent` |
| REST | Inkwright has no REST API besides MCP and A2A over HTTP, which are covered above |

The server treats local-only notes as hidden: an MCP client's model may be in the cloud, and the
server can't tell.

## Retention and legal hold

`retention` in the policy: activity runs older than `activityDays` are deleted (plus the usual
300-run cap), audit months older than `auditDays` are dropped with a `retention` record, version
history snapshots older than `historyDays` go (the newest is always kept). `legalHold: true`
suspends all of it, including the default caps, on every device and the server.

## Code map

`packages/ai/src/trust/` — `policy.ts` (schema, parse, merge, routing), `guard.ts` (the choke
point, tool guard), `pii.ts`, `compress.ts`, `meter.ts`, `audit.ts`, `injection.ts`, `access.ts`,
`proposals.ts`, `retention.ts`. App: `apps/web/src/lib/trust/` (state, gateway, originals store),
`apps/web/src/ui/trust/` (Routing & privacy, AI usage, Audit trail, proposals). Server:
`apps/mcp-server/src/trust.ts`. Tests: `packages/ai/test/trust.test.ts`,
`apps/mcp-server/test/trust.test.ts`, `apps/web/e2e/trust.spec.ts`; evals:
`packages/ai/evals/trust.eval.ts`.
