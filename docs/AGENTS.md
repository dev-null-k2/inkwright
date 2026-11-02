# Inkwright for outside agents: MCP, A2A and the always-on runner

Inkwright's notes live in a vault folder of plain files (docs/VAULT_FORMAT.md). The
`@inkwright/mcp-server` package (in `apps/mcp-server`) works directly on that folder and gives
other software three ways in. Nothing runs on a server of ours: it all runs on your computer,
against your folder, with the AI you choose.

| | What it is | Who uses it |
| --- | --- | --- |
| **MCP server** (`inkwright-mcp`) | Tools, resources, prompts, background tasks and interactive views over your notes | Claude Desktop, Claude Code, ChatGPT, Cursor, VS Code, any MCP client |
| **A2A agent** (`inkwright-mcp --a2a`) | Inkwright's own agent behind an Agent Card, so other agents can hand it note work | Any A2A v1.0 or v0.3 client or agent framework |
| **Always-on runner** (`inkwright-agent run`) | Runs your routines on schedule even when the app is closed | You, as a background service |

The same HTTP port also serves a REST API for programs (`/api/v1`, see [API.md](API.md)).

Every change any of them makes shows up in the app under **Settings › AI › Activity**, where it
can be undone. Moving a note to Trash always waits for a person's OK.

## Build once

```sh
git clone … inkwright && cd inkwright
npm install
npm run build -w @inkwright/mcp-server
# → apps/mcp-server/dist/index.js (inkwright-mcp) and dist/agent.js (inkwright-agent)
```

Node 20 or later. In the examples, `/Users/me/inkwright` is the repository and the vault is
`~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkwright` (Google Drive for desktop on
a Mac; see apps/mcp-server/README.md for other places). Replace both with yours.

## 1. MCP

The server speaks MCP **2026-07-28** (stateless requests, `server/discover`, the per-request
`_meta` envelope) with the official SDK v2, and still serves clients from 2025 (the
`initialize` handshake) over both stdio and Streamable HTTP.

What clients get:

- **Tools:** `search_notes`, `list_notes`, `read_note`, `show_note_page`, `get_page_image`,
  `get_recent_handwriting`, `list_notebooks`, `create_note`, `append_to_note`, `update_note`,
  `create_notebook`, `trash_note`, `restore_note`, and the long-running `summarize_notebook`,
  `transcribe_pages`, `run_routine` (plus `list_routines`), and `list_pending_approvals` /
  `decide_approval`. With code scanned into the vault (docs/DEVELOPERS.md): `code_search`,
  `code_symbol`, `drift_report`, `get_runbook` and `validate_diagram` (all read-only).
  `compress_and_store` and `retrieve_original` keep large text on this computer behind a handle
  and give back a shortened version (the same store as the context-saving proxy, below;
  `--no-context-tools` turns them off). With a team file (`--team`), `team_search` searches your
  notes and your teammates' shared notes on their own servers (docs/FEDERATION.md).
- **Tasks** (extension `io.modelcontextprotocol/tasks`): clients that support it get a task
  for the long-running tools at once, with progress in the task's status message, approvals as
  `input_required`, and cancel. Other clients get the same work done inline.
- **MCP Apps** (extension `io.modelcontextprotocol/ui`): hosts that render apps show a note page
  as you wrote it, a search results picker, and an approval card with Allow / Don't allow
  buttons. Every tool also returns text, so other hosts still work.
- **Resources and prompts:** each note as Markdown, each page as SVG, and context packs you saved in the app (`inkwright://packs/{id}`: compiled facts tagged EXTRACTED/INFERRED/AMBIGUOUS with sources, see docs/COMPILER.md); `summarize_note`,
  `daily_review`, `todos_from_notes`.

### Claude Desktop (local, stdio)

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "inkwright": {
      "command": "node",
      "args": [
        "/Users/me/inkwright/apps/mcp-server/dist/index.js",
        "--vault", "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkwright",
        "--ai-provider", "anthropic", "--ai-model", "claude-sonnet-4-5"
      ],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-…" }
    }
  }
}
```

The `--ai-*` options are optional: they power `summarize_notebook`, `transcribe_pages` and
`run_routine` (see [The server's AI](#the-servers-ai)). Add `"--read-only"` to only let Claude read.

### Claude Code

```sh
claude mcp add --scope user inkwright -- node /Users/me/inkwright/apps/mcp-server/dist/index.js \
  --vault "$HOME/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkwright"
```

Or over HTTP, with the server running (next section):

```sh
claude mcp add --transport http inkwright http://127.0.0.1:8765/mcp --header "Authorization: Bearer $INKWRIGHT_MCP_TOKEN"
```

### Over HTTP

```sh
export INKWRIGHT_MCP_TOKEN="$(openssl rand -hex 24)"
node apps/mcp-server/dist/index.js --vault "$HOME/…/Inkwright" --http 8765
```

The endpoint is `http://127.0.0.1:8765/mcp`; it only listens on this computer. Sign-in has three
modes:

| Mode | How | When |
| --- | --- | --- |
| Loopback | no `--token`, no `--oauth-issuer` | only clients on this computer; Host and Origin must be loopback |
| Bearer token | `--token <secret>` or `INKWRIGHT_MCP_TOKEN` | a tunnel, a single client, quick setups |
| OAuth 2.1 | `--oauth-issuer <url>` | remote use with your own identity provider (below) |

To reach it from outside (ChatGPT, claude.ai), put **your own** HTTPS tunnel or reverse proxy in
front — `cloudflared tunnel --url http://127.0.0.1:8765`, `tailscale funnel 8765`, `ngrok http
8765`, or Caddy/nginx on a machine you control — and pass the address clients use as
`--public-url https://notes.example.com`. Never expose the port without a token or OAuth; the
server refuses `--host 0.0.0.0` without one.

### ChatGPT

In ChatGPT, turn on developer mode in the apps/connectors settings, then create a connector with
your public URL:

- **With a token:** URL `https://<tunnel-host>/mcp?token=<secret>`, authentication *None* (the
  token is in the URL, so treat that URL as a password).
- **With OAuth:** URL `https://notes.example.com/mcp`, authentication *OAuth*. ChatGPT finds your
  identity provider from the server's metadata; register ChatGPT's redirect URL as a client
  there (or allow dynamic client registration) as your provider's docs describe.

ChatGPT renders the MCP Apps views (page viewer, search picker, approval card).

### claude.ai and Claude Desktop custom connectors (remote)

Settings › Connectors › Add custom connector, URL `https://notes.example.com/mcp`. With OAuth,
open *Advanced settings* to enter the client ID (and secret, if your provider issued one) you
registered for Claude; otherwise Claude uses dynamic client registration where your provider
allows it.

### OAuth 2.1 with your own identity provider, step by step

The server is an OAuth **resource server**: it never sees passwords and keeps no accounts. It
checks access tokens issued by an authorization server you run or already use (Keycloak,
Authentik, Zitadel, Auth0, Okta, Microsoft Entra ID, …).

1. **Pick the public URL** clients will use, e.g. `https://notes.example.com` (your tunnel or
   proxy). The MCP resource is `https://notes.example.com/mcp`; A2A is
   `https://notes.example.com/a2a`.
2. **In your identity provider**, create:
   - two scopes, `notes:read` and `notes:write` (other names work: `--oauth-read-scope`,
     `--oauth-write-scope`);
   - an API / audience whose identifier is `https://notes.example.com/mcp` (Auth0: *APIs*;
     Keycloak: an *audience* mapper on the client scope; Entra: *Expose an API*), so access tokens
     carry `aud` = that URL. Tokens must be **JWTs** (RFC 9068) signed with keys from the
     provider's JWKS;
   - a client for each app that will connect (Claude, ChatGPT), with that app's redirect URL,
     authorization code + PKCE, and the two scopes. Enable dynamic client registration instead
     if your provider supports it and you prefer that.
3. **Start the server** with the issuer exactly as it appears in tokens' `iss`:

   ```sh
   node apps/mcp-server/dist/index.js --vault "$HOME/…/Inkwright" --http 8765 \
     --public-url https://notes.example.com \
     --oauth-issuer https://auth.example.com/realms/home
   ```

   Options: `--oauth-audience <aud>` if your tokens use a different audience (repeatable),
   `--oauth-jwks-url <url>` if the issuer publishes no discovery document.
4. **Check it:** `curl https://notes.example.com/.well-known/oauth-protected-resource/mcp` returns
   the resource, your issuer and the scopes; `curl -i -X POST https://notes.example.com/mcp`
   answers `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
5. **Connect a client** with OAuth. It discovers your issuer from the metadata, signs you in there,
   and sends the token. A token with only `notes:read` can read; write tools answer
   `403 insufficient_scope` naming `notes:write`, and clients that support step-up ask you to
   grant it.

What the server verifies: signature (the issuer's JWKS, cached and refreshed on key rotation),
`iss`, `aud`, `exp` (60 s clock tolerance), and scopes from `scope`, `scp` or `permissions`.

## 2. A2A

```sh
ANTHROPIC_API_KEY=… node apps/mcp-server/dist/index.js --vault "$HOME/…/Inkwright" \
  --http 8765 --token "$INKWRIGHT_MCP_TOKEN" --a2a --ai-provider anthropic
```

- Agent Card: `http://127.0.0.1:8765/.well-known/agent-card.json` (A2A v1.0 JSON when the client
  sends `A2A-Version: 1.0`; a v0.3 card otherwise).
- JSON-RPC: `http://127.0.0.1:8765/a2a` — v1.0 methods (`SendMessage`, `SendStreamingMessage`,
  `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`) and the v0.3 names (`message/send`,
  `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`).
- Skills: **search notes**, **answer from notes** (with citations: a data part
  `{"citations":[{"noteId","title","uri"}]}` next to the answer), **create or append notes**,
  **run a routine**. Sign-in follows the HTTP mode: the card lists a bearer scheme, or your OAuth
  provider (OpenID Connect discovery) with the read/write scopes.
- Approvals: when the agent wants to move a note to Trash, the task goes to `INPUT_REQUIRED` with
  a data part `{"approval":{…}}`. Reply on the same task (same `taskId`) with the text "approve" /
  "deny" or a data part `{"approve": true}`.
- Structured calls without the model: `{"skill":"search_notes","query":"…"}` and
  `{"skill":"run_routine","routine":"File my notes"}` as a data part.

With the official JavaScript SDK:

```ts
import { ClientFactory } from '@a2a-js/sdk/client';
const client = await new ClientFactory().createFromUrl('http://127.0.0.1:8765');
const task = await client.sendMessage({ message: { messageId: crypto.randomUUID(), role: 1, parts: [{ content: { $case: 'text', value: 'What did I decide about pricing?' } }] } });
```

With curl (v0.3 wire format):

```sh
curl -s http://127.0.0.1:8765/a2a -H 'content-type: application/json' -H "authorization: Bearer $INKWRIGHT_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"1","role":"user","parts":[{"kind":"text","text":"Summarize what I wrote this week"}]}}}'
```

Python, Go, Java and .NET A2A SDKs work the same way from the Agent Card URL.

## 3. The always-on runner

Routines (Settings › AI › Routines in the app) normally run while Inkwright is open. On a computer
that is usually on, `inkwright-agent` runs them on schedule over the vault folder, using the same
routine definitions, triggers and catch-up rules as the app:

```sh
ANTHROPIC_API_KEY=… node apps/mcp-server/dist/agent.js run \
  --vault "$HOME/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkwright" \
  --ai-provider anthropic --ai-model claude-sonnet-4-5
```

- **No double runs.** The runner holds a lease in the vault (`ai/leases/routines.json`). While it
  is alive, the app leaves automatic triggers to it and the Routines screen says "The Inkwright
  agent on <computer> is running your routines". If the runner stops, it hands the lease back; if
  the computer sleeps, the lease expires after 10 minutes and the app (or another runner) takes
  over. A time slot is marked before it runs, so it never runs twice even across a handover.
- **Triggers:** daily and weekly times, days before a date in a note, a note with a tag being
  saved (on any device — the runner sees it when sync delivers it), a recording ending.
- **Changes** are logged in Activity like the app's own routine runs and can be undone there.
- **Approvals:** nobody is there to ask, so moving a note to Trash is saved as a pending
  approval. Answer from Claude/ChatGPT (`list_pending_approvals` shows the approval card) or:

  ```sh
  node apps/mcp-server/dist/agent.js approvals --vault "…"            # list
  node apps/mcp-server/dist/agent.js approvals --vault "…" --allow <id>
  ```
- **Connected apps** (a routine's MCP servers) are not available outside the app; the routine
  is told to skip those steps.
- `--http 8765 [--a2a]` makes the same process serve MCP and A2A too.
- `node apps/mcp-server/dist/agent.js status --vault "…"` shows who runs routines, last runs and
  pending approvals.

### Keep it running (install as a service)

Put the AI key (and the token, if you serve HTTP) in a config file readable only by you:

```sh
mkdir -p ~/.config/inkwright
cat > ~/.config/inkwright/agent.json <<'JSON'
{
  "vault": "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkwright",
  "ai": { "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKey": "sk-ant-…" }
}
JSON
chmod 600 ~/.config/inkwright/agent.json
```

Then let `install` write the service for your OS. `--dry-run` shows the file and the commands
without writing anything.

```sh
node apps/mcp-server/dist/agent.js install --config ~/.config/inkwright/agent.json --dry-run
node apps/mcp-server/dist/agent.js install --config ~/.config/inkwright/agent.json
```

| OS | File written | Start it | Logs |
| --- | --- | --- | --- |
| macOS | `~/Library/LaunchAgents/app.inkwright.agent.plist` (runs at login, restarts on failure) | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.inkwright.agent.plist` | `~/Library/Logs/Inkwright/agent.log` |
| Linux | `~/.config/systemd/user/inkwright-agent.service` | `systemctl --user daemon-reload && systemctl --user enable --now inkwright-agent.service` (and `loginctl enable-linger "$USER"` to keep it running while logged out) | `journalctl --user -u inkwright-agent.service -f` |
| Windows | `%LOCALAPPDATA%\Inkwright\inkwright-agent-task.xml` (a Task Scheduler task: at logon, restart on failure, no time limit) | `schtasks /Create /TN "Inkwright agent" /XML "%LOCALAPPDATA%\Inkwright\inkwright-agent-task.xml" /F` then `schtasks /Run /TN "Inkwright agent"` | `%LOCALAPPDATA%\Inkwright\agent.log` |

`install` prints the exact commands; `inkwright-agent uninstall` prints how to stop it and removes
the file. On macOS, the first start asks whether node may access the cloud-storage folder; if you
missed it, allow node in System Settings › Privacy & Security › Files and Folders. On Linux, keys
can also go in `~/.config/inkwright/agent.env` (`ANTHROPIC_API_KEY=…`), which the unit reads.

## The server's AI

`summarize_notebook`, `transcribe_pages`, `run_routine`, the A2A agent and the runner use an AI
configured for the server — separate from the app's, whose keys stay encrypted in your browser.
Any provider Inkwright supports works:

| `--ai-provider` | Key from | Notes |
| --- | --- | --- |
| `anthropic`, `openai`, `gemini` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY` | |
| `openrouter`, `groq`, `mistral`, `xai`, `deepseek`, `together`, `fireworks`, `perplexity`, `cerebras` | `<PROVIDER>_API_KEY` | |
| `ollama`, `lmstudio` | none | local; `--ai-base-url` if not on the default port |
| `custom` | `INKWRIGHT_AI_API_KEY` (if any) | any OpenAI-compatible endpoint: `--ai-base-url https://…/v1` |

`--ai-model` picks the model (default: the provider's default). Handwriting transcription needs a
vision model. `--ai-key-env NAME` reads the key from another variable. Keys never belong in
command lines or service files.

## Trust: the AI policy, dry run and the audit trail

The server, the A2A agent and the runner follow the vault's AI policy (`ai/policy.json`, edited in
Settings › AI › Routing & privacy; docs/TRUST.md):

- Notebooks and tags set to **hidden**, and notes that **stay on the device**, don't exist for
  MCP clients or the server's agent; **read-only** notes can't be changed, moved or trashed.
- With **Outside agents: Propose**, MCP write tools record a proposal you approve in the app's
  Activity instead of changing notes.
- Reads and writes by every client, and every call the server's own AI makes, go into the signed
  audit trail (`ai/audit/srv-…/`). Check it with `node apps/mcp-server/dist/agent.js audit
  --vault "…"` (exit code 1 if anything was changed after it was written).
- The server's AI goes through the same router, privacy firewall and budget as the app's; pass
  `--ai-on-premises` when it runs inside your network so local-only routes may use it.
- `--policy <file>` adds a managed policy users can only tighten; `--audit-key <file>` signs the
  audit trail with a key you control. Every option also has an environment variable
  (`inkwright-mcp --help`); `GET /healthz` answers without credentials for health checks.

For a self-hosted, no-egress deployment with Docker, see docs/ENTERPRISE.md.

## Keys in a separate process

The runner, the server and the proxy can make their AI calls through the **credential executor**
instead of holding keys: `inkwright-mcp creds init`, `creds add anthropic --provider anthropic`,
`creds serve --vault …`, then `--ai-credential anthropic` in place of `--ai-provider` and the key
variable. The executor checks every request against the AI policy and writes it to the signed
audit trail; it never hands a key out. With a connector credential (`creds add linear --connector
https://mcp.linear.app/mcp --server linear`) routines running on the computer get that connected
app's read-only tools. See [CREDENTIALS.md](CREDENTIALS.md).

## More on the runner

- `--watch-repo <folder>` (repeatable) re-scans a repository into the vault's code graph when its
  git HEAD moves, so code links show drift without pressing Re-scan (docs/DEVELOPERS.md).
- `--shell-allow <folder> --shell-trust "<device fingerprint>"` lets the runner run runbook shell
  blocks you approve in the app, signed by that device, only inside those folders, with a
  timeout (`--shell-timeout`) and the run in the audit trail (docs/DEVELOPERS.md › Runbooks).
  Without these flags nothing is ever run.
- The same settings in the config file: `"runner": { "watchRepos": […], "shell": { "allow": […],
  "trust": […], "timeoutSeconds": 120 } }`, and `"ai": { "credential": "anthropic" }`.

## Other tools through a context-saving proxy

`inkwright-mcp proxy --vault …` is a local OpenAI- and Anthropic-compatible endpoint for coding
agents and SDKs (`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`).
It shortens large tool output with the same reversible budgeter the app uses, keeps originals on
this computer, and records the tokens and money saved in the vault's usage files, which the app's
AI usage page shows. Benchmark and limits in [PROXY.md](PROXY.md).

## Context packs in an open format

Context packs saved in the app (`inkwright://packs/{id}`) follow an open, versioned format with a
JSON Schema and a conformance suite: [spec/personal-context/v1.md](../spec/personal-context/v1.md).
`npx inkwright context validate <pack.json>` checks a pack from any producer.

## Peer-link signalling relay

`--signal-token <secret>` (or `INKWRIGHT_SIGNAL_TOKEN`, HTTP mode only, ≥ 16 characters) adds a
tiny mailbox at `/signal/v1` that lets paired Inkwright devices find each other without exchanging
codes by hand. It has its own token — handing it to a device opens the mailbox, never the vault —
and it stores only sealed, unlinkable messages in memory for ten minutes. See
[COLLABORATION.md](COLLABORATION.md#signalling-without-a-server--and-with-one-you-run).

## Troubleshooting

- **401 from the server:** wrong or missing token; with OAuth, check `iss` and `aud` in your
  token match `--oauth-issuer` and the public URL (decode it at a JWT debugger you trust, or with
  `jq -R 'split(".")[1] | @base64d | fromjson'`).
- **Routines run twice:** make sure only one runner holds the lease (`status`), and that the app
  and the runner see the same vault (the lease syncs like any other file).
- **"needs an AI configured":** start the server or runner with `--ai-provider`.
- `INKWRIGHT_DEBUG=1` prints stack traces and protocol errors to stderr.
