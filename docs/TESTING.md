# Testing Inkwright

Three layers cover every feature.

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npm test` (Vitest, all workspaces) | core algorithms (table detection from strokes with near misses, ink cues for "=", circling and checklists, maths expression parsing/plotting, table edits that carry cell ink, authorship hash chain, classification and signed certificates with tamper cases, scratch-out, erasers, lasso, shapes, undo/diffs, paper templates, feel scheduler, sound synth, codec, vault, search, exporters); AI providers (wire formats, streaming, tool calls, errors, retries), agent loop, note tools, skills, secret store; storage backends (shared conformance suite), Drive/WebDAV remotes against fake servers, three-way merge, sync engine (two-device convergence, safety stops), zip backup; MCP server tools and stdio end-to-end |
| Evals | `npm run evals` | scribble-to-erase quality (`packages/core/evals/scratch.eval.ts`: 250 realistic scribbles — side-to-side, up-and-down, tilted, looping, fast flicks — and 330 things that must never erase — the next word, underlines, strike-throughs, circles, ticks, brackets, stars, arrows, shading on blank paper and inside a drawn box — across five zoom levels; bar: recall ≥ 95 %, false erases ≤ 1 %, neighbours erased ≤ 3 %); agent behaviour (picks the right tool, never deletes without permission, handles missing notes) and skill output parsing, against a scripted model. For live evals against a real model, set `INKWRIGHT_EVAL_PROVIDER`, `INKWRIGHT_EVAL_KEY` and `INKWRIGHT_EVAL_MODEL` (and optionally `INKWRIGHT_EVAL_MIN_SCORE`) |
| End-to-end | `npm run e2e` (Playwright, real Chromium) | the production build with synthetic stylus input (pressure, tilt, barrel button, eraser end), touch (palm rejection, pinch, multi-finger taps) and mouse, on desktop, foldable and phone screens. Writing and persistence across reloads, scratch-out, shape snapping, erasers, latching the pen button, lasso editing, text, pages, notebooks, trash, search, PDF import and vector PDF export, Markdown export, the AI assistant with a mocked OpenAI-compatible server (streamed tool calls), importing a skill folder, running a routine against the mocked model and undoing its change from AI activity, the assistant menu, undo from the chat and memory (`e2e/agent.spec.ts`), links and the knowledge graph (`e2e/knowledge.spec.ts`: `[[` autocomplete and following a link, backlinks, rename updating links, unlinked mentions, `#tags`, lassoed ink as a link, Today, templates, the 3D graph in WebGL (SwiftShader) with filters, time slider and 2D, Obsidian zip export and vault-folder import from `e2e/fixtures/obsidian-vault`), layout overflow and console errors; smart ink (draw a grid → table → write and type in cells; lasso an equation → Solve with a mocked vision model; a solved function → live graph; circle a date → .ics download) and proof of authorship (sign, edit, export PDF → verify, tampered certificate rejected), live transcripts from Chromium's fake microphone lined up with ink, asking during a recording, page summaries and dictation (`e2e/listen.spec.ts`; real on-device speech opt-in in `e2e/listen-real.spec.ts`) |
| Assistant | `npx vitest run --project ai`, `npx vitest run --project evals packages/ai/evals/assistant.eval.ts` | MCP client against an in-process SDK server behind `fetch` (2026-07-28 and 2025 fallback, bearer and full OAuth with PKCE/registration/refresh, Tasks, CORS diagnosis, per-tool approval in the agent loop); SKILL.md parsing/validation, import, progressive disclosure; memory proposals; routine scheduling, catch-up and triggers on a fake clock; activity recording and undo (also of MCP-server writes, `apps/mcp-server/test/activity.test.ts`); transcribers. Evals score skill use and approval behaviour with negative controls |
| Outside agents | `npx vitest run --project mcp` | MCP server with SDK clients in-process: 2026-07-28 (`server/discover`, `_meta` envelope) and 2025 clients over HTTP, both over stdio; OAuth resource server against a local jose issuer (metadata, 401 challenge, audience/expiry/issuer/signature, step-up `insufficient_scope`); Tasks lifecycle through the app's own client (progress, `input_required` approval, cancel, ownership, -32602/-32021); MCP Apps resources and tool links; A2A with the official `@a2a-js/sdk` client (card v1.0/v0.3, SendMessage with citations, streaming, INPUT_REQUIRED approval, cancel, v0.3 `message/send`, token); the runner on a fake clock (catch-up, lease handover and expiry, note-saved trigger, deferred approvals); launchd/systemd/Task Scheduler files. e2e: `agent.spec.ts` shows the runner notice on the Routines screen |
| Android | `cd apps/web/android && ./gradlew testDebugUnitTest` | native plugin logic: stylus key mapping, refresh-rate choice, recognition payloads, the native writing-sound synth and grain scheduler (sample-exact against fixtures generated from the TypeScript reference), stroke arming and audio buffer sizing, the instant ink tip, WebView renderer-loss recovery |
| Every browser engine | `npm run e2e:all` | the end-to-end suite on Chromium plus WebKit (Safari on macOS; iPad and iPhone screens with touch) and Firefox. See [Browsers and platforms](#browsers-and-platforms) |
| Android app | `npm run e2e:android` | the real app (debug APK) in an Android emulator or on a USB-connected phone: Playwright drives its WebView over CDP, adb sends real stylus MotionEvents, logcat is checked for crashes, ANRs and native evidence. See [Android emulator and devices](#android-emulator-and-devices) |

Developer module (code graphs, links and drift, diagrams, runbooks, session journals): see
[DEVELOPERS.md § Tests](DEVELOPERS.md#tests) — unit tests in `packages/core/test/dev`, the
`create_diagram` repair-loop eval, MCP tools and the spawned `inkwright` CLI in
`apps/mcp-server/test/dev.test.ts`, and `e2e/dev.spec.ts`.

## Browsers and platforms

Inkwright runs in three browser engines. What each platform uses:

| Platform | Engine | Covered by |
|---|---|---|
| Android app (Razr Fold etc.) | Android System WebView (Chromium) | projects `desktop`, `foldable`, `phone`; `npm run e2e:android` for the real app |
| Windows, Linux, ChromeOS: Chrome, Edge, Brave | Chromium | `desktop` (Edge is Chromium; Windows-only differences are keyboard modifiers, covered in `e2e/platform.spec.ts`) |
| Windows, macOS, Linux: Firefox | Gecko | `firefox-desktop` |
| macOS: Safari | WebKit | `webkit-desktop` |
| iPad and iPhone: every browser, and the Capacitor iOS app | WebKit (WKWebView) | `webkit-ipad` (iPad Pro 11 with touch and a Mac user agent, as iPadOS sends), `webkit-iphone` |

```sh
npm run e2e                     # Chromium only (desktop, foldable, phone) — the everyday run
npm run e2e:all                 # + webkit-desktop, webkit-ipad, webkit-iphone, firefox-desktop
npm run e2e:all -- --project webkit-ipad e2e/ink.spec.ts   # one engine, one spec
```

`e2e:all` (`apps/web/scripts/e2e-all.mjs`) installs Playwright's WebKit and Firefox for the pinned `@playwright/test` version on first use. If a shared Chromium lives in `/opt/pw-browsers` (CI images, the dev container), the extra engines go into a separate folder (`/opt/pw-extra`, else `~/.cache/pw-extra`, or `INKWRIGHT_PW_EXTRA`) that links to that Chromium, so the shared install is never modified. Under the hood it sets `INKWRIGHT_ENGINES=all`, which adds the four projects to `playwright.config.ts`; any port is fine (`PW_PORT=4184 npm run e2e:all`).

Writing specs that pass everywhere:

- Shortcuts: press `${await modKey(page)}+z` (helpers.ts), never `Control+z`: the app listens for ⌘ on Macs, iPads and iPhones.
- Console checks: filter with `isEngineNoise()`; Safari logs our viewport meta's `interactive-widget` key (used by Chrome on Android) as unknown, and Firefox logs the CSP-blocked eval that zod makes to probe for eval support.
- Open the app with `openApp()`: on Linux WebKit it removes `AudioContext` first, because Playwright's Linux WebKit (GStreamer, no sound server) sometimes froze the page's main thread for good when a note started the writing-sound AudioWorklet. Safari on Apple devices uses Core Audio and is not affected; Chromium and Firefox keep audio.
- Route mocks: Playwright's WebKit cannot fulfil a route with a redirect status (302); serve a page that navigates instead (see `e2e/apps.spec.ts`).
- Pixel checks: poll (`expect.poll(() => inkAt(…))`); WebKit repaints the canvas on its next frame, which can come later than 80 ms on a busy machine.
- WebKit and Firefox projects get a 90 s test timeout (Chromium 45 s); they are slower headless.
- Firefox did not route the AI worker's download requests through `page.route`, so the resumable-download test is skipped there too.
- Resumable model downloads need the Origin Private File System. Playwright's WebKit sessions are ephemeral and WebKit refuses OPFS there, like Safari private windows, so `e2e/local-ai.spec.ts` skips that one test on WebKit; the app falls back to transformers.js's own cache.

Result on 2 Nov 2026 (Playwright 1.63; WebKit 26.6, Firefox 155, Chromium): desktop 63 passed / 3 skipped, foldable 9/9, phone 9/9, webkit-desktop 62 / 4 skipped, webkit-ipad 9/9, webkit-iphone 9/9, firefox-desktop 62 / 4 skipped. The skips are the two opt-in real-model downloads, the touch-only search test on desktop screens, and the resumable-download test on WebKit and Firefox (above).

What this does not cover: the iOS app build itself (Xcode on a Mac: `npx cap sync ios`, open `apps/web/ios/App/App.xcodeproj`), Apple Pencil hardware (pressure/tilt are synthetic here), Safari-only behaviour that Playwright's Linux WebKit build lacks (Apple Pay, iCloud Keychain, system fonts), and Windows Ink specifics beyond Pointer Events. Real Safari on macOS and iPadOS should be spot-checked before a release.

## Android emulator and devices

`apps/web/scripts/android/` runs the real app, not a browser imitation:

| Script | What it does |
|---|---|
| `create-avd.sh` | installs the emulator and system image with `sdkmanager` and creates the `inkwright-atd33` AVD (API 33 AOSP ATD image, x86_64, a scaled-down foldable inner screen) |
| `boot.sh [--cold] [--no-wait]` | boots it headless and waits for Android (and its package manager); disables animations, keeps the screen on. Uses KVM when `/dev/kvm` is usable and software CPU emulation otherwise |
| `build-apk.sh` | `vite build --mode native` with the e2e hook (`INKWRIGHT_E2E_HOOK=1` → `window.__inkwright`), `cap sync`, `gradlew assembleDebug`. Extra Gradle arguments: `INKWRIGHT_GRADLE_ARGS` |
| `app.sh` | `install`, `launch`, `stop`, `reset`, `screenshot NAME`, `theme light\|dark`, `cdp` (forwards `webview_devtools_remote_<pid>` to `localhost:9333`), `logcat NAME`, `check-crashes NAME` |
| `run-smoke.sh [--build] [--shutdown]` | all of it: boot → install → clean start → Playwright (`playwright.android.config.ts`, `e2e-android/`) → logcat → crash/ANR check → `native-evidence.txt` |

```sh
export ANDROID_HOME=/opt/android-sdk            # or your SDK
apps/web/scripts/android/build-apk.sh           # once per change to the app
npm run e2e:android                             # boots the emulator if needed
ANDROID_SERIAL=<serial from adb devices> npm run e2e:android   # a USB-connected phone instead
```

The smoke spec (`e2e-android/smoke.spec.ts`) checks, in one app session: the app runs in the native shell; `InkwrightNative.capabilities()` reports `nativeFeel`, `inkTip`, `recognition` and `stylusKeys`; the library and welcome note; a new note and synthetic pen strokes; scratch-out; a real stylus stroke from `adb shell input stylus swipe` (a `MotionEvent` with `TOOL_TYPE_STYLUS`, so the activity's ink-tip and paper-feel paths see it before the WebView); the Writing feel popover and its native sample stroke; haptics and ink-tip calls on a device without a vibrator; dark mode following the system; PDF import; Settings; and finally logcat: the writing-sound stream opened (`InkwrightFeel: Writing sound: … Hz`), the ink-tip overlay did not fail, no crash or ANR of `app.inkwright`. Screenshots (light and dark) and logs land in `apps/web/test-artifacts/android/` (git-ignored); `cdp-protocol.log` traces the DevTools traffic.

Everything is configurable through environment variables in `scripts/android/env.sh` (`INKWRIGHT_AVD_IMAGE`, `INKWRIGHT_AVD_RAM_MB`, `INKWRIGHT_EMU_GPU`, `ANDROID_SERIAL`, `INKWRIGHT_CDP_PORT`, …).

### Without hardware virtualisation (CI containers, cloud VMs)

The emulator still runs when there is no `/dev/kvm`: QEMU emulates the x86_64 CPU in software (`-accel off`). It warns "x86_64 emulation may not work without hardware acceleration", and it works, slowly. Measured on a 2-core container with ~6 GB shared with other builds:

- **Image:** `system-images;android-33;aosp_atd;x86_64` (the leanest API ≥ 29 image: no Play services, Go-sized system). API 35 images insist on ≥ 2.5 GB guest RAM, which does not fit next to other work on such a machine.
- **Boot:** 3½–5½ minutes cold (adb after ~1½–2 min, `sys.boot_completed` 2–3 min later); install of the 40 MB APK ~1½–2 min; app start ~40 s.
- **Memory:** the emulator process takes guest RAM + QEMU's translation cache + ~0.6 GB. Defaults: 1024 MB guest RAM and `-qemu -tb-size 128` (QEMU 2.12 otherwise reserves guest RAM / 4 for translated code). With 2–3 GB guest RAM the host's OOM killer took the emulator down whenever Gradle or browsers ran alongside. Quick-boot snapshots are off by default for the same reason (saving needs as much memory again; `INKWRIGHT_SAVE_SNAPSHOT=1` to enable).
- **Stability:** a starved guest can miss ANR deadlines in system services and restart its framework once after boot; `boot.sh` waits for the package manager, rate-limits the network-stack crash (`device_config … always_ratelimit_networkstack_crash`) and installs with `pm.dexopt.install=verify` (no minutes-long ahead-of-time compile).
- **GPU:** `-gpu swiftshader_indirect` (host software GL, default) or `INKWRIGHT_EMU_GPU=guest`; both boot. ATD images have no system UI, so a screenshot shows only the app's window.

**Known limit — WebView 101 under software CPU emulation.** The API 33 ATD image ships Android System WebView 101 and has no Play Store to update it. Under TCG its renderer process dies with `SIGTRAP` in `libwebviewchromium.so` about 60–90 s after it starts, every time, for any page: the AOSP HTML viewer showing a static page crashes the same way, so it is the emulated environment, not Inkwright. Tried without success: V8 `--jitless` (via `/data/local/tmp/webview-command-line`), guest-side GPU emulation, fewer screen pixels. Until the WebView has drawn a frame the window is black, so screenshots from such a machine are black too. With hardware virtualisation (or on a phone, whose WebView is current) this does not happen. What it found: Android's default when a renderer dies is to kill the whole app — so the app now recovers instead (`webview/RendererRecovery.kt`: recreate the activity, at most 3 times a minute). Because the renderer is still busy loading for most of that minute under TCG, the WebView-driven part of the smoke suite cannot complete on such a machine; run `npm run e2e:android` on a machine with KVM (any Linux desktop, or a CI runner with nested virtualisation) or against a USB-connected phone.

### Studio tools

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project core packages/core/test/pro.test.ts` | calligraphy outline (thick across the nib, hairline along it, nib angle per stroke), selective eraser filters, layer order/visibility/locking and scratch-out on a locked layer, snapping to items, margins, paper lines and resize corners, sticky/tape geometry and SVG order, encryption at rest with wrong-passcode and swapped-file cases, snapshots with dedupe, shared blobs, retention, pruning, sealed history and minimal restores in the authorship chain |
| Unit | `npx vitest run --project web apps/web/src/canvas/layout.test.ts apps/web/src/studio` | two-page layout and Auto rule; app snapshots on open/edit/before assistant edits; locked sessions and search |
| Unit | `npx vitest run --project mcp apps/mcp-server/test/studio.test.ts` | agent writes snapshot first; locked notes are blank to agents and refuse writes |
| End-to-end | `cd apps/web && PW_PORT=4189 npx playwright test e2e/studio.spec.ts --project desktop` | long-press eraser filters, snapping with guides and Alt, sticky notes (write, type, fold, undo), tape and study mode, calligraphy nib angle, two-page view input mapping, layers, version history restore and copy-in, locking (cover, passcode gate, search, no plaintext in IndexedDB) |

### Context compiler

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project core packages/core/test/compiler.test.ts` | sentence splitting, extraction with anchors (typed, handwriting, speech), entities/dates/actions by rule, quantities and conflicts, provenance (locate, staleness, merge), planning and incremental work, validation of model drafts, diffs and per-claim choices, people consent, FSRS scheduling and deck merge, rule-made cards and grading, packs and AGENTS.md, answer attribution |
| Unit | `npx vitest run --project ai packages/ai/test/compiler.test.ts` | compile → proposal → apply → provenance → undo (`text_replaced`) over a vault, user lines kept, rejections remembered, silent re-anchoring, archiving, ledger decisions and model adjudication, model cards and teach-back grading, McNemar and the memory eval, agent tools |
| Unit | `npx vitest run --project sync packages/sync/test/compiler-merge.test.ts`, `--project mcp apps/mcp-server/test/packs.test.ts`, `--project web apps/web/src/compiler` | provenance and deck merges; packs as MCP resources; passages from tool results |
| Evals | `npx vitest run --project evals packages/core/evals/compiler.eval.ts packages/ai/evals/compiler.eval.ts` | contradiction precision/recall (58 labelled pairs) and noise floor (40 everyday notes), staleness, anchors; drafts against a noisy scripted model (provenance precision, pass-through, recall, tag accuracy); live model with `INKWRIGHT_EVAL_*` |
| End-to-end | `cd apps/web && PW_PORT=4192 npx playwright test e2e/compiler.spec.ts --project desktop` | compile → review → accept → Explain with thumbnails → conflicts → stale → re-check → undo; study review with a typed answer and FSRS ratings; context pack (skill zip, save for MCP); model drafts with dropped sentences; memory eval; Explain this answer; conflict badge in the editor |

### Modules, plugins and the API

| Layer | Command | What it covers |
| --- | --- | --- |
| Unit | `npx vitest run --project platform` | manifest validation (every error at once, permissions, hosts, AI tools need `ai:tools`), version ordering, note scopes, the network allowlist, the plugin client over a fake host (calls, errors, invokes, events, timeouts); the example plugins and the template validate; the SDK is regenerated and compared with the committed file, then used against a real server (ETags, idempotent retries after a lost answer, problem errors, pagination) and its Web Crypto webhook check against the server's signer |
| Unit | `npx vitest run --project core packages/core/test/platform.test.ts`, `--project sync packages/sync/test/merge-platform.test.ts` | API keys (hash-only storage, malformed/unknown/revoked/expired), plugins.json decoding; sync merges (newest record, uninstall vs update, keys never dropped, revocation wins) |
| Unit | `npx vitest run --project mcp apps/mcp-server/test/api.test.ts apps/mcp-server/test/webhooks.test.ts` | the REST API over HTTP with **contract tests**: every response validated against the served OpenAPI document with Ajv (JSON Schema 2020-12), and every documented operation must be exercised; auth modes and scopes, keyset pagination and filters, ETag/If-None-Match/If-Match, Idempotency-Key replay/reuse, 400/404/405/412/415/422/429 problems, rate-limit headers, CORS, pages as ink/text/SVG/PNG/PDF, exports, search, links, graph, assets, keys API and CLI, webhooks end to end (signed delivery verified, an external write becoming `note.created`); Standard Webhooks test vector, the retry schedule on a fake clock, 410, persistence across restarts; vault events (created, updated, trashed, restored, recordings, routine runs) |
| Unit | `npx vitest run --project web apps/web/src/modules apps/web/src/plugins apps/web/src/developer` | module dependencies (transitive, cycles), presets, palette/settings gating, lazy start/stop of background work, assistant tools from modules; the dispatcher (permissions and live revocation, scopes, locked notes, network allowlist without cookies, storage limits, events); plugin packages (top folder, junk and data.json dropped, size and version limits, zip and URL sources) and the vault store (install, update keeps data, uninstall); deep-link parsing |
| End-to-end | `cd apps/web && PW_PORT=4191 npx playwright test e2e/extensibility.spec.ts --project desktop` | Settings › Extend › Modules (dependency prompt, Minimal and Developer presets reach the editor and survive reload); installing the word-count plugin from the curated list (permission prompt, sandboxed panel updating live, palette command, exporter download, revocation refusing the next call, uninstall); a plugin from a URL proving its sandbox (fetch, parent and storage blocked, unpermitted calls refused) with a plugin importer; the webhook plugin posting the selection through the host without cookies; links (`?action=new`, `web+inkwright://search`, open, capture with origin `import`); `window.inkwright` with per-permission refusal and API keys created once, listed and revoked |

### Trust and cost

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project ai packages/ai/test/trust.test.ts` | policy parsing (bad fields keep safe defaults), compact serialization, managed-policy merge, routing (local-only notes pull a run onto the device); validators (Luhn, mod-97, Verhoeff), detection with look-alikes, stable placeholders and rehydration (also streamed); shape-aware shortening, determinism, retrieval and sticky expansion; prices and the ledger across devices; audit chain signing, tamper cases (edit, remove, reorder, forged signature, cut tail) and retention; spotlighting and the injection guard in a real agent run; notebook permissions; the guarded provider (redaction round trip, device routing, budgets, `retrieve_original`, tasks switched off); proposals |
| Unit | `npx vitest run --project mcp apps/mcp-server/test/trust.test.ts` | the policy vault on every tool, resource and search (hidden, local-only, read-only, nested notebooks), managed policy, dry run for MCP writes, audit of reads/writes and `inkwright-agent audit` verification, the server agent through the guarded provider, retention; security review: hostile ids on every tool, resource URIs, symlink escapes, `/healthz`, body limit, no SSRF surface |
| Evals | `npx vitest run --project evals packages/ai/evals/trust.eval.ts` | privacy firewall precision/recall per kind; context budgeter benchmark (tokens and answer quality with and without, including where it costs more); injection detection, attack success with and without the guard, held-out cases and strict mode. Numbers are published in docs/TRUST.md |
| End-to-end | `cd apps/web && PW_PORT=4193 npx playwright test e2e/trust.spec.ts --project desktop` | the provider never sees an email the user does; AI usage and the audit trail (verify, JSONL export); Routing & privacy writes `ai/policy.json`; a local-only notebook stops a cloud run, a hidden one is invisible; dry run → proposal with a diff → approve |
| Appliance | `docker compose -f deploy/docker-compose.yml config` | compose file validity (no daemon needed); `docker build -f deploy/Dockerfile --target server .` where a daemon is available |

### Ink actions

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project core packages/core/test/papers.test.ts packages/core/test/datasandbox.test.ts packages/core/test/canvasdag.test.ts packages/core/test/photoink.test.ts packages/core/test/inkanswer.test.ts` | BibTeX/CSL-JSON parsing (macros, LaTeX, names), round trips, APA 7 and IEEE formatting, citations and autocomplete, PDF matching; CSV/JSON typing, read-only SQL, the repair loop, charts; diagram graphs from messy sketches (boxes four ways, heads, hooks, frames, cycles), ops, running, cancel and re-run; page detection, homography, Sauvola, Zhang–Suen and tracing measured by Chamfer distance on synthetic photos; answer placement, layout, write-on and authorship; read-aloud order |
| Unit | `npx vitest run --project web apps/web/src/inkactions` | AI ink through the document (one undo step), SQLite engine with real errors in the repair loop, data tables, bibliography of a note, module registration and tools |
| Eval | `npx vitest run --project evals packages/core/evals/canvasdag.eval.ts` | graph extraction over 120 synthetic sketches (bar in docs/INK_ACTIONS.md) |
| Eval | `npx vitest run --project evals apps/web/evals/mathink.eval.ts` | handwritten maths: 350 synthetic problems (arithmetic, fractions, powers, equations, systems) in three hands, read before/after with simulated ML Kit and the built-in classifier; exact-match and solve-correct per category; `INKWRIGHT_SAMPLES=<file>` adds recorded real handwriting (numbers and bar in docs/MATH.md) |
| End-to-end | `cd apps/web && PW_PORT=4195 npx playwright test e2e/ink-actions.spec.ts e2e/a11y.spec.ts --project desktop` | answers in ink and typed, the assistant's `write_in_ink`, a drawn diagram run with fetch, local and AI steps, re-run and keep, loops refused, CSV drop → DuckDB → ask with repair → table and chart, spreadsheets, photo to ink with corners and underlay, read aloud with highlighting and the reading view, BibTeX import → PDF by DOI → `[@` autocomplete → APA/IEEE → BibTeX export, modules switched off; axe-core over library/editor/settings, keyboard paths, reduced motion and contrast |

### Menus, Settings, first run and fit

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project web apps/web/src/ui/editorMenu.test.tsx apps/web/src/settings apps/web/src/welcome apps/web/src/devicecheck` | where each editor ••• command goes (about ten top-level entries with everything on, lasso-first commands left to the selection bar, nothing lost); Settings groups, old section ids, search ranking and what a device lacks; when the welcome shows; the device check's rates, latency, frame pacing, fit rules and report |
| End-to-end | `cd apps/web && PW_PORT=4201 npx playwright test e2e/settings.spec.ts e2e/welcome.spec.ts e2e/devicecheck.spec.ts e2e/fit.spec.ts --project desktop` | search jumps to a setting (keyboard too), every indexed setting is where the index says, old `#settings/<id>` links; the welcome's four steps, skip, Google without a client ID, links honoured; the device check on a synthetic pen; at fold, phone and tablet sizes with system bars: the library, the editor menu and each sub-sheet, every dialog the editor menu opens, the lasso toolbar, the pen dock, the AI panel to its end, every Settings tab, the welcome |

### Founder feedback: finger drawing, theme, "+", documents, signing, the click-everything audit

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project core packages/core/test/richdoc.test.ts`, `--project sync packages/sync/test/document-merge.test.ts`, `--project ai packages/ai/test/document-tools.test.ts` | Markdown blocks (fenced code kept whole), the paragraph-level three-way merge (edits on two devices, conflicting edits kept twice, one-sided deletions, 3 000-paragraph documents), outline and word count, the assistant's edits with explanations when they can't apply, `edit_document` through the agent loop and undo through `replaceText` |
| Unit | `npx vitest run --project web apps/web/src/documents apps/web/src/ui/ux.test.ts` | Markdown ↔ editor round trip of every block and mark (byte-identical), escaping, sanitising; .docx written and read back to the same document; PDF pagination (never through a line or table row, manual breaks, tall pictures); the theme cycle, the finger toggle, a photo's page size and the "open ready to sign" hand-off |
| End-to-end | `cd apps/web && PW_PORT=4208 npx playwright test e2e/documents.spec.ts e2e/ux.spec.ts e2e/touch-finger.spec.ts --project desktop` (`touch-finger` also runs on `foldable` and `phone`) | a document written with the toolbar, keyboard and Markdown shortcuts, saved as Markdown, reloaded, found by search; pen annotation, eraser, ink undo; PDF/Word/Markdown/HTML export checked inside the files; .docx and .md import; print; the assistant reading and editing the open document with undo from the chat; the theme switch in both top bars (remembered; instant with reduced motion); "+" tap and hold (same paper, new page, template, document, PDF to sign); top bars at 412 and 720 px (nothing off screen or overlapping, the title keeps room, the theme moves into ••• when folded); Sign a document from the New menu (a photo becomes a PDF), the palette, "+" and the welcome, to an exported signed PDF; finger drawing off/on with synthetic touch, two-finger pans, the stylus prompt, persistence and the welcome's choice |
| Audit | `cd apps/web && PW_PORT=4208 npx playwright test e2e/click-everything.spec.ts --project desktop` | at 720×800 with system bars: every library control and drawer entry, every editor ••• command, the "+" menu, the pen dock, the AI panel, every Settings section and the document editor — no console errors, everything that opens fits, every enabled control changes something, every disabled one says why. Buttons that pick files, download, record, sign in or delete are left to their own specs |
| Screenshots | `cd apps/web && PW_PORT=4208 npx playwright test e2e/ux-shots.spec.ts --project desktop` | the library and editor top bars, the pen dock with Draw with finger, the "+" menu, the document editor with ink and the sign flow at 720×800, light and dark, in `test-results/ux/` for review |

The suite starts every test as someone who has finished the welcome (`storageState` in
`playwright.config.ts`); `welcome.spec.ts` clears it. Menu paths go through `editorMenu(page,
'Share & export', 'PDF')` and `editorMenuCommands(page)` in `e2e/helpers.ts`, Settings through
`settingsGroup(page, 'Privacy & trust', 'Authorship')`, so a regrouping is one change in the app
and none in the specs that only use a command.

## Testing on a device

The pen-on-glass feel, haptics, Bluetooth pen buttons and real latency can only be judged on hardware. On the Razr Fold:

0. Settings › About › **Check this device**: draw on the test pad for a few seconds with the pen, make the report and share it. It records the pen's event and sample rates, pressure, tilt and twist, input-to-paint latency, frame pacing while drawing, the screen and system bars (browser and Capacitor), memory, graphics and audio latency, and whether the app fits the screen, as text and JSON. Attach it to any bug report about feel or layout.
1. Install the APK (`docs/ANDROID.md`).
2. Write fast and slow, then scribble out a word.
3. Press the pen button once (eraser latches, a red pill appears), press it again (back to the pen), then hold it while erasing.
4. Rest your palm while writing. Pinch, two-finger tap and three-finger tap.
5. Fold and unfold mid-note: the view keeps its place.
6. In a note, tap the sound-wave button (or More → Writing sound & feel): change the volume (letting go plays a sample stroke), each paper surface and the grain strength. The sound should start with the ink and stop when the nib stops, even with the pen resting on the glass.
7. Write fast with a fountain pen and watch the nib: the newest part of the line should stay under it (Settings → Pen & touch → Instant ink). If the tip ever looks offset from the ink, turn it off and note the screen (folded/unfolded, split screen).
8. Settings → Handwriting: on-device engine. Write a line, then search for it in the library.
9. Smart ink: draw a box with two lines across it and rest the pen — "Make a table" appears; write in a cell (it is recognized on the device). Write `2x + 3 =` and rest — "Solve". Write "Dentist Fri 3pm", circle it — the calendar card appears; "Add to calendar" opens the calendar app prefilled.
10. Studio: write with the calligraphy pen at different angles (Pen settings › Nib angle) — thick downstrokes, thin hairlines. Unfold the Razr Fold with a multi-page note open: two pages side by side; write on the right-hand page. Put a sticky note on a page and write on it with the pen; tape over a word and tap it with a finger and with the pen. Lock a note, close it, reopen it with the passcode.

## Adding tests

- **New algorithm:** put it in `packages/core`, with a test next to the existing ones in `packages/core/test`.
- **New UI flow:** add a spec in `apps/web/e2e`. Use `pen()`, `pointer()`, `strokes()` and `texts()` from `e2e/helpers.ts`. Open the app with `?e2e` to get the document and engine hooks.
- **New agent tool:** add a case to `packages/ai/evals/cases.ts`.
- **Two devices or two people:** `e2e/peer.spec.ts` opens two browser contexts in one Chromium (separate storage, separate keys) and connects them with real WebRTC; the test itself carries the codes between the pages, which is exactly the no-server signalling path. It clears STUN (host candidates only) and launches Chromium with `--disable-features=WebRtcHideLocalIpsWithMdns`, because two headless contexts can't resolve each other's mDNS names. Crypto, framing and two engines converging over an in-memory link are unit tests (`packages/sync/test/peer.test.ts`).
