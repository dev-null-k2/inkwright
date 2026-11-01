# Testing Inkstone

Three layers cover every feature.

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npm test` (Vitest, all workspaces) | core algorithms (scratch-out, erasers, lasso, shapes, undo/diffs, paper templates, feel scheduler, sound synth, codec, vault, search, exporters); AI providers (wire formats, streaming, tool calls, errors, retries), agent loop, note tools, skills, secret store; storage backends (shared conformance suite), Drive/WebDAV remotes against fake servers, three-way merge, sync engine (two-device convergence, safety stops), zip backup; MCP server tools and stdio end-to-end |
| Evals | `npm run evals` | agent behaviour (picks the right tool, never deletes without permission, handles missing notes) and skill output parsing, against a scripted model. For live evals against a real model, set `INKSTONE_EVAL_PROVIDER`, `INKSTONE_EVAL_KEY` and `INKSTONE_EVAL_MODEL` (and optionally `INKSTONE_EVAL_MIN_SCORE`) |
| End-to-end | `npm run e2e` (Playwright, real Chromium) | the production build with synthetic stylus input (pressure, tilt, barrel button, eraser end), touch (palm rejection, pinch, multi-finger taps) and mouse, on desktop, foldable and phone screens. Writing and persistence across reloads, scratch-out, shape snapping, erasers, latching the pen button, lasso editing, text, pages, notebooks, trash, search, PDF import and vector PDF export, Markdown export, the AI assistant with a mocked OpenAI-compatible server (streamed tool calls), layout overflow and console errors |
| Android | `cd apps/web/android && ./gradlew testDebugUnitTest` | native plugin logic (stylus key mapping) |

## Testing on a device

The pen-on-glass feel, haptics, Bluetooth pen buttons and real latency can only be judged on hardware. On the Razr Fold:

1. Install the APK (`docs/ANDROID.md`).
2. Write fast and slow, then scribble out a word.
3. Press the pen button once (eraser latches, a red pill appears), press it again (back to the pen), then hold it while erasing.
4. Rest your palm while writing. Pinch, two-finger tap and three-finger tap.
5. Fold and unfold mid-note: the view keeps its place.
6. Settings → Writing feel: try each paper surface and turn grain strength up and down.
7. Settings → Handwriting: on-device engine. Write a line, then search for it in the library.

## Adding tests

- **New algorithm:** put it in `packages/core`, with a test next to the existing ones in `packages/core/test`.
- **New UI flow:** add a spec in `apps/web/e2e`. Use `pen()`, `pointer()`, `strokes()` and `texts()` from `e2e/helpers.ts`. Open the app with `?e2e` to get the document and engine hooks.
- **New agent tool:** add a case to `packages/ai/evals/cases.ts`.
