# Inkstone for outside agents: MCP, A2A and the always-on runner

Inkstone's notes live in a vault folder of plain files (docs/VAULT_FORMAT.md). The
`@inkstone/mcp-server` package (in `apps/mcp-server`) works directly on that folder and gives
other software three ways in. Nothing runs on a server of ours: it all runs on your computer,
against your folder, with the AI you choose.

| | What it is | Who uses it |
| --- | --- | --- |
| **MCP server** (`inkstone-mcp`) | Tools, resources, prompts, background tasks and interactive views over your notes | Claude Desktop, Claude Code, ChatGPT, Cursor, VS Code, any MCP client |
| **A2A agent** (`inkstone-mcp --a2a`) | Inkstone's own agent behind an Agent Card, so other agents can hand it note work | Any A2A v1.0 or v0.3 client or agent framework |
| **Always-on runner** (`inkstone-agent run`) | Runs your routines on schedule even when the app is closed | You, as a background service |

Every change any of them makes shows up in the app under **Settings › AI › Activity**, where it
can be undone. Moving a note to Trash always waits for a person's OK.

## Build once

```sh
git clone … inkstone && cd inkstone
npm install
npm run build -w @inkstone/mcp-server
# → apps/mcp-server/dist/index.js (inkstone-mcp) and dist/agent.js (inkstone-agent)
```

Node 20 or later. In the examples, `/Users/me/inkstone` is the repository and the vault is
`~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone` (Google Drive for desktop on
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
  `decide_approval`.
- **Tasks** (extension `io.modelcontextprotocol/tasks`): clients that support it get a task
  for the long-running tools at once, with progress in the task's status message, approvals as
  `input_required`, and cancel. Other clients get the same work done inline.
- **MCP Apps** (extension `io.modelcontextprotocol/ui`): hosts that render apps show a note page
  as you wrote it, a search results picker, and an approval card with Allow / Don't allow
  buttons. Every tool also returns text, so other hosts still work.
- **Resources and prompts:** each note as Markdown, each page as SVG; `summarize_note`,
  `daily_review`, `todos_from_notes`.

### Claude Desktop (local, stdio)

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "inkstone": {
      "command": "node",
      "args": [
        "/Users/me/inkstone/apps/mcp-server/dist/index.js",
        "--vault", "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone",
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
claude mcp add --scope user inkstone -- node /Users/me/inkstone/apps/mcp-server/dist/index.js \
  --vault "$HOME/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone"
```

Or over HTTP, with the server running (next section):

```sh
claude mcp add --transport http inkstone http://127.0.0.1:8765/mcp --header "Authorization: Bearer $INKSTONE_MCP_TOKEN"
```

### Over HTTP

```sh
export INKSTONE_MCP_TOKEN="$(openssl rand -hex 24)"
node apps/mcp-server/dist/index.js --vault "$HOME/…/Inkstone" --http 8765
```

The endpoint is `http://127.0.0.1:8765/mcp`; it only listens on this computer. Sign-in has three
modes:

| Mode | How | When |
| --- | --- | --- |
| Loopback | no `--token`, no `--oauth-issuer` | only clients on this computer; Host and Origin must be loopback |
| Bearer token | `--token <secret>` or `INKSTONE_MCP_TOKEN` | a tunnel, a single client, quick setups |
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
   node apps/mcp-server/dist/index.js --vault "$HOME/…/Inkstone" --http 8765 \
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
ANTHROPIC_API_KEY=… node apps/mcp-server/dist/index.js --vault "$HOME/…/Inkstone" \
  --http 8765 --token "$INKSTONE_MCP_TOKEN" --a2a --ai-provider anthropic
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
curl -s http://127.0.0.1:8765/a2a -H 'content-type: application/json' -H "authorization: Bearer $INKSTONE_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"1","role":"user","parts":[{"kind":"text","text":"Summarize what I wrote this week"}]}}}'
```

Python, Go, Java and .NET A2A SDKs work the same way from the Agent Card URL.

## 3. The always-on runner

Routines (Settings › AI › Routines in the app) normally run while Inkstone is open. On a computer
that is usually on, `inkstone-agent` runs them on schedule over the vault folder, using the same
routine definitions, triggers and catch-up rules as the app:

```sh
ANTHROPIC_API_KEY=… node apps/mcp-server/dist/agent.js run \
  --vault "$HOME/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone" \
  --ai-provider anthropic --ai-model claude-sonnet-4-5
```

- **No double runs.** The runner holds a lease in the vault (`ai/leases/routines.json`). While it
  is alive, the app leaves automatic triggers to it and the Routines screen says "The Inkstone
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
mkdir -p ~/.config/inkstone
cat > ~/.config/inkstone/agent.json <<'JSON'
{
  "vault": "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone",
  "ai": { "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKey": "sk-ant-…" }
}
JSON
chmod 600 ~/.config/inkstone/agent.json
```

Then let `install` write the service for your OS. `--dry-run` shows the file and the commands
without writing anything.

```sh
node apps/mcp-server/dist/agent.js install --config ~/.config/inkstone/agent.json --dry-run
node apps/mcp-server/dist/agent.js install --config ~/.config/inkstone/agent.json
```

| OS | File written | Start it | Logs |
| --- | --- | --- | --- |
| macOS | `~/Library/LaunchAgents/app.inkstone.agent.plist` (runs at login, restarts on failure) | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.inkstone.agent.plist` | `~/Library/Logs/Inkstone/agent.log` |
| Linux | `~/.config/systemd/user/inkstone-agent.service` | `systemctl --user daemon-reload && systemctl --user enable --now inkstone-agent.service` (and `loginctl enable-linger "$USER"` to keep it running while logged out) | `journalctl --user -u inkstone-agent.service -f` |
| Windows | `%LOCALAPPDATA%\Inkstone\inkstone-agent-task.xml` (a Task Scheduler task: at logon, restart on failure, no time limit) | `schtasks /Create /TN "Inkstone agent" /XML "%LOCALAPPDATA%\Inkstone\inkstone-agent-task.xml" /F` then `schtasks /Run /TN "Inkstone agent"` | `%LOCALAPPDATA%\Inkstone\agent.log` |

`install` prints the exact commands; `inkstone-agent uninstall` prints how to stop it and removes
the file. On macOS, the first start asks whether node may access the cloud-storage folder; if you
missed it, allow node in System Settings › Privacy & Security › Files and Folders. On Linux, keys
can also go in `~/.config/inkstone/agent.env` (`ANTHROPIC_API_KEY=…`), which the unit reads.

## The server's AI

`summarize_notebook`, `transcribe_pages`, `run_routine`, the A2A agent and the runner use an AI
configured for the server — separate from the app's, whose keys stay encrypted in your browser.
Any provider Inkstone supports works:

| `--ai-provider` | Key from | Notes |
| --- | --- | --- |
| `anthropic`, `openai`, `gemini` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY` | |
| `openrouter`, `groq`, `mistral`, `xai`, `deepseek`, `together`, `fireworks`, `perplexity`, `cerebras` | `<PROVIDER>_API_KEY` | |
| `ollama`, `lmstudio` | none | local; `--ai-base-url` if not on the default port |
| `custom` | `INKSTONE_AI_API_KEY` (if any) | any OpenAI-compatible endpoint: `--ai-base-url https://…/v1` |

`--ai-model` picks the model (default: the provider's default). Handwriting transcription needs a
vision model. `--ai-key-env NAME` reads the key from another variable. Keys never belong in
command lines or service files.

## Troubleshooting

- **401 from the server:** wrong or missing token; with OAuth, check `iss` and `aud` in your
  token match `--oauth-issuer` and the public URL (decode it at a JWT debugger you trust, or with
  `jq -R 'split(".")[1] | @base64d | fromjson'`).
- **Routines run twice:** make sure only one runner holds the lease (`status`), and that the app
  and the runner see the same vault (the lease syncs like any other file).
- **"needs an AI configured":** start the server or runner with `--ai-provider`.
- `INKSTONE_DEBUG=1` prints stack traces and protocol errors to stderr.
