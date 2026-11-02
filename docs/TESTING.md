# Testing Inkstone

Three layers cover every feature.

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npm test` (Vitest, all workspaces) | core algorithms (table detection from strokes with near misses, ink cues for "=", circling and checklists, maths expression parsing/plotting, table edits that carry cell ink, authorship hash chain, classification and signed certificates with tamper cases, scratch-out, erasers, lasso, shapes, undo/diffs, paper templates, feel scheduler, sound synth, codec, vault, search, exporters); AI providers (wire formats, streaming, tool calls, errors, retries), agent loop, note tools, skills, secret store; storage backends (shared conformance suite), Drive/WebDAV remotes against fake servers, three-way merge, sync engine (two-device convergence, safety stops), zip backup; MCP server tools and stdio end-to-end |
| Evals | `npm run evals` | scribble-to-erase quality (`packages/core/evals/scratch.eval.ts`: 250 realistic scribbles — side-to-side, up-and-down, tilted, looping, fast flicks — and 330 things that must never erase — the next word, underlines, strike-throughs, circles, ticks, brackets, stars, arrows, shading on blank paper and inside a drawn box — across five zoom levels; bar: recall ≥ 95 %, false erases ≤ 1 %, neighbours erased ≤ 3 %); agent behaviour (picks the right tool, never deletes without permission, handles missing notes) and skill output parsing, against a scripted model. For live evals against a real model, set `INKSTONE_EVAL_PROVIDER`, `INKSTONE_EVAL_KEY` and `INKSTONE_EVAL_MODEL` (and optionally `INKSTONE_EVAL_MIN_SCORE`) |
| End-to-end | `npm run e2e` (Playwright, real Chromium) | the production build with synthetic stylus input (pressure, tilt, barrel button, eraser end), touch (palm rejection, pinch, multi-finger taps) and mouse, on desktop, foldable and phone screens. Writing and persistence across reloads, scratch-out, shape snapping, erasers, latching the pen button, lasso editing, text, pages, notebooks, trash, search, PDF import and vector PDF export, Markdown export, the AI assistant with a mocked OpenAI-compatible server (streamed tool calls), layout overflow and console errors; smart ink (draw a grid → table → write and type in cells; lasso an equation → Solve with a mocked vision model; circle a date → .ics download) and proof of authorship (sign, edit, export PDF → verify, tampered certificate rejected) |
| Android | `cd apps/web/android && ./gradlew testDebugUnitTest` | native plugin logic: stylus key mapping, refresh-rate choice, recognition payloads, the native writing-sound synth and grain scheduler (sample-exact against fixtures generated from the TypeScript reference), stroke arming and audio buffer sizing, the instant ink tip |

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

## Adding tests

- **New algorithm:** put it in `packages/core`, with a test next to the existing ones in `packages/core/test`.
- **New UI flow:** add a spec in `apps/web/e2e`. Use `pen()`, `pointer()`, `strokes()` and `texts()` from `e2e/helpers.ts`. Open the app with `?e2e` to get the document and engine hooks.
- **New agent tool:** add a case to `packages/ai/evals/cases.ts`.
