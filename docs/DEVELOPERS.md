# Notes that know your code

Design notes, runbooks and architecture sketches go stale the moment the code under them
changes, and nothing tells you. Inkwright's developer module links notes to the code they
describe, notices when that code changes, and keeps everything in the same plain vault files
the rest of the app uses — readable by the MCP server, the `inkwright` CLI and coding agents.

It follows what works in 2026's code-knowledge tools (GitNexus, graphify, Archify, Headroom):
deterministic parsing first, models only where judgement is needed, and everything exposed over
MCP. It is optional: **Settings › Extend › Modules › Developer tools** turns all of it off (default: on
for computers and tablets, off on phones). Off, nothing of it loads — no parsers, no menu entry,
no marks on the page, no palette actions, no agent tools.

| Part | Where |
| --- | --- |
| Pure logic (graph, extraction, links, drift, diagrams, runbooks, sessions) | `packages/core/src/dev/` |
| App | `apps/web/src/dev/` (wired in with a few lines in Editor, Settings, App, LinkSuggest, followLink, the page-object renderers and the assistant) |
| Agent tools (`create_diagram`, `code_search`, `code_symbol`, `drift_report`, `propose_lessons`) | `packages/ai/src/tools/dev.ts` |
| MCP tools and the `inkwright` CLI | `apps/mcp-server/src/dev/`, `apps/mcp-server/src/inkwright-cli.ts` |
| Agent Skill for Claude Code / Codex | `skills/inkwright-code-notes/SKILL.md` |

## 1. Code sources and the code graph

A **code source** is a repository Inkwright has read. Add one in Settings › Extend › Code & runbooks:

- **Add folder** (desktop Chrome, Edge, Brave — the File System Access API). The folder is
  remembered on that device, so **Re-scan** reads it again after the browser re-confirms access.
- **Import .zip or .tar.gz** (every platform, including iPad and Android): GitHub's "Download
  ZIP", or its tarball (`https://github.com/<owner>/<repo>/archive/refs/heads/main.tar.gz`),
  downloaded by you. The archive is read in the page; nothing is uploaded. Re-scan by picking a
  newer archive.
- **`inkwright scan <repo> --vault <vault>`** on a computer (below); the graph syncs to your other devices.
- **The always-on runner watching the repository:** `inkwright-agent run --watch-repo ~/code/shop`
  re-scans whenever the repository's git HEAD moves — a commit, a checkout, a pull — so drift
  shows up without pressing Re-scan. HEAD is read from git's own files (`.git/HEAD`, the branch's
  loose ref or `packed-refs`, worktrees and submodules followed; no git binary needed), checked
  every 30 s, and the commit is recorded in the source (`source.json` › `head`). A runner that
  starts on a repository already scanned at that commit doesn't scan it again.
- **Import graph JSON**: graphify's `graph.json`, or generic nodes/edges JSON (below).

Scanning parses **TypeScript, TSX, JavaScript, Python, Go, Rust and Java** with
[web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) and the
grammar builds of `@vscode/tree-sitter-wasm` (MIT), in the page or in Node — the same runtime and
grammars in both, so the graph is identical wherever it was made. No model is involved; the same
code always gives byte-identical JSON. It extracts:

- **Symbols**: functions, classes, methods (`Class.method`), interfaces, type aliases, enums,
  exported constants (Go: capitalised; Python: `UPPER_CASE`), structs and traits (Go, Rust), and
  **HTTP routes** where the framework makes them obvious — Express/Koa/Fastify/Hono
  `app.get('/x', h)`, Flask/FastAPI `@app.get("/x")` and `@bp.route("/x", methods=[…])`, Go
  `http.HandleFunc`/chi/gin/echo (and Go 1.22 `"GET /x"` patterns), axum `.route("/x", get(h))`,
  actix `#[get("/x")]`, Spring `@GetMapping`/`@RequestMapping` (class prefix included). A route
  is a symbol named `METHOD /path` with a `handles` edge to its handler.
- Each symbol's **signature** (the declaration without its body), a **signature hash** (SHA-256
  of the signature with whitespace and trailing commas normalised, first 16 hex digits), a body
  hash, its first doc-comment line, and its first 80 lines of source (so a note can show the code
  without the repository).
- **Edges**: `imports` (file → file, Go package folder, or `module:<name>` outside the repo),
  `calls`, `contains` (class → method), `extends`, `implements`, `handles`. Calls are resolved by
  name: `this`/`self` methods, then the file's own symbols, then imported names, then a unique
  symbol of that name in the same language (preferring imported or neighbouring files). Each
  edge says `extracted` (stated in the code) or `inferred` (a unique-name guess).

**Limits.** Dynamic dispatch, reflection, re-exports through barrels and calls through variables
are not followed. Dependencies, build output, caches and VCS folders are skipped (`node_modules`,
`vendor`, `dist`, `build`, `target`, `.git`, `__pycache__`, `.venv`, …), as are minified bundles,
files over 512 KB and binary files; at most 4000 files are parsed per scan (`--max-files` in the
CLI). `.d.ts` files are skipped. Overloads keep their first declaration.

### Graph files in the vault

`code/sources/<sourceId>/source.json` and `graph.json` — format in
[VAULT_FORMAT.md › Code sources](VAULT_FORMAT.md#code-sources-code). Other tools may write them.

### Importing other tools' graphs

- **graphify** — `graphify-out/graph.json` is NetworkX node-link JSON: `nodes` with `id`,
  `label`, `source_file`, `source_location` (`"L42"`), and `links` with `source`, `target`,
  `relation`, `confidence` (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`). graphify writes the file as
  undirected but every link is directed by its order; older files carry `_src`/`_tgt`, which win.
  Nodes without a `source_file` (concepts, communities) are left out.
- **GitNexus** documents its graph schema (File, Function, Class, Method… nodes; `CodeRelation`
  edges with `type` CALLS/IMPORTS/DEFINES/EXTENDS/IMPLEMENTS/MEMBER_OF) but no export file, so
  Inkwright does not claim a GitNexus format. Export a Cypher query's rows as **generic JSON**:

```jsonc
{ "nodes": [ { "id": 1, "name": "OrderService", "label": "Class", "filePath": "src/OrderService.java", "startLine": 3, "endLine": 40, "signature": "public class OrderService" } ],
  "edges": [ { "from": 1, "to": 2, "type": "DEFINES" } ] }
// also accepted: "links" or "relationships"; source/target or startNode/endNode;
// kind|type|label for kinds; file|path|source_file; line|startLine|start_line
```

Imported symbols carry no source text. Their hash covers the signature when the file gives one,
else `kind name file`, so drift reports symbols that vanish or change kind, not edits inside them.

## 2. Code links

Write `[[code:path/to/file.ts#Symbol]]` in any text box (or in handwriting that is recognised).
`Symbol` is the qualified name: `createSession`, `SessionStore.put`, `GET /health`; a short name
works when it is unique in the file. `[[code:path/to/file.ts]]` links a whole file. Typing
`[[code:` offers symbols from your code sources. Code links are ordinary wiki links to the rest of
Inkwright (backlinks, Obsidian export, sync), except that they never create notes.

**Lassoed ink** binds to a symbol like it binds to a note: select it, then ••• › Developer (inside ••• › Tools when plugins add commands there too) ›
Link selection to code… (or the palette). The ink stays ink; an ink link with target
`code:path#Symbol` rides on it.

On the page each code link gets a small code mark. Hover it (or tap it) for the symbol card:
kind, file and line, signature, doc line and source, read-only. Following the link's arrow shows
the same card.

## 3. Drift

When a note first shows a code link that resolves, Inkwright records the symbol's signature and
hash in the note (`NoteMeta.codeRefs`, keyed `path#Symbol`). After a re-scan:

| Status | Meaning | Shown |
| --- | --- | --- |
| ok | same signature hash | quiet mark |
| changed | same symbol, different signature | amber "Changed" |
| missing | the repository is scanned but the symbol (or file) is gone | amber "Gone" |
| moved | gone from its file, but the same name with the same hash exists elsewhere | amber "Moved" |
| unresolved | never matched anything (typo, or code never scanned) | faded mark |
| unknown | no code source on this device covers the path | quiet mark |

Changes inside a body, formatting and trailing commas are not drift — only the contract. The
card shows the signature **when written** next to the one **now**; **Mark reviewed** records the
new signature as the baseline. Nothing ever edits the note's text. **Code drift** (Settings ›
Developer, the palette, or ••• › Developer for one note) lists every drifted link in the vault.
Baselines merge per link in sync, so reviewing different links on two devices keeps both.

The rules are pure functions in `packages/core/src/dev/drift.ts` (`codeRefStates`,
`withCodeBaselines`, `markCodeRefReviewed`, `driftReport`) with unit tests; the app, the MCP
server and the CLI all use them.

## 4. Verified diagrams

Architecture diagrams are a typed JSON IR, never free-form drawing:

```jsonc
{ "title": "Checkout", "direction": "TB",            // or "LR"
  "nodes": [ { "id": "api", "label": "Checkout API", "kind": "service", "group": "backend", "code": "src/server.ts#POST /checkout" } ],
  "edges": [ { "from": "web", "to": "api", "label": "HTTPS", "kind": "sync" } ],   // sync | async | data | depends
  "groups": [ { "id": "backend", "label": "Backend" } ],
  "acyclic": false,                                   // true: no cycles at all
  "layout": { "api": { "x": 40, "y": 80 } } }         // optional fixed positions (all nodes)
```

Node kinds: `service database queue cache storage client user gateway function job external`.
The shape carries the kind (a cylinder for databases and storage, a pill for queues, a dashed box
for external systems…), not colour.

`validateDiagram` (core) is deterministic and returns a **repair receipt**: every issue with a
code, a JSON pointer and a hint — schema problems, duplicate ids, unknown node references (with
"did you mean"), unknown kinds and groups, self loops, cycles where not allowed (`depends` edges
never; everything when `acyclic`), `code` references that are not in the scanned code, and
overlapping fixed layouts. `layoutDiagram` places a valid IR (layered: cycle breaking,
longest-path layers, dummy points so long edges pass between nodes, barycentre ordering with
groups kept together and non-members pushed out of group frames) into drawing primitives that
the canvas, SVG and PDF renderers share.

On a page a diagram is a page object (`type: "diagram"`, VAULT_FORMAT.md), undoable like any edit.
Insert one from ••• › Developer › Insert diagram… (the dialog shows the receipt live and only
places a valid diagram), or ask the assistant: its **`create_diagram`** tool validates the IR and
returns the receipt as an error until the diagram is valid, then places it. After four invalid
tries in one conversation it stops accepting diagrams, so invalid IR never lands.
`packages/ai/evals/diagram.eval.ts` runs the loop against a scripted model that makes real
mistakes (unknown ids, misspelt kinds, a dependency cycle, an invented code symbol fixed through
`code_search`, broken JSON, and a model that never listens) and checks it converges and that
nothing invalid is ever placed; with `INKWRIGHT_EVAL_PROVIDER`/`_KEY`/`_MODEL` it runs against a
real model too.

## 5. Runbooks and incident notebooks

Fenced blocks in typed text get a **Run** (or **Send**) button:

- ` ```http ` — the `.http` / REST Client format: `METHOD URL`, header lines, a blank line, a body;
  `{{name}}` variables. Every request asks first, showing the exact request (secret headers like
  `Authorization` masked); declining sends nothing. The result shows status, time, headers
  (masked) and the body (JSON pretty-printed, cut at 4000 characters, at most 2 MB read). It is
  sent from your device, so the server must allow cross-origin requests (CORS) from a browser;
  response headers beyond the basic ones are visible only if the server exposes them.
- ` ```sql ` — SQLite (sql.js, WebAssembly) in the page over the note's attached `.csv`, `.tsv`
  and `.json` files (••• › Developer › Attach data file…), each as a table named after the file
  (`incidents-2026.csv` → `incidents_2026`; columns from the header row, numbers typed). Results:
  up to 200 rows, copyable as a Markdown table. Nothing leaves the device.
- ` ```js ` — runs as its own Web Worker script, with `fetch`, XHR, WebSockets, `importScripts`,
  IndexedDB, Cache Storage, BroadcastChannel and nested workers removed before your code exists,
  and stopped after 5 s. `console.log` output and the returned value (top-level `return` and
  `await` work) are shown. No eval: the app's Content Security Policy stays intact.

- ` ```sh ` (also `bash`, `zsh`, `pwsh`; `cwd=<folder>` and a name after the language, e.g.
  ` ```bash cwd=~/code/shop restart `) — **never in the page.** A shell block runs on one of your
  computers, by the always-on runner, after you approve that exact run on this device. It needs
  the **Runbook shell blocks** module (Settings › Modules, off by default) and a runner started
  with `--shell-allow <folder>` (repeatable) and `--shell-trust "<this device's fingerprint>"`
  (shown, with the exact command, in Settings › Code & runbooks › Shell blocks).

  Pressing **Run** shows the command, shell, folder, computer and time limit. **Run on
  <computer>** signs a request with this device's non-extractable P-256 key (the authorship key)
  and writes it to the vault (`dev/shell/requests/`, VAULT_FORMAT.md); sync carries it to the
  computer. The runner runs it only if the signature verifies, the device is one it was told to
  trust **on that computer** (never from the vault: whoever can write your vault — a sync
  provider, a paired device — must not be able to run commands), the approval is for this runner,
  under 5 minutes old and not used before (a `running` result is written first), and the folder
  — `~`, absolute, or relative to the first allowed folder, symlinks resolved — is inside an
  allowed folder. The command gets no stdin and the runner's environment without anything that
  looks like a secret (variables named like keys, tokens, passwords, and every `INKWRIGHT_*`),
  runs in its own process group and is stopped (TERM, then KILL) after `--shell-timeout` (default
  120 s). At most 1 MiB of output is kept; long output is shortened like a log (errors kept) and
  the full text stays on that computer. The result comes back through sync into the block's
  result card. Refusals say why. Each run and refusal is in the computer's signed audit trail
  (`kind: exec` / `blocked`) as well as in Activity.

  What it doesn't protect against: a command you approve does whatever it says with your account
  on that computer — read it before you press Run. Anyone holding the approving device (unlocked)
  can approve runs; remove its fingerprint from the runner to revoke it. Windows needs `pwsh`, or
  Git Bash/WSL for `sh` and `bash`.

Every run, including declined requests, is recorded in **Settings › AI › Activity** as a
"Runbook" entry (a listed action, like a connected app's; nothing to undo in the notes).
The MCP tool `get_runbook` returns a note's blocks and parsed requests; it does not run them.

**Incident (RCA) template**: palette › New incident note (or Settings › Extend › Code & runbooks) adds an
"Incident (RCA)" template to the vault's templates — impact, timeline, checks (an http block),
root cause, actions — and starts a note from it; it is then offered under New note like any template.

## 6. Agent sessions → lessons

Import transcripts (Settings › Extend › Code & runbooks › Agent sessions, or the palette) into a **Sessions**
notebook as readable notes (who asked what, each tool call on one line, failures marked):

| Agent | File | Format |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` | one object per line: `type` user / assistant / summary; `message.content` a string or blocks (`text`, `tool_use`, `tool_result`); `timestamp`, `cwd`, `gitBranch`; sidechain and meta lines skipped |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `{timestamp, type, payload}` lines: `session_meta`, `turn_context`, `response_item` (`message`, `function_call`, `function_call_output`), `event_msg`; injected `<environment_context>` skipped |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.json` | one document `{sessionId, startTime, lastUpdated, messages: [{type: user / gemini / info / error, content, toolCalls}]}` |
| OpenClaw, pi | `~/.openclaw/agents/<agent>/sessions/*.jsonl` (history from before OpenClaw's SQLite store, and reset/deletion archives; `zstd -d` the `.jsonl.zst` ones first), `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | pi's session format v3: a `session` header, then a tree of entries (`id`, `parentId`): `message` (user, assistant with `text`/`toolCall` blocks, `toolResult`, `bashExecution`), `compaction`, `branch_summary`, `session_info`, `model_change`, `custom_message`, and OpenClaw's `reset`. Only the active branch (from the last entry back) and the latest reset window are shown, as OpenClaw's own readers do |

OpenClaw support was checked against the formats pi-coding-agent 0.73.1 (`docs/session-format.md`)
and OpenClaw 2026.10.9 (`docs/reference/session-management-compaction/schema.md`) publish, with
transcripts written to those specifications — not against files from a live OpenClaw install.
OpenClaw keeps current sessions in a per-agent SQLite database
(`~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`), which Inkwright does not read; its
`sessions export-trajectory` bundle (`session-branch.json`) is not documented closely enough to
import and is not supported.

In a session note, ••• › Developer › **Find lessons** asks your configured AI to read it and call
`propose_lessons` with at most five short, reusable rules. Proposals wait in Settings ›
Developer; **Add to AGENTS.md** appends one under a dated heading in an `AGENTS.md` note
(created in Sessions on first use, duplicates skipped); dismissing remembers the decision so it
is not proposed again. Proposals live in `ai/lessons.json` (VAULT_FORMAT.md).

## 7. MCP tools

Added to the server (`apps/mcp-server`), all read-only, so read-only vaults keep them:

| Tool | Does |
| --- | --- |
| `code_search` | fuzzy search over symbols (`query`, optional `kind`, `path`, `limit`); returns ids and `[[code:…]]` links |
| `code_symbol` | one symbol: signature, hash, doc, route, source, callers, callees, and the notes linking it with their drift status |
| `drift_report` | every drifted code link: note, link, status, signature then and now |
| `get_runbook` | a note's runnable blocks with parsed http requests |
| `validate_diagram` | the repair receipt for an IR (object or JSON text), plus SVG when valid and `svg: true` |

## 8. CLI

```sh
npm run build -w @inkwright/mcp-server          # → apps/mcp-server/dist/inkwright.js (bin "inkwright")
node apps/mcp-server/dist/inkwright.js scan ~/code/shop --vault ~/Notes/Inkwright [--name shop] [--max-files 8000] [--json]
node apps/mcp-server/dist/inkwright.js drift ~/Notes/Inkwright [--json] [--check]
node apps/mcp-server/dist/inkwright.js mcp --vault ~/Notes/Inkwright      # the MCP server (all inkwright-mcp options)
node apps/mcp-server/dist/inkwright.js context validate pack.json         # a context pack against spec/personal-context/v1.md
```

`scan` writes only `code/sources/<id>/` (the id comes from the folder name; re-scans replace
it). `drift --check` exits 1 when anything drifted — usable in CI to flag docs that need a look
in the same pull request. `skills/inkwright-code-notes/` is an Agent Skill that teaches Claude
Code, Codex and other agents to use the CLI and MCP tools this way without the app.

## Privacy

Code never leaves your devices unless you sync the vault: scanning and SQL run in the page or on
your computer, archives are read locally, and only the code graph (symbols with their first 80
source lines) is stored in the vault. ` ```http ` requests go only where the block says, after you
approve each. The assistant sees code only through the tools above, and only with the AI you chose.

## Tests

- Unit (`npx vitest run --project core packages/core/test/dev`): extraction for all six languages
  with routes, resolution, determinism and limits; code-link syntax; drift states, baselines,
  reviews and the report; diagram validation, cycles, overlaps, layout and SVG; runbook parsing,
  CSV/JSON tables, tarballs; graph import; session transcripts and lessons.
  `packages/sync/test/coderefs-merge.test.ts`: baselines merge per link.
- Evals (`npx vitest run --project evals packages/ai/evals/diagram.eval.ts`): the repair loop.
- Runner (`npx vitest run --project mcp apps/mcp-server/test/shellrun.test.ts`): shell requests
  run once when signed by a trusted device, and are refused when untrusted, changed, expired,
  for another runner, or outside the allowed folders (symlinks included); secrets kept out of the
  environment; timeouts; shortened output; audit entries; the git HEAD reader (loose, packed,
  detached, worktree) and re-scans on HEAD moves. OpenClaw transcripts:
  `packages/core/test/dev/openclaw.test.ts`.
- End-to-end (`e2e/runbook-shell.spec.ts`): no Run button while the module is off; without a
  computer the result says how to set one up; declining writes nothing; an approved request
  verifies (and a changed one doesn't) and the computer's answer shows in the result card.
- MCP and CLI (`npx vitest run --project mcp apps/mcp-server/test/dev.test.ts`): the five tools
  through the SDK client, `inkwright scan`/`drift` spawned for real, and the Agent Skill validated.
- End-to-end (`e2e/dev.spec.ts`): zip import, `[[code:` autocomplete, symbol card, drift after a
  re-scan with a changed signature and Mark reviewed, an http block against a routed endpoint
  (approval, decline, Activity), sql over an attached CSV, js in the sandbox, a diagram refused
  then placed and drawn, and the module switched off.
