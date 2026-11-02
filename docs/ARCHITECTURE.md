# Inkstone architecture

Inkstone is a handwriting-first notes app. Writing has to feel like paper. Erasing, selecting and shaping happen with the pen, without menus. Notes stay plain files that any device, sync service or AI agent can use. One TypeScript codebase runs on Android, iOS, macOS, Windows, Linux, ChromeOS and the web. Android adds native code for things only native code can do.

## Principles

1. **Files are the source of truth.** Every note lives in an open, documented vault folder (`docs/VAULT_FORMAT.md`). The search index and thumbnails are caches and get rebuilt from the files. Sync, backup, the Mac and AI agents all work without a proprietary server.
2. **The pen path stays clear.** Wet ink is drawn on a separate `desynchronized` canvas that the compositor can present without waiting for the page. Saving, recognition, haptics, sound and sync all run beside that path, never on it.
3. **Pure core, thin platforms.** Every algorithm lives in `@inkstone/core`: scratch-out detection, erasing, lasso, shape recognition, the paper-feel scheduler, the writing-sound synth, undo, the vault format, exporters and search. It is plain TypeScript with unit tests, shared by the app, the sync engine and the MCP server.
4. **Every edit can be undone.** All changes are `PageDiff`s through `NoteDocument`, so scratch-outs, erasing, moving, recolouring, AI edits and conversions all undo exactly, z-order included.
5. **Bring your own everything.** You choose the AI (any provider, or a local model), the sync target (Google Drive, a folder, WebDAV) and the agent (any MCP client). Inkstone never needs its own backend.

## Repository

```
packages/core     @inkstone/core  model, codec, vault, geometry, gestures, shapes, ink outlines, paper
                                  templates, NoteDocument (undo), paper feel + writing sound, search, exporters
packages/ai       @inkstone/ai    providers (OpenAI-compatible family, Anthropic, Gemini, Claude-in-artifact),
                                  streaming + tool calling, agent loop, note tools, skills, secret store, evals
packages/sync     @inkstone/sync  storage backends (IndexedDB, File System Access, Capacitor, Node), remotes
                                  (Google Drive, WebDAV, folder), three-way merge, sync engine, zip backup
apps/web          @inkstone/web   the app: React UI + canvas ink engine; PWA; Capacitor Android/iOS shells
apps/mcp-server   @inkstone/mcp-server  MCP server exposing a vault folder to AI agents (stdio + HTTP)
docs/             architecture, vault format, setup, publishing, testing, privacy
```

## The ink engine (`apps/web/src/canvas/engine.ts`)

```
PointerEvent (pen/touch/mouse) ── pointerrawupdate / getCoalescedEvents ──► stroke points (page units, pressure, tilt)
        │                         getPredictedEvents (or velocity extrapolation) ──► prediction (drawn, never stored)
        ├─► wet canvas (desynchronized 2D context): perfect-freehand outline, drawn in the input handler
        ├─► PaperFeel: Android pen → native engine (MotionEvents → ScratchSynth on a low-latency AudioTrack + grain)
        │              elsewhere → GrainScheduler → haptic ticks · ScratchSynth in an AudioWorklet, updated per sample
        ├─► Android pen, opaque ink → instant ink tip: native front-buffered overlay draws the newest ~40 ms
        └─► on lift: NoteDocument.addStroke (scratch-out check) → base canvas redraw → autosave
```

- **Spaces.** A page unit is 1/96 inch. Pages stack vertically in document space, and boards are one infinite page. The viewport maps document to screen space as `screen = doc × zoom + pan`.
- **Tool resolution per contact.** The eraser end (`buttons & 32`) always erases. The barrel button (`buttons & 2`) or the Android Bluetooth key events act as the configured button tool: tap to latch it, hold to use it while held. Fingers scroll by default and can be set to draw or erase. A touch never inks while the pen is down or was near in the last 1.2 s, which gives palm rejection.
- **Gestures.**
  - *Scratch-out:* `detectScratchOut` needs a dense zig-zag that mostly lies on ink and mostly covers a stroke.
  - *Hold-to-shape:* 480 ms still → `recognizeShape`.
  - *Fingers:* two-finger tap undoes, three-finger tap redoes, pinch zooms, and a pan flings.
  - *Lasso:* selection moves and scales live with a transform and commits once.
- **Rendering.**
  - Committed strokes are cached `Path2D`s keyed by stroke identity, culled by bounds.
  - Highlighters are multiplied under the ink.
  - Pencil gets a paper-tooth grain.
  - Paper templates are batched into a few paths.
  - PDF backgrounds are rendered by pdf.js at zoom-dependent resolution.

## Data flow

`EditorSession` owns an open note. Edits mark pages dirty. A 650 ms debounce (and page hide) writes only the changed page files through `Vault.saveNote`, which also regenerates that page's SVG and the note's Markdown. It then re-indexes search and schedules sync. If a save fails, the dirty marks go back and the save is retried.

Sync (`@inkstone/sync`) compares content hashes with the last-synced state and remote revisions:

- Each file is pushed, pulled, deleted or merged.
- Ink and note files merge three-way by item id, so two devices editing offline never lose strokes.
- A safety check refuses runs that would delete most of a vault.

## AI (`@inkstone/ai`, `apps/web/src/lib/ai.ts`)

- **Providers:** one `Provider` interface over OpenAI-compatible APIs (OpenAI, OpenRouter, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Perplexity, Cerebras, Azure, Ollama, LM Studio, custom), Anthropic, Gemini, and Claude through the claude.ai `sample` capability. Requests stream, retry and send images. Tool calling is unified across providers, with a prompt-based fallback for models without native tools.
- **Agent:** `runAgent` runs a multi-step tool loop. `createNoteTools` gives it list, search, read, page image, create, append, update, notebooks and trash. Destructive tools need user confirmation.
- **App host:** `AppNoteToolHost` routes the agent's edits to the open note through `NoteDocument`, so they appear live and can be undone.
- **Skills:** transcribe handwriting (vision), summarize, to-dos, flashcards, translate, title/tags, answer from notes with citations.
- **Keys:** encrypted with a non-extractable WebCrypto key held in IndexedDB. They are never stored in settings or synced.

## Platforms

| Platform | How | Native extras |
|---|---|---|
| Android (Razr Fold, any) | Capacitor app (`apps/web/android`) | `InkstoneNative` plugin: haptic grain via `VibrationEffect` primitives, stylus/Bluetooth pen button keys, ML Kit on-device handwriting recognition, high refresh rate |
| iPhone / iPad | Capacitor iOS project (built on a Mac) | Apple Pencil through Pointer Events |
| Mac, Windows, Linux, ChromeOS | Installable PWA (works offline) | File System Access folder sync |
| Any browser | The same build | — |
| claude.ai preview | Single-file build (`vite build --mode single`) | Claude built in via `sample`; downloads via capability |

## Extending

- **A pen:** add it to `PenType`/`PEN_INFO`, give it a `penLook` and `outlineOptions` (core) and a `PenNib` drawing (web).
- **A paper:** add it to `PaperStyle`, then add a case in `paperElements` (`core/paper.ts`). It renders on screen, in thumbnails, SVG and PDF export automatically.
- **An AI provider:** add a registry entry in `packages/ai/src/providers/registry.ts`. Most are OpenAI-compatible and need only a base URL.
- **An agent tool:** add it in `createNoteTools` and implement it in `NoteToolHost`, both for the app (`lib/ai.ts`) and for the MCP server.
- **A sync target:** implement `Remote` (`list/read/write/delete`) and the engine does the rest.
- **A storage backend:** implement `VaultFS` and run the shared conformance suite in `packages/sync/test`.
