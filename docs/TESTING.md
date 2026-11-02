# Testing Inkstone

Three layers cover every feature.

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npm test` (Vitest, all workspaces) | core algorithms (table detection from strokes with near misses, ink cues for "=", circling and checklists, maths expression parsing/plotting, table edits that carry cell ink, authorship hash chain, classification and signed certificates with tamper cases, scratch-out, erasers, lasso, shapes, undo/diffs, paper templates, feel scheduler, sound synth, codec, vault, search, exporters); AI providers (wire formats, streaming, tool calls, errors, retries), agent loop, note tools, skills, secret store; storage backends (shared conformance suite), Drive/WebDAV remotes against fake servers, three-way merge, sync engine (two-device convergence, safety stops), zip backup; MCP server tools and stdio end-to-end |
| Evals | `npm run evals` | scribble-to-erase quality (`packages/core/evals/scratch.eval.ts`: 250 realistic scribbles — side-to-side, up-and-down, tilted, looping, fast flicks — and 330 things that must never erase — the next word, underlines, strike-throughs, circles, ticks, brackets, stars, arrows, shading on blank paper and inside a drawn box — across five zoom levels; bar: recall ≥ 95 %, false erases ≤ 1 %, neighbours erased ≤ 3 %); agent behaviour (picks the right tool, never deletes without permission, handles missing notes) and skill output parsing, against a scripted model. For live evals against a real model, set `INKSTONE_EVAL_PROVIDER`, `INKSTONE_EVAL_KEY` and `INKSTONE_EVAL_MODEL` (and optionally `INKSTONE_EVAL_MIN_SCORE`) |
| End-to-end | `npm run e2e` (Playwright, real Chromium) | the production build with synthetic stylus input (pressure, tilt, barrel button, eraser end), touch (palm rejection, pinch, multi-finger taps) and mouse, on desktop, foldable and phone screens. Writing and persistence across reloads, scratch-out, shape snapping, erasers, latching the pen button, lasso editing, text, pages, notebooks, trash, search, PDF import and vector PDF export, Markdown export, the AI assistant with a mocked OpenAI-compatible server (streamed tool calls), importing a skill folder, running a routine against the mocked model and undoing its change from AI activity, the assistant menu, undo from the chat and memory (`e2e/agent.spec.ts`), links and the knowledge graph (`e2e/knowledge.spec.ts`: `[[` autocomplete and following a link, backlinks, rename updating links, unlinked mentions, `#tags`, lassoed ink as a link, Today, templates, the 3D graph in WebGL (SwiftShader) with filters, time slider and 2D, Obsidian zip export and vault-folder import from `e2e/fixtures/obsidian-vault`), layout overflow and console errors; smart ink (draw a grid → table → write and type in cells; lasso an equation → Solve with a mocked vision model; a solved function → live graph; circle a date → .ics download) and proof of authorship (sign, edit, export PDF → verify, tampered certificate rejected) |
| Assistant | `npx vitest run --project ai`, `npx vitest run --project evals packages/ai/evals/assistant.eval.ts` | MCP client against an in-process SDK server behind `fetch` (2026-07-28 and 2025 fallback, bearer and full OAuth with PKCE/registration/refresh, Tasks, CORS diagnosis, per-tool approval in the agent loop); SKILL.md parsing/validation, import, progressive disclosure; memory proposals; routine scheduling, catch-up and triggers on a fake clock; activity recording and undo (also of MCP-server writes, `apps/mcp-server/test/activity.test.ts`); transcribers. Evals score skill use and approval behaviour with negative controls |
| Outside agents | `npx vitest run --project mcp` | MCP server with SDK clients in-process: 2026-07-28 (`server/discover`, `_meta` envelope) and 2025 clients over HTTP, both over stdio; OAuth resource server against a local jose issuer (metadata, 401 challenge, audience/expiry/issuer/signature, step-up `insufficient_scope`); Tasks lifecycle through the app's own client (progress, `input_required` approval, cancel, ownership, -32602/-32021); MCP Apps resources and tool links; A2A with the official `@a2a-js/sdk` client (card v1.0/v0.3, SendMessage with citations, streaming, INPUT_REQUIRED approval, cancel, v0.3 `message/send`, token); the runner on a fake clock (catch-up, lease handover and expiry, note-saved trigger, deferred approvals); launchd/systemd/Task Scheduler files. e2e: `agent.spec.ts` shows the runner notice on the Routines screen |
| Android | `cd apps/web/android && ./gradlew testDebugUnitTest` | native plugin logic: stylus key mapping, refresh-rate choice, recognition payloads, the native writing-sound synth and grain scheduler (sample-exact against fixtures generated from the TypeScript reference), stroke arming and audio buffer sizing, the instant ink tip |

### Studio tools

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project core packages/core/test/pro.test.ts` | calligraphy outline (thick across the nib, hairline along it, nib angle per stroke), selective eraser filters, layer order/visibility/locking and scratch-out on a locked layer, snapping to items, margins, paper lines and resize corners, sticky/tape geometry and SVG order, encryption at rest with wrong-passcode and swapped-file cases, snapshots with dedupe, shared blobs, retention, pruning, sealed history and minimal restores in the authorship chain |
| Unit | `npx vitest run --project web apps/web/src/canvas/layout.test.ts apps/web/src/studio` | two-page layout and Auto rule; app snapshots on open/edit/before assistant edits; locked sessions and search |
| Unit | `npx vitest run --project mcp apps/mcp-server/test/studio.test.ts` | agent writes snapshot first; locked notes are blank to agents and refuse writes |
| End-to-end | `cd apps/web && PW_PORT=4189 npx playwright test e2e/studio.spec.ts --project desktop` | long-press eraser filters, snapping with guides and Alt, sticky notes (write, type, fold, undo), tape and study mode, calligraphy nib angle, two-page view input mapping, layers, version history restore and copy-in, locking (cover, passcode gate, search, no plaintext in IndexedDB) |

## Testing on a device

The pen-on-glass feel, haptics, Bluetooth pen buttons and real latency can only be judged on hardware. On the Razr Fold:

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
