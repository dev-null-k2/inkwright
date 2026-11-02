---
name: inkstone-code-notes
description: Keep design notes, runbooks and architecture docs in an Inkstone vault in step with the code. Use when asked to document code, check whether docs are stale after a change, link notes to functions, or draw a verified architecture diagram. Works from a terminal with the `inkstone` CLI or the Inkstone MCP server; the Inkstone app is not needed.
license: Apache-2.0
compatibility: Needs Node 20+ and the Inkstone repository built (`npm run build -w @inkstone/mcp-server`), or the Inkstone MCP server connected. Reads and writes only the vault folder the user names.
metadata:
  version: "1"
---

# Notes that know your code

An Inkstone vault is a folder of plain files (see `docs/VAULT_FORMAT.md`). Notes link to code as
`[[code:path/to/file.ts#Symbol]]`. Each link remembers the signature of the symbol when it was
written; when the code changes, the link *drifts* and the note needs a look. Nothing ever edits a
note's text for the user.

`INKSTONE` below is `node <repo>/apps/mcp-server/dist/inkstone.js` (or `inkstone` if installed).

## 1. Scan the repository into the vault

```sh
INKSTONE scan <repo-folder> --vault <vault-folder> [--name <name>]
```

Parses TypeScript, JavaScript, Python, Go, Rust and Java with tree-sitter — deterministic, no AI,
no network — and writes `code/sources/<name>/graph.json`: symbols (functions, classes, methods,
exported constants, HTTP routes) with signature hashes, and call/import/handler edges. Re-run it
after every change you want drift checked against; it replaces the previous scan of that repo.

## 2. Find what changed under the notes

```sh
INKSTONE drift <vault-folder>           # human-readable
INKSTONE drift <vault-folder> --json    # for you to parse
INKSTONE drift <vault-folder> --check   # exit 1 when anything drifted (CI)
```

Each item names the note, the link, the status and the old and new signature:

- `changed` — same symbol, different signature. Read the note (MCP `read_note`, or
  `notes/<id>/note.md`) and tell the user what in it is now wrong, citing the new signature.
- `missing` — the symbol is gone. Find what replaced it (`code_search`) and suggest a new link.
- `moved` — the same signature now lives in another file; suggest the new `path#Symbol`.

Do not rewrite the note yourself unless the user asks; when they do, append a correction
(`append_to_note`) rather than editing their handwriting. They mark links reviewed in the app.

## 3. Link notes to code

Use exact ids. Search first:

- MCP: `code_search {"query": "createSession"}` → `src/auth/session.ts#createSession`
- Then write `[[code:src/auth/session.ts#createSession]]` in the note text.

Methods are `Class.method`, routes are `METHOD /path` (`[[code:src/server.ts#GET /health]]`).
`code_symbol` shows a symbol's signature, source, callers, callees and the notes that link it.

## 4. Draw verified diagrams

Never hand-draw architecture as text art in a note. Build the typed IR and validate it:

```json
{ "title": "Checkout",
  "nodes": [ { "id": "web", "label": "Web app", "kind": "client" },
             { "id": "api", "label": "Checkout API", "kind": "service", "code": "src/server.ts#POST /checkout" },
             { "id": "db",  "label": "Orders DB", "kind": "database" } ],
  "edges": [ { "from": "web", "to": "api" }, { "from": "api", "to": "db", "kind": "data" } ] }
```

Kinds: `service database queue cache storage client user gateway function job external`; edge
kinds `sync async data depends` (`depends` must not cycle; `"acyclic": true` forbids all cycles).
Call MCP `validate_diagram`. If `ok` is false, the receipt lists every issue with a JSON pointer
and a hint (`[unknown_node_ref] /edges/2/to: … Did you mean "db"?`). Fix **all** of them and
validate again; stop after four tries and tell the user what you could not resolve. Inside the
Inkstone app the assistant's `create_diagram` tool runs the same loop and places the diagram.

## 5. Runbooks

`get_runbook {"id": "<note id>"}` lists a note's ```http, ```sql and ```js blocks with parsed
requests. They run in the app, one approval per request; this skill never executes them.

## Limits

- Call edges are resolved by name (same file, imports, then a unique match); dynamic dispatch and
  reflection are not followed. Generated, vendored and minified files are skipped.
- Large repositories: at most 4000 files per scan by default (`--max-files`), files over 512 KB skipped.
- Graphs from graphify (`graphify-out/graph.json`) or a generic `{nodes, edges}` JSON can be
  imported in the app (Settings › Developer › Import graph).
