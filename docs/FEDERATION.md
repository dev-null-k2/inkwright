# Team search across everyone's own server

Each person on a team keeps their notes in their own vault, served by their own `inkwright-mcp`
(docs/AGENTS.md). Team search lets you search your notes and the notes your teammates choose to
share, at once, without a central server: your server asks each teammate's server, live, and
merges what comes back. Nothing is copied, indexed centrally or cached.

```
 you ── team_search / GET /api/v1/federated/team-search ──► your server
                                                              ├─ your own notes (what your AI policy lets agents see)
                                                              ├─► Ben's server  GET /api/v1/federated/search  (Ben's shared notes)
                                                              └─► Chen's server GET /api/v1/federated/search  (Chen's shared notes)
```

Code: `apps/mcp-server/src/federation/` (`team.ts`: team file, sharing rule, fan-out and merge;
`tools.ts`: the MCP tool), `src/api/federation.ts` (REST). Tests:
`apps/mcp-server/test/federation.test.ts` (two servers, real HTTP).

## Set it up

1. **Decide what you share** and who your peers are, in a team file readable only by you —
   `~/.config/inkwright/team.json` (it holds your peers' keys, so it lives outside the vault and
   never syncs):

   ```json
   {
     "self": "Ana",
     "share": { "notebooks": ["Work / Projects"], "tags": ["team"] },
     "peers": [
       { "name": "Ben", "url": "https://ben-notes.example.com", "keyEnv": "INKWRIGHT_TEAM_KEY_BEN" },
       { "name": "Chen", "url": "https://chen.tail1234.ts.net", "credential": "chen" }
     ],
     "timeoutMs": 3000,
     "perPeerLimit": 10
   }
   ```

   `share.notebooks` takes names, paths (`Work / Projects` or `Work/Projects`) or ids, and
   includes sub-notebooks; `share.tags` shares notes with any of those tags. Nothing is shared
   until you list it. Each peer needs exactly one of `key` (inline; the file must then be 0600),
   `keyEnv` (an environment variable) or `credential` (an `api` credential in the credential
   executor, docs/CREDENTIALS.md). Peer URLs must be https (http only for this computer).

2. **Give each teammate a key** that opens only team search on your server:

   ```sh
   inkwright-mcp keys create --vault ~/Notes/Inkwright --name "Ben's server" --scope federation:search
   ```

   or in the app, Settings › Developer › API keys, scope *Team search only*. They put it in their
   team file; you put the one they give you in yours.

3. **Start your server with the team file**, reachable by your teammates (your own tunnel or
   reverse proxy, as in docs/AGENTS.md):

   ```sh
   inkwright-mcp --vault ~/Notes/Inkwright --http 8765 --token "$INKWRIGHT_MCP_TOKEN" \
     --public-url https://ana-notes.example.com --team ~/.config/inkwright/team.json
   ```

   Without `--team` (or `INKWRIGHT_TEAM_FILE`) both endpoints answer 404 and the `team_search`
   tool isn't offered.

## What a teammate's server can see on yours

`GET /api/v1/federated/search?q=…&limit=…`, for keys with the `federation:search` scope (the
server token and loopback callers have every scope):

- only notes in the notebooks and tags you share;
- minus anything your AI policy hides from agents (`access: none`) or keeps on the device
  (`localOnly`) — the endpoint reads through the same policy view of the vault as every MCP tool;
- minus trashed and locked notes;
- as **title, a snippet of at most 300 characters, notebook path, tags, last change and score** —
  never the note's text, pages, ink, attachments or id-based access to anything else. A
  `federation:search` key is refused by every other route (403).
- It never asks other servers: there is no transitive search, so a teammate's teammate sees
  nothing of yours.
- Requests are rate-limited per key like the rest of the API (600 a minute by default).

## Searching

- MCP: the **`team_search`** tool (`query`, `limit`), for Claude, ChatGPT or any MCP client
  connected to your server.
- REST: **`GET /api/v1/federated/team-search?q=…&limit=…`** (scope `notes:read`), and the SDK's
  `client.teamSearch({ q })`.

Your server searches your own notes (everything your AI policy lets agents see, not only what
you share) and asks every peer at the same time, each with its own timeout (`timeoutMs`). Each
source's scores are divided by that source's best score — servers' raw scores aren't comparable
across vaults of different sizes — and results are merged by that relevance, your own first on
ties. Every result says **whose** it is (`person`) and **which server** answered (`server`,
`local` for yours). Peers that didn't answer are listed with why — `timeout`, `unauthorized`
(their key for you is wrong or revoked), `unavailable` (not reachable, or no team search there),
`error` — and never fail the search. A peer's answer is treated as untrusted input: only
well-formed fields are kept, each bounded in length and count.

Nothing is cached or written anywhere: every search asks every peer again, and a note a teammate
edits or stops sharing changes the next search.

## Limits

- Keyword search only (each server's own index); semantic search across servers is not offered.
- A peer's snippets are what that person's server chose to send; titles may say more than you
  expect, so share notebooks whose titles you're happy for the team to see.
- Peers are listed by hand; there is no discovery. Revoking a teammate's key (`inkwright-mcp keys
  revoke`) cuts them off at once.
- Results from peers carry no link that opens their note for you: you see that it exists and
  where, and ask them for it.
