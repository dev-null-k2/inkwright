# Inkwright for organisations: the self-hosted appliance

Inkwright needs no backend of ours. For an organisation that wants the notes, the agents and the
AI inside its own network — up to fully air-gapped — `deploy/` has a Docker appliance:

```
            your TLS terminator / ingress (https://notes.example.com)
                              │
                ┌─────────────▼─────────────┐   network "edge" (published port only)
                │ web  nginx (non-root)      │
                │  /            the web app  │
                │  /mcp /a2a    → server     │
                │  /.well-known → server     │
                │  /dav/        → webdav     │
                └──────┬──────────────┬──────┘
   network "internal"  │ (no route out: Docker `internal: true`)
        ┌──────────────▼───┐   ┌──────▼───────┐   ┌───────────────┐
        │ server           │   │ webdav       │   │ ollama        │ (profile "ollama")
        │ MCP · A2A ·      │   │ rclone serve │   │ local models  │
        │ routine runner   │   │ webdav       │   └───────────────┘
        └────────┬─────────┘   └──────┬───────┘
                 └──── volume "vault" ┘     (plain files: docs/VAULT_FORMAT.md)
```

- **web** — the same static app as the public PWA, built with `VITE_MANAGED_POLICY_URL` so it
  loads the administrator's policy; nginx with a strict CSP (`connect-src 'self'`: the app can
  only talk to this origin), no-sniff, no referrer, framing denied.
- **server** — `inkwright-agent run` (bundled, distroless, non-root, read-only filesystem): the MCP
  server (2026-07-28 and 2025 clients), the A2A agent, and the always-on routine runner over the
  vault volume. `/healthz` for the health check.
- **webdav** — the vault over WebDAV, so the web and mobile apps sync to the same files the server
  works on (Settings › Sync › WebDAV, `https://notes.example.com/dav/`).
- **ollama** (optional) — local models for the server's agent and for summaries.

## Deploy

```sh
cp deploy/.env.example deploy/.env                      # set INKWRIGHT_PUBLIC_URL and sign-in
cp deploy/managed-policy.example.json deploy/managed-policy.json   # your AI policy (below)
htpasswd -B -c deploy/webdav.htpasswd alice             # WebDAV users for sync
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile ollama up -d
```

Put your TLS terminator (load balancer, ingress, Caddy, nginx) in front of the published port
(`127.0.0.1:8080` by default). Health: `GET /healthz` on the web container (and on the server
container, internally). Logs go to Docker's json-file driver, rotated (10 MB × 5).

### Configuration (environment)

| Variable | Meaning |
|---|---|
| `INKWRIGHT_PUBLIC_URL` | The https address users and clients use. Required; the OAuth resource is `<url>/mcp`. |
| `INKWRIGHT_OAUTH_ISSUER`, `INKWRIGHT_OAUTH_AUDIENCE`, `INKWRIGHT_OAUTH_JWKS_URL` | OpenID Connect / OAuth 2.1 (recommended): the server is a resource server that validates JWT access tokens from your issuer (Keycloak, Entra ID, Okta, Auth0, Zitadel…), with `notes:read` / `notes:write` scopes and step-up. See docs/AGENTS.md › OAuth. |
| `INKWRIGHT_MCP_TOKEN` | A bearer token instead of OAuth. Without either, the server refuses to listen on the network. |
| `INKWRIGHT_AI_PROVIDER`, `_MODEL`, `_BASE_URL`, `INKWRIGHT_AI_ON_PREMISES=1` | The server's own AI. On-premises AI counts as "this device" for the AI policy and isn't redacted. |
| `INKWRIGHT_POLICY_FILE` | The managed AI policy (mounted from `INKWRIGHT_MANAGED_POLICY`). |
| `INKWRIGHT_AUDIT_KEY` | Path to a P-256 private JWK that signs the server's audit trail (mount it as a secret; publish its fingerprint). |
| `INKWRIGHT_A2A` | `1` serves the A2A agent. |

Every option also exists as a command-line flag and in the JSON config file (`inkwright-mcp --help`).

### Managed AI policy

The same format as a user's `ai/policy.json` (docs/TRUST.md). The server merges it with the vault's
policy and the web app with each user's, **the stricter rule winning everywhere**: routes, notebook
and tag access, local-only, privacy kinds, denied tools, dry run, retention and legal hold. A
starting point (`deploy/managed-policy.example.json`): all AI on the device, `#confidential` hidden
from agents, `#client` local-only, secrets/cards/IBANs/IDs blocked, other personal data redacted,
delete/send tools in connected apps denied, routines and outside agents propose instead of
writing, a year of activity and seven years of audit.

### Air-gapped operation

- Build the images where the registry is reachable (`docker compose build`), push them to your
  registry, and set `INKWRIGHT_IMAGE_PREFIX`; pin by digest.
- Models: on a connected machine, `docker run --rm -v ollama:/root/.ollama ollama/ollama pull
  qwen2.5:7b-instruct`, then move the volume (or `ollama` model directory) in. The `ollama`
  container has no route out, so it cannot pull.
- The web app's on-device models (transformers.js) download from Hugging Face; in an air-gapped
  network they are unavailable unless you mirror them — the app then uses the server's or a LAN
  model through Settings › AI (an OpenAI-compatible endpoint such as the Ollama container exposed
  through your proxy).

### Allowing one cloud provider

Egress is a decision, not a default. To let the server reach exactly one provider, attach the
server to an egress network that only reaches an HTTP(S) proxy with an allowlist (e.g. Squid or
your corporate proxy allowing `api.anthropic.com`), set `HTTPS_PROXY` on the server, and keep
`INKWRIGHT_AI_ON_PREMISES` unset so the privacy firewall redacts. Set budgets and routes in the
managed policy. Users' apps reach providers directly from their devices unless your network
policy prevents it — the managed policy's routes (`"device"`) keep app AI on devices.

## Data residency

| Data | Where it lives | Leaves the deployment? |
|---|---|---|
| Notes, assets, transcripts, history | `vault` volume (and users' devices via sync) | No |
| AI policy, activity, proposals, approvals, audit trail, usage | `vault` volume, under `ai/` | No |
| Originals of shortened context | Server memory; users' devices (IndexedDB, 14 days) | No |
| API keys of users' own providers | Each device's encrypted secret store; never synced | No |
| Requests to an AI provider | Only if a route sends them to a cloud provider; after redaction | Only to that provider |

Inkwright has no telemetry. Backups: snapshot the `vault` volume; it is plain files.

## Retention and legal hold

Set in the managed (or user) policy: `retention.activityDays`, `auditDays`, `historyDays`, and
`legalHold`. Pruning happens when the app opens a vault (activity, audit) or snapshots a note
(version history), and when the server starts (activity, audit, decided proposals); audit pruning removes whole months and records what it removed, so the remaining
chain still verifies. While `legalHold` is true nothing is pruned anywhere — not even the default
caps. Trash: notes in Trash are purged by the app after 30 days; under legal hold, keep backups of
the `vault` volume, because a user can still empty their Trash (Inkwright does not stop people
deleting their own notes).

## Audit and compliance exports

```sh
docker compose exec server /nodejs/bin/node dist/agent.js audit --vault /vault --export /tmp/audit.jsonl
docker compose cp server:/tmp/audit.jsonl ./audit-$(date +%F).jsonl
node apps/mcp-server/dist/agent.js audit --verify audit-2026-11-02.jsonl --expect-head <last export's head>
```

Feed the JSONL to your SIEM; record each export's head hash. The format is documented in
docs/TRUST.md › Audit trail.

## Supply chain

- `npm run sbom` writes a CycloneDX 1.6 SBOM (`sbom.cdx.json`) of shipped dependencies; the
  Security workflow builds one for every push and keeps it as an artifact. Attach it to releases
  and scan it with your tools (Dependency-Track, Grype).
- `npm run audit:deps` fails on high/critical advisories in shipped packages.
- CodeQL, Semgrep and gitleaks run on every push (`.github/workflows/security.yml`).
- Base images: `node:22-bookworm-slim` (build), `gcr.io/distroless/nodejs22-debian12:nonroot`
  (server), `nginxinc/nginx-unprivileged:1.27-alpine` (web), `rclone/rclone`, `ollama/ollama`.
  Pin by digest and rebuild on advisories.

## Hardening checklist

- [ ] TLS in front; HSTS at the terminator; the web port bound to localhost or a private interface.
- [ ] OAuth with your IdP (short-lived JWTs, `notes:write` granted only to clients that need it), or a long random token kept in a secret store.
- [ ] A managed policy committed to your config repo and reviewed like code.
- [ ] `INKWRIGHT_AUDIT_KEY` from a secret; its public fingerprint recorded; exports verified with `--trusted-key`.
- [ ] WebDAV users with strong passwords (`htpasswd -B`); one user per person.
- [ ] Images pinned by digest; SBOM attached to the deployment record; rebuild on advisories.
- [ ] Containers as shipped: non-root, read-only root filesystems, all capabilities dropped, `no-new-privileges`; don't add `privileged` or host networking.
- [ ] Backups of the `vault` volume, and a restore test.
- [ ] If any cloud provider is allowed: egress only through an allowlisting proxy; privacy kinds set to `redact`/`block`; budgets set.

## Threat model

Assets: note contents (including handwriting and recordings), the vault's integrity, AI keys and
tokens, the audit trail, the cost budget.

| Threat | Mitigation | Residual risk |
|---|---|---|
| Network attacker reads or alters traffic | TLS at the terminator; the internal network has no route out | Misconfigured TLS in front |
| Unauthenticated access to MCP/A2A | Loopback-only without credentials; token or OAuth (signature, issuer, audience, expiry, scopes) otherwise; Host/Origin checks against DNS rebinding | Leaked tokens until expiry |
| An authorised agent overreaching | Scopes (read vs write); notebook/tag access in `PolicyVault`; denied tools; dry run; Trash needs a person; everything in Activity (undo) and the audit trail | A user granting broad scopes |
| Prompt injection via notes, web or MCP content | Spotlighting; detection; confirmation guard; strict mode; destructive tools always ask | Detection misses new phrasings (docs/TRUST.md); a user approving a malicious prompt |
| Data exfiltration to a cloud AI | Routes, local-only notes, privacy firewall (redact/block), no egress by default | Personal data not matched by any recognizer; text in images |
| Path traversal / symlink escape via ids, assets or synced files | Id and asset-name validation; `NodeFS` resolves inside the root and re-checks after symlinks; tests with hostile inputs | — |
| SSRF | The server fetches only operator-configured URLs (IdP discovery/JWKS, AI endpoint); A2A push notifications are off | A malicious operator config |
| Tampering with the audit trail | Hash chain + ES256 signatures; head anchoring with `--expect-head` | Someone with the signing key rewriting a whole chain; tail truncation without an anchor |
| Runaway cost | Monthly budgets across devices; usage page; routes to the device | Providers without a known price (metered in tokens only) |
| Supply-chain compromise | Lockfile builds, SBOM, dependency audit, CodeQL/Semgrep, pinned images | Zero-days in dependencies |
| Compromised user device | Out of scope (keys there are non-extractable but usable by the device) | — |
