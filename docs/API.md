# The Inkwright API

Three ways for other software to work with your notes, all without a server of ours:

1. **[REST API](#rest-api)** (`/api/v1`) — served by `inkwright-mcp --http` on your computer,
   next to MCP and A2A, over your vault folder. OpenAPI 3.1, scoped API keys, webhooks, a typed
   TypeScript SDK.
2. **[Links](#links)** — `inkwright://new?title=…` and friends, for Shortcuts, Tasker, launchers
   and other apps.
3. **[`window.inkwright`](#windowinkwright)** — the plugin API for scripts running in the app's
   page (off by default).

Agents should usually use MCP instead (docs/AGENTS.md); in-app extensions are plugins
(docs/PLUGINS.md).

## REST API

### Start the server

```sh
npm run build -w @inkwright/mcp-server
node apps/mcp-server/dist/index.js --vault ~/Inkwright --http 8765
# REST API at http://127.0.0.1:8765/api/v1 — reference at http://127.0.0.1:8765/api/v1/docs
```

- The machine-readable description is `GET /api/v1/openapi.json` (OpenAPI 3.1, JSON Schema
  2020-12). The built-in reference page `GET /api/v1/docs` renders it, with a curl example per
  operation; it works offline and behind a tunnel.
- The API is on whenever `--http` is (turn it off with `--no-api`). Everything in
  docs/AGENTS.md about `--host`, `--public-url`, tunnels, the token and OAuth applies.

| Option | Default | |
| --- | --- | --- |
| `--cors-origin <origin>` | none | Let a browser app at that origin call the API (repeatable; `*` for any). Without it, browsers can't read responses. |
| `--rate-limit <n>` | 600 | Requests per minute per caller (token bucket). |
| `--state-dir <dir>` | `~/.config/inkwright/api/<vault hash>` | Webhook subscriptions, their secrets and the delivery log — outside the vault, so signing secrets never sync to a cloud drive. |
| `--embeddings-model <m>` | — | Turns on `mode=semantic`/`hybrid` search, e.g. `text-embedding-3-small` or `nomic-embed-text`. |
| `--embeddings-url <url>` | OpenAI | Any OpenAI-compatible `/embeddings` base URL (Ollama: `http://127.0.0.1:11434/v1`). |
| `--embeddings-key-env <NAME>` | `OPENAI_API_KEY` for OpenAI | Where the embedding key is. |

### Authentication and scopes

Send `Authorization: Bearer <credential>`:

| Credential | Scopes |
| --- | --- |
| **API key** `ink_<id>_<secret>` | the ones it was created with |
| the server token (`--token`) | all |
| an OAuth access token (`--oauth-issuer`) | read scope → `notes:read`; write scope → `notes:write`, `routines:run`, `webhooks` |
| nothing, in loopback mode (no token, no OAuth) | all, for programs on this computer (Host and Origin must be loopback) |

Scopes: `notes:read` (notes, pages, notebooks, tags, links, search, assets, transcripts,
activity, routines), `notes:write` (create/change/trash/restore), `routines:run`, `webhooks`
(manage subscriptions), `admin` (manage keys), `federation:search` (for a teammate's server:
only `GET /federated/search`, see [Team search](#team-search)).

Keyword search (`GET /search`) answers only with notes the AI policy lets agents see, like every
other route (hidden and on-device notes are left out).

Create keys in the app (**Settings › Extend › Developer › API keys**), with the CLI, or with an `admin`
key through the API. Keys are stored in the vault's `api/keys.json` as SHA-256 hashes only — the
key is shown once — so a key made on your phone works with the server on your laptop after sync,
and revoking it anywhere revokes it everywhere (revocation always wins in sync merges).

```sh
node apps/mcp-server/dist/index.js keys create --vault ~/Inkwright --name "Shortcuts" --scope notes:read --scope notes:write
node apps/mcp-server/dist/index.js keys list   --vault ~/Inkwright
node apps/mcp-server/dist/index.js keys revoke --vault ~/Inkwright <key id>
export INKWRIGHT_API_KEY=ink_…
```

### Examples

```sh
API=http://127.0.0.1:8765/api/v1
AUTH="Authorization: Bearer $INKWRIGHT_API_KEY"

# List notes tagged "work", newest first; follow nextCursor for more
curl -s "$API/notes?tag=work&limit=20" -H "$AUTH"
curl -s "$API/notes?tag=work&limit=20&cursor=eyJ1Ijo…" -H "$AUTH"

# Search (keyword; semantic/hybrid with --embeddings-model)
curl -s "$API/search?q=pricing%20decision&mode=hybrid" -H "$AUTH"

# Create a note, safely retryable
curl -s -X POST "$API/notes" -H "$AUTH" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title":"Standup","text":"- shipped the API\n- next: plugins","tags":["work"]}'

# Read with its ETag, then update only if nobody changed it meanwhile
curl -si "$API/notes/01JC…" -H "$AUTH" | grep -i '^etag'
curl -s -X PATCH "$API/notes/01JC…" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'If-Match: "q7Vh…"' -d '{"tags":["work","done"]}'

# Append text, trash, restore
curl -s -X POST "$API/notes/01JC…/append" -H "$AUTH" -H 'Content-Type: application/json' -d '{"text":"Follow-up: call Sam"}'
curl -s -X DELETE "$API/notes/01JC…" -H "$AUTH"
curl -s -X POST "$API/notes/01JC…/restore" -H "$AUTH"

# Pages: ink JSON, text, SVG, PNG, PDF; the whole note as Markdown, JSON or PDF
curl -s "$API/notes/01JC…/pages/1/text" -H "$AUTH"
curl -s "$API/notes/01JC…/pages/1/png?width=1600" -H "$AUTH" -o page1.png
curl -s "$API/notes/01JC…/export?format=pdf" -H "$AUTH" -o note.pdf

# Links, backlinks and the graph; notebooks, tags; files and transcripts
curl -s "$API/notes/01JC…/links" -H "$AUTH"
curl -s "$API/graph?tags=false" -H "$AUTH"
curl -s "$API/notes/01JC…/transcripts" -H "$AUTH"

# Run a routine (the server needs --ai-provider)
curl -s -X POST "$API/routines/File%20my%20notes/run" -H "$AUTH"
```

Every write made with a key appears in the app under **Settings › AI › Activity** as
"<key name> (API)" and can be undone there, exactly like an agent's change.

### Operations

| | |
| --- | --- |
| Notes | `GET /notes` (filters: `notebook`, `tag`, `updatedSince`, `status=active\|trashed\|all`; keyset cursor), `POST /notes`, `GET/PATCH/DELETE /notes/{id}`, `POST /notes/{id}/append`, `POST /notes/{id}/restore`, `GET /notes/{id}/markdown`, `GET /notes/{id}/export?format=md\|json\|pdf` |
| Pages | `GET /notes/{id}/pages`, `GET /notes/{id}/pages/{n}`, `…/ink`, `…/text`, `…/svg`, `…/png?width=`, `…/pdf` |
| Notebooks, tags | `GET/POST /notebooks`, `GET /tags` |
| Search and links | `GET /search?q=&mode=keyword\|semantic\|hybrid`, `GET /notes/{id}/links`, `GET /graph` |
| Files | `GET /notes/{id}/assets`, `GET /notes/{id}/assets/{name}`, `GET /notes/{id}/transcripts` |
| Automation | `GET /activity`, `GET /routines`, `POST /routines/{id}/run` |
| Webhooks | `GET/POST /webhooks`, `GET/DELETE /webhooks/{id}`, `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/test` |
| Keys | `GET/POST /keys`, `DELETE /keys/{id}` |
| Team | `GET /federated/search?q=` (scope `federation:search`; what this server shares), `GET /federated/team-search?q=` (your notes and your teammates', merged) — 404 unless the server has a team file |

PNG and PDF need the optional `@resvg/resvg-js` package (installed on most platforms); PDF pages
are the page rendered at 2× on a PDF page of the same size (the app's own PDF export is vector).

### Conventions

- **Errors** are RFC 9457 problem details (`application/problem+json`) with a stable `code`
  (`invalid_request`, `unauthorized`, `insufficient_scope`, `not_found`, `precondition_failed`,
  `idempotency_key_reused`, `rate_limited`, …); validation errors list every problem in
  `errors: [{path, message}]`. Each `type` links to its explanation on the docs page.
- **Pagination**: `limit` and an opaque `cursor`; responses are `{data, nextCursor}`. Notes use a
  keyset cursor on (last change, id), so pages stay consistent while notes change.
- **ETags**: note reads return `ETag`; send it as `If-None-Match` (→ 304) or `If-Match` on
  `PATCH`, `DELETE` and `append` (→ 412 if the note changed). Without `If-Match` the write still
  never overwrites newer data: it is applied on top of the current version.
- **Idempotency**: POSTs that create or run something accept `Idempotency-Key`
  (draft-ietf-httpapi-idempotency-key-header). A retry with the same key returns the first
  response with `Idempotent-Replayed: true`; the same key with a different request is 422; while
  the first is still running, 409. Keys are kept for 24 hours.
- **Rate limits**: `RateLimit-Policy: "default";q=600;w=60` and `RateLimit: "default";r=599;t=1`
  on every answer (draft-ietf-httpapi-ratelimit-headers); 429 with `Retry-After` when exceeded.
- **CORS**: off unless `--cors-origin` allows an origin; preflights allow `Authorization`,
  `Content-Type`, `Idempotency-Key`, `If-Match` and `If-None-Match`.
- **Versioning**: the path carries the major version (`/api/v1`). Additive changes (new
  operations, new optional fields) keep v1; breaking ones would add `/api/v2` next to it.

### Webhooks

```sh
curl -s -X POST "$API/webhooks" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/inkwright","events":["note.created","note.updated","recording.ended","routine.finished"]}'
# → {"id":"…","secret":"whsec_…", …}   (the secret is shown once)
```

Events: `note.created`, `note.updated`, `note.trashed`, `note.restored`, `recording.ended`,
`routine.finished`. They come from a scan of the vault, so changes made anywhere — the app on
your phone (after sync), MCP agents, the API, the always-on runner — are reported.

Deliveries follow the [Standard Webhooks](https://www.standardwebhooks.com) specification:

```http
POST /inkwright HTTP/1.1
content-type: application/json
webhook-id: msg_01JD…
webhook-timestamp: 1730000000
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"type":"note.created","timestamp":"2026-11-02T09:00:00.000Z","data":{"id":"01JD…","title":"Standup","updatedAt":"…"}}
```

- Verify: HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>` with the base64-decoded
  part of the secret after `whsec_`, base64-encoded, compared with each `v1,…` entry; reject
  timestamps more than 5 minutes off; de-duplicate by `webhook-id` (retries reuse it). Any
  Standard Webhooks library works, or `verifyWebhook` from `@inkwright/sdk`.
- Answer 2xx quickly. Anything else (or no answer in 15 s) is retried after 5 s, 5 min, 30 min,
  2 h, 5 h, 10 h and 10 h, then marked failed. `410 Gone` turns the subscription off.
- `GET /webhooks/{id}/deliveries` shows the latest attempt of each message;
  `POST /webhooks/{id}/test` sends a sample event and returns the first attempt.
- URLs must be https (http only for localhost).

### Team search

With a team file (`--team`, [FEDERATION.md](FEDERATION.md)) each person's server answers
`GET /api/v1/federated/search` for their teammates' servers — titles and snippets of the notes
they chose to share, filtered by their AI policy, for keys with the `federation:search` scope —
and `GET /api/v1/federated/team-search` searches your notes and every teammate's at once:

```sh
curl -s "http://127.0.0.1:8765/api/v1/federated/team-search?q=pricing" -H "Authorization: Bearer $INKWRIGHT_MCP_TOKEN"
# → {"query":"pricing","data":[{"person":"Ben","server":"https://ben.example.com","noteId":"…","title":"Pricing call","snippet":"…","relevance":1, …}, …],
#    "peers":[{"name":"Ben","status":"ok","results":3,"ms":120},{"name":"Chen","status":"timeout", …}]}
```

Nothing is cached anywhere; a slow or refusing peer is listed in `peers` and never fails the search.

### The TypeScript SDK

`@inkwright/sdk` (packages/sdk) is generated from the OpenAPI document: one typed method per
operation, plus retries with automatic idempotency keys, typed problem errors, pagination and
webhook verification. See packages/sdk/README.md and its `examples/`.

```ts
import { InkwrightClient, paginate } from '@inkwright/sdk';
const inkwright = new InkwrightClient({ baseUrl: 'http://127.0.0.1:8765/api/v1', apiKey: process.env.INKWRIGHT_API_KEY });
const note = await inkwright.createNote({ body: { title: 'From a script', text: 'Hello' } });
for await (const n of paginate((cursor) => inkwright.listNotes({ tag: 'work', cursor }))) console.log(n.title);
```

Other languages: generate a client from `/api/v1/openapi.json` with any OpenAPI 3.1 generator.

The SDK has `client.federatedSearch({ q })` and `client.teamSearch({ q })` for the team routes.

### How it is built

Routes are declared once (`apps/mcp-server/src/api/routes.ts`) with zod schemas for path, query,
body and responses. The router validates with them; `openapi.ts` turns them into the document;
the SDK generator turns the document into code. Contract tests
(`apps/mcp-server/test/api.test.ts`) validate every response against the served document with an
independent JSON Schema validator (Ajv) and fail if any documented operation is not exercised;
another test fails when the committed SDK is stale. Writes reuse the MCP tool handlers, so MCP,
REST and the app's assistant change notes in the same way.

## Links

| Link | Does |
| --- | --- |
| `inkwright://new?title=…&text=…&tags=a,b&notebook=…` | creates a note (text as typed Markdown) and opens it |
| `inkwright://open?note=<id>&page=2` or `?title=…` | opens a note at a page |
| `inkwright://search?q=…` | opens search everything with the query |
| `inkwright://capture?url=…&title=…&text=…&tags=…` | saves a link (and a quote) as a note tagged `captured` |
| `inkwright://today` | opens today's daily note |

- **Android**: the app registers `inkwright://` (an intent filter); Tasker "Browse URL", Shortcut
  makers and other apps can open these links.
- **Installed web app** (Chrome, Edge): registers the `web+inkwright://` protocol (browsers only
  allow `web+` schemes for web apps); the browser asks once before handing links to it.
- **Any browser**: the same actions as query parameters on the app's address:
  `https://<your Inkwright>/?action=new&title=Groceries&text=-%20milk`,
  `?action=open&note=…`, `?action=search&q=…`, `?action=capture&url=…`, `?action=today`.
- iOS Shortcuts: "Open URL" with the web form.

Links only create, open or search — they never delete, change or send anything. Titles are
capped at 300 characters and text at 50 000. Turning off **Links from other apps** in Settings ›
Modules ignores them. The parser is `apps/web/src/developer/deeplinks.ts`.

## window.inkwright

Settings › Extend › Developer › Automation API exposes the plugin API (docs/PLUGINS.md) to scripts on
the app's page — browser extensions, userscripts, the devtools console — with the permissions
you tick there. Calls go through the same permission-checked dispatcher as plugins, and changes
appear in Activity as "Automation API". It needs the Developer tools module (Settings ›
Modules) and is off by default. When it turns on, `window` receives an `inkwright:ready` event.

```js
await inkwright.app.info();                                   // version, granted permissions
await inkwright.notes.list({ tag: 'work', limit: 10 });
await inkwright.notes.create({ title: 'From the console', text: 'hi' });   // needs notes:write
inkwright.events.on('note.updated', (e) => console.log('saved', e.title)); // needs events
inkwright.commands.register('stamp', () => inkwright.editor.insertText(new Date().toLocaleString()), { title: 'Insert the date' });
```
