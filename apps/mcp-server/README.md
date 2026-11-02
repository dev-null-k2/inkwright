# @inkstone/mcp-server

> Setting it up for Claude, ChatGPT, A2A clients or as an always-on routine runner? Start with
> [`docs/AGENTS.md`](../../docs/AGENTS.md). This page is the reference.

An [MCP](https://modelcontextprotocol.io) server (protocol 2026-07-28, with 2025 clients still
served, over stdio and Streamable HTTP) that lets AI agents (Claude Desktop, Claude Code,
Cursor, ChatGPT, or any other MCP client) read, search and write your Inkstone notes. It works directly on
your **vault**, the folder of plain files that Inkstone syncs to your computer (for example with
Google Drive for desktop). See [`docs/VAULT_FORMAT.md`](../../docs/VAULT_FORMAT.md) for the layout.

All parsing and writing goes through `@inkstone/core`, so notes the server writes look exactly like
notes written by the app: `note.json`, page `*.ink.json`, and regenerated `note.md` and page `.svg`
files. Writes are atomic (temp file + rename), re-read `note.json` right before saving so a change
from another device is never overwritten, and never leave the vault folder.

## Tools

| Tool | What it does |
| --- | --- |
| `list_notes` | Notes, newest first: id, title, updated, tags, notebook, page count, summary. Filters: `notebook`, `tag`, `limit`, `includeTrashed`. |
| `search_notes` | Full-text search over titles, tags, summaries, typed text and **recognized handwriting** (prefix and accent-insensitive). |
| `read_note` | A note as Markdown (front matter + each page's typed and recognized text) plus metadata. |
| `get_page_image` | One page as a **PNG** image (needs the optional `@resvg/resvg-js`, otherwise you get SVG and a short note saying why) or as SVG. |
| `get_recent_handwriting` | "What did I write today?": notes changed in the last `sinceHours`, with the pages that changed. |
| `list_notebooks` | Notebooks and sections with paths ("Work / Projects") and note counts. |
| `create_notebook` | New notebook or section (`parentId`). |
| `create_note` | New paged note; the Markdown `text` goes on page 1 as typed text and continues onto more pages when it is long. |
| `append_to_note` | Adds typed text below everything already on a page; handwriting is left untouched. |
| `update_note` | Title, tags, notebook, pinned, summary. |
| `trash_note` / `restore_note` | Soft delete and undo. Trash is reversible (the app purges it after 30 days). |
| `show_note_page` | One page as you wrote it: an MCP Apps page view (SVG of the ink) in hosts that render apps, text elsewhere. |
| `summarize_notebook` | Summaries for every note in a notebook with the server's AI; saves them (replacing existing ones only after asking). Long-running: a task. |
| `transcribe_pages` | Converts handwriting not yet recognized into text with a vision model, page by page; undoable. Long-running: a task. |
| `list_routines` / `run_routine` | The user's routines; runs one now as the app would. Moving notes to Trash waits for approval. Long-running: a task. |
| `list_pending_approvals` / `decide_approval` | Actions unattended agents are waiting on (approval card in MCP Apps hosts). |

`search_notes` also returns structured hits for the MCP Apps search picker.

**Tasks** (`io.modelcontextprotocol/tasks`): for clients that declare the extension, the
long-running tools return a task at once (`tasks/get` for progress and the result, `tasks/update`
to answer an approval, `tasks/cancel`). Tasks live in the server process for an hour. Other
clients get the work done inline; approvals they can't answer become pending approvals.

**MCP Apps** (`io.modelcontextprotocol/ui`): `ui://inkstone/note-page.html`,
`ui://inkstone/search.html`, `ui://inkstone/approvals.html` (`text/html;profile=mcp-app`),
self-contained, no network access.

Resources: `inkstone://notes/{id}` (Markdown) and `inkstone://notes/{id}/pages/{n}.svg`.
Prompts: `summarize_note`, `daily_review`, `todos_from_notes`.

`--read-only` removes every write tool, and the server then never writes to the vault.

Every change an agent makes through the write tools is logged in the vault's AI activity
(`ai/activity/<run>.json`, one run per connection). The Inkstone app lists it under
Settings › AI › Activity, where each change can be undone.

## Build

From the repository root:

```sh
npm install
npm run build -w @inkstone/mcp-server      # → apps/mcp-server/dist/index.js (one self-contained file)
node apps/mcp-server/dist/index.js --help
```

The bundle needs Node 20 or later. For PNG page images, keep `@resvg/resvg-js` installed (it is an
optional dependency with prebuilt binaries for macOS, Windows and Linux). During development you can
run the source directly with `npm start -w @inkstone/mcp-server -- --vault <dir>`.

## Where is my vault?

Use the folder that contains `inkstone.json` and `notes/`. With Google Drive for desktop on macOS it
is usually:

```
~/Library/CloudStorage/GoogleDrive-<your-email>/My Drive/Inkstone
```

Tips:
- In Google Drive's settings, mark the `Inkstone` folder **Available offline**. Otherwise every read
  waits for a download.
- The first time a desktop app starts the server, macOS may ask whether it can access files in
  Google Drive. Allow it.
- `--vault` expands a leading `~`. You can also set `INKSTONE_VAULT` instead.

The examples below use `/Users/me/inkstone`, the path of this repository, and `me@example.com` as
the Google account. Replace both with your own.

## Claude Desktop

Edit `claude_desktop_config.json`, which is in `~/Library/Application Support/Claude/` on macOS and
in `%APPDATA%\Claude\` on Windows. Then restart Claude Desktop.

```json
{
  "mcpServers": {
    "inkstone": {
      "command": "node",
      "args": [
        "/Users/me/inkstone/apps/mcp-server/dist/index.js",
        "--vault",
        "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone"
      ]
    }
  }
}
```

If Claude Desktop cannot find `node` (common with nvm or Homebrew), set `"command"` to the full path
that `which node` prints, such as `/opt/homebrew/bin/node`.

If you installed the package from a registry or from a tarball (`npm pack` in `apps/mcp-server`),
you can use npx instead:

```json
{
  "mcpServers": {
    "inkstone": {
      "command": "npx",
      "args": ["-y", "@inkstone/mcp-server", "--vault", "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone"]
    }
  }
}
```

Add `"--read-only"` to `args` if you only want Claude to read.

## Claude Code

```sh
claude mcp add --scope user inkstone -- node /Users/me/inkstone/apps/mcp-server/dist/index.js \
  --vault "$HOME/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone"
```

Everything after `--` goes to the server unchanged. Leave out `--scope user` to enable the server
only for the current project.

## Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "inkstone": {
      "command": "node",
      "args": ["/Users/me/inkstone/apps/mcp-server/dist/index.js", "--vault", "/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone"]
    }
  }
}
```

## HTTP: ChatGPT and other remote clients

`--http <port>` serves the Streamable HTTP transport at `http://127.0.0.1:<port>/mcp`. The server
only listens on loopback.

```sh
export INKSTONE_MCP_TOKEN="$(openssl rand -hex 24)"
node apps/mcp-server/dist/index.js --vault "$HOME/…/Inkstone" --http 8765 --read-only
```

- **Without a token**, the server only accepts requests whose `Host` and `Origin` headers are
  loopback addresses. This blocks web pages that try to reach it through DNS rebinding.
- **With a token** (`--token <secret>` or `INKSTONE_MCP_TOKEN`), every request needs
  `Authorization: Bearer <secret>`. Clients that cannot set headers can append `?token=<secret>` to
  the URL instead.
- Local HTTP clients, such as Claude Code, can connect directly:
  `claude mcp add --transport http inkstone http://127.0.0.1:8765/mcp --header "Authorization: Bearer $INKSTONE_MCP_TOKEN"`.
- **ChatGPT** connects only to public HTTPS URLs. Put a tunnel in front of the server, for example
  `cloudflared tunnel --url http://127.0.0.1:8765` or `ngrok http 8765`. Then add a connector in
  ChatGPT's developer mode with the URL `https://<tunnel-host>/mcp?token=<secret>`, and choose no
  authentication in the connector form, because the token is already in the URL. **Always set a
  token when you use a tunnel**: anyone who has the URL can reach your notes. Prefer `--read-only`
  unless you want ChatGPT to write.

## OAuth, A2A and the always-on runner

- `--oauth-issuer <url>` makes the HTTP endpoint an OAuth 2.1 resource server for your own
  identity provider (Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp`,
  JWT validation, `notes:read` / `notes:write` scopes with step-up). Step by step in
  [`docs/AGENTS.md`](../../docs/AGENTS.md#oauth-21-with-your-own-identity-provider-step-by-step).
- `--a2a` (with `--http`) also serves Inkstone's agent over A2A: `/.well-known/agent-card.json`
  and JSON-RPC at `/a2a` (v1.0 and v0.3).
- `inkstone-agent` (`dist/agent.js`) runs routines on schedule when the app is closed and installs
  itself as a launchd / systemd / Task Scheduler service: `run`, `install`, `uninstall`, `status`,
  `approvals`.
- `--ai-provider`, `--ai-model`, `--ai-base-url`, `--ai-key-env` choose the AI those features use.

## REST API and webhooks

With `--http`, the same port serves a REST API at `/api/v1` (reference page at `/api/v1/docs`,
OpenAPI 3.1 at `/api/v1/openapi.json`): notes, pages (ink JSON, text, SVG, PNG, PDF), notebooks,
tags, links, the graph, search (semantic with `--embeddings-model`), assets, transcripts,
activity, routines, Standard Webhooks and scoped API keys (`inkstone-mcp keys create|list|revoke`).
Options: `--no-api`, `--cors-origin`, `--rate-limit`, `--state-dir`, `--embeddings-*`. In the
config file they live under `api.{enabled,corsOrigins,rateLimit,stateDir,embeddings}`. See
[`docs/API.md`](../../docs/API.md) and the typed client in `packages/sdk`.

## Options

`node dist/index.js --help` and `node dist/agent.js --help` list every option. All of them can
also come from a JSON file passed with `--config` (keys `vault`, `readOnly`, `http.{port,host,
publicUrl,a2a}`, `auth.{token,oauth.{issuer,audience,jwksUrl,readScope,writeScope}}`,
`ai.{provider,model,baseUrl,apiKeyEnv,apiKey}`); command-line flags win, then the environment
(`INKSTONE_VAULT`, `INKSTONE_MCP_TOKEN`, `INKSTONE_OAUTH_ISSUER`, `INKSTONE_AI_PROVIDER`,
`INKSTONE_AI_MODEL`), then the file.

The server sees changes from other devices right away. It watches the folder with `fs.watch` and
reindexes only the notes whose files changed. If watching isn't available, for example on some
network mounts, it checks file modification times before each call instead.

## Development

```sh
npx vitest run --project mcp     # handlers, protocol (2026 + 2025, stdio + HTTP), OAuth, Tasks, MCP Apps, A2A, runner, services
npx tsc -p tsconfig.json --noEmit
npm start -w @inkstone/mcp-server -- --vault <dir>        # MCP server from source
npm run agent -w @inkstone/mcp-server -- run --vault <dir> # runner from source
```

Layout: `src/tools.ts` (plain `(ctx, args)` note tools), `src/server.ts` (MCP wiring, task
methods), `src/agent-tools.ts` (tasks, page view, approvals), `src/tasks.ts` (Tasks runtime),
`src/ui.ts` (MCP Apps views), `src/auth.ts` (sign-in), `src/http.ts` (routes), `src/a2a.ts`,
`src/agent/` (the server's agent: AI, vault note host, runs), `src/approvals.ts`, `src/runner/`
(runner and service files), `src/agent-cli.ts` (`inkstone-agent`). Running from source needs
`--import ./scripts/raw-hooks.mjs` (the npm scripts add it) so `@inkstone/ai`'s built-in skill
files load; the build inlines them.
