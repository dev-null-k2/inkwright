# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Meetings
- **Enhanced notes**: write what matters during a meeting; afterwards your notes are written out
  in full from what was said, shaped by a template. Your own words stay, in ink colour; what the AI
  added is grey and links to the moment it was said. Edit by asking, check off action items, edit
  a line, versions with restore. Works with the on-device model, offline ([MEETINGS.md](docs/MEETINGS.md)).
- **15 templates** (1:1, stand-up, sales call, customer discovery, interview, investor, kickoff,
  retro, design review, lecture and more) and your own; **recipes** on one meeting or across
  meetings (follow-up email, PRD, coach me, feature requests, weekly recap…) and your own.
- **Meetings** in the library: coming up from your calendars with join links, one tap to take
  notes (attendees, call link and template filled in), a brief before each meeting from earlier
  ones with the same people, reminders, people and companies, and ask across meetings.
- **Record a call** without a bot: both sides of Zoom, Meet or Teams in Chrome, Edge and the
  Windows app, with who spoke; delete transcript lines and name speakers; optionally delete the
  audio once it is transcribed.
- **Share** to Slack, Teams, Discord, Notion, Linear, Jira, GitHub, Todoist, HubSpot, Attio and
  any webhook, always with a preview; copy as rich text, Markdown or for Slack; email attendees.
- The AI's additions written onto the page in AI ink, in a hand matched to yours.

### iPhone and iPad
- The native iOS app: Apple Pencil pressure, tilt and hover, with double-tap and squeeze switching
  to the tool chosen in Settings › Pen button and back; Apple's on-device model (iOS 26, Apple
  Intelligence on) as the assistant's private engine, answering from your notes with citations;
  notes as plain files in the Files app (On My iPad › Inkwright); **Open in Inkwright** for PDFs,
  images and text from Files and other apps; `inkwright://` links from Shortcuts and other apps;
  Inkwright's own icon (light, dark and tinted) and launch screen, with no white flash in dark
  mode.
- Every change is built on a Mac and run on the newest iPhone Pro and iPad Pro simulators in light
  and dark mode: the library, a lecture, a pen stroke that must reach the note's file, the
  assistant, a meeting and settings, with screenshots of each.
- Tagged releases upload to TestFlight once the Apple developer account is connected
  (docs/IOS.md).
- **The web app on iPhone and iPad, as a Home Screen app**: Safari suggests Add to Home Screen
  (which also keeps Safari from clearing notes after a week away), Google sign-in works there
  (Google's page opens in the app and comes back), and storage is kept when space runs low.
- **The web app works offline again in every browser.** Its offline part (the service worker) had
  a syntax error since the first release and listed a file the build drops, so browsers never
  installed it. Tests now check that it parses, installs and opens the app without a network, and
  publishing checks every file it installs is there.
  When it updates it now removes only its own older copies of the app, never downloaded engines
  or files shared to the app.
- Downloading an engine in Settings (code parsers, DuckDB, the on-device AI) no longer sometimes
  goes back to "Download" after finishing.
- **Updates for the web app, like Android's**: a new deployment shows "Inkwright … is ready" with
  What's new, Later and Update in the library, and Settings › About › Updates; after updating the
  library says "Updated to …" once. The hosted app's version is now the latest release plus the
  commits since.
- CI runs the web app in Safari on the newest iPhone and iPad simulators: writing and keeping a
  note, the offline app, the on-device AI answering, and an update from one deployment to the next.

### Updates from inside the app (Android)
- The Android app checks GitHub Releases on its own and offers new versions in a banner and in Settings › About › Updates, with what's new. Update downloads, verifies (SHA-256 and the same signing key as the installed app) and installs it; on Android 12 and later, updates after the first install without a confirmation screen. Beta updates can be switched off. The Google Play bundle has no updater (docs/UPDATES.md).
- Every release, betas included, now gets a higher Android version code, so each beta installs as an update over the previous one.

### On-device AI that answers from what you wrote
- The assistant never shows raw tool-call syntax. Tool calls are read in every dialect small
  models write (Gemma 4 / LiteRT-LM, Qwen/Hermes, Llama, Mistral, JSON, Python-style), invented
  tool names and wrong argument shapes are repaired, and a call that can't be read gets one retry.
- With an on-device model the page's handwriting is recognized on the device before asking, and
  the page, the lasso selection, the best passages from your notes and relevant memory are given
  to the model as numbered sources. "What's the budget here?" answers from the page; a dodge like
  "please provide more context" is replaced by what your notes say; nothing found says so plainly.
- Lasso Ask AI, Write the answer here and Convert to text read handwriting on the device first
  and send pictures only to strong cloud or self-hosted vision models; Convert says who read it.
- Chats are kept per note (and as general chats) across restarts, with Chats › New chat and past
  chats in the assistant panel; every engine gets the earlier turns.
- Study cards and Teach me back skip recognizer fragments like "ools".
- Settings › AI on Android: AICore restarting while it installs Gemini Nano is retried
  automatically and described calmly (raw codes under Details); every download button shows
  "Downloading… n%" with Cancel, then Ready.
- `npm run eval:local` runs a real small model on the CPU against these cases (docs/LOCAL_AI.md).

### Sharing and pairing
- Share live, pair a device and Sync now with one short code (`K7PM-2Q9X`), a QR code or a link
  sent from the share sheet — typed one way, no code back. The code is a CPace password, so the
  relay (ntfy.sh by default, your own ntfy, or `inkwright-mcp --signal-token`) learns nothing it
  could use; codes work once, for ten minutes, and lock after five wrong tries. The long codes
  remain under Advanced for use without any relay (docs/COLLABORATION.md).
- Paired devices keep listening on a self-hosted relay even if it refused them at first (the
  token is read for each request).

### Writing on a phone or a fold
- **Draw with finger**: one tap in the pen dock (also ••• › Page and the search palette) lets one
  finger write while two fingers scroll and zoom; remembered per device, the same setting as the
  welcome's "With my finger". Touching the screen with a stylus offers to switch back.
- **One-tap theme**: Light, Dark or System from the library and editor top bars, with a short
  cross-fade (instant with reduced motion). On narrow phones it is the first row of •••.
- **"+" on every page**: a new note with the same notebook and paper; press and hold (or
  right-click) for a new page, a template, a document or a PDF to sign. The library's New menu
  is reachable on screens below 900 px too.

### Documents and signing
- **Documents**: a rich-text note type (headings, lists, checklists, tables, pictures, quotes,
  code, page breaks) with an outline and word count, which you can also mark up with the pen.
  Stored as Markdown in the note (docs/VAULT_FORMAT.md › Documents), merged paragraph by paragraph
  when two devices edit it. Export to PDF, Word, Markdown and HTML; open or insert .docx, .md and
  .html files; print. The assistant reads and edits documents (`read_document`, `edit_document`,
  undoable from AI activity).
- **Sign a document** from the library's New menu, the editor's "+", the search palette and the
  welcome: pick a PDF or a photo of a page, fill it in, place a saved signature, export or share.

### Fixes
- Disabled buttons now say why (Query data, Photo to ink, Lock note, plugin install from a link,
  the AI panel without a provider); "List all fonts" reports when the browser declines.
- Opening a note with typed text straight from a reload no longer throws before the context
  compiler starts.

### Agents and the server
- Credential executor: provider keys and connector tokens held by a separate process that makes
  calls with them, policy-checked and audited, and never hands a key out (docs/CREDENTIALS.md).
- Context-saving proxy for other tools (`inkwright-mcp proxy`), with `compress_and_store` and
  `retrieve_original` over MCP; savings show on the AI usage page (docs/PROXY.md).
- Team search across teammates' own servers: `team_search`, `/api/v1/federated/*`, the
  `federation:search` key scope (docs/FEDERATION.md).
- An open format for context packs with a JSON Schema, a conformance suite and
  `inkwright context validate` (spec/personal-context/v1.md).
- The runner can re-scan repositories when their git HEAD moves, and run runbook shell blocks
  approved and signed in the app (docs/DEVELOPERS.md).

### Notes from other apps
- Importers for Notion, Evernote, OneNote and GoodNotes/Notability PDFs, and a web clipper
  bookmarklet (docs/IMPORTERS.md); OpenClaw and pi transcripts in agent session import.

### Handwritten maths
- Solve reads the strokes on the device: symbols are grouped from the ink, recognized with ML Kit
  on Android (ranked candidates per symbol), the browser's handwriting API or a built-in
  classifier, and parsed in 2-D — fractions, exponents, roots, systems — choosing the reading
  that is valid maths. A picture goes to an AI only when that reading is unsure, and only to a
  strong cloud model, never a small on-device one. Results say who read them (docs/MATH.md).
- Exact answers and worked steps computed on the device: fractions, order of operations,
  percentages, linear and quadratic equations, 2 × 2 systems.
- Settings › About › Check this device › Record handwriting samples saves your strokes and what
  you meant to a file you can share, for tuning the reader.

### Fixes
- REST keyword search no longer returns notes the AI policy hides from agents.

## 1.0.0 — first public release

### Getting around
- A short first-run welcome (how you write, colours, where AI runs, sync, sample notebooks); skippable and shown once.
- The editor's ••• menu keeps ten entries, with the rest in named sub-sheets (Insert, Page, Audio, Study, Share & export, Note, Tools); lasso actions live in the lasso bar.
- Settings in eight groups with a search field that jumps to any setting; old `#settings/<id>` links still work.
- Settings › About › Check this device: pen rate, pressure and tilt, input-to-paint latency, frame pacing, screen and system bars, hardware, graphics and audio, and a live layout check, as a report to copy or share.
- Every menu, sheet and dialog fits a folded phone, a phone and a tablet between the system bars.

### Writing
- Low-latency ink with prediction, and a native ink tip on Android.
- Synthesised paper sound and haptic grain.
- Pressure- and tilt-aware pens, including a calligraphy nib.
- Scribble to erase; the pen button latches the eraser.
- Shape snapping, lasso, layers, tape, sticky notes, two-page spreads, version history and locked, encrypted notes.
- Paper templates; PDF import, annotation, form filling and signatures.

### AI and agents
- Any provider or an on-device model.
- An agent with note tools, Agent Skills, memory, routines with triggers, and an activity log with undo.
- An MCP client and server (spec 2026-07-28), A2A, and an always-on runner.
- Smart ink: tables, maths, graphs, dates.
- Notes that listen, with on-device transcripts aligned to ink.
- Answers in ink, and executable sketches.
- A data sandbox (DuckDB-WASM) and photo to ink.

### Knowledge
- Links, backlinks, daily notes, templates, a 3D graph, Obsidian import and export, and search over everything.
- A compiled wiki with per-sentence provenance and "Explain this answer".
- A contradiction linter, FSRS study and teach-back.
- Context packs and AGENTS.md export; People and follow-ups.
- A paper workbench: BibTeX and CSL-JSON import, citations, APA and IEEE bibliographies.

### Trust
- A guarded AI checkpoint: policy routing, a privacy firewall, a reversible context budgeter, usage and cost metering, and a signed audit trail.
- Per-notebook permissions, dry-run proposals and prompt-injection defences.
- An enterprise appliance with an SBOM and security workflows.
- Proof-of-authorship certificates.
- An independent security review before release (docs/SECURITY_REVIEW.md), with its fixes: plugins run only with consent given on each device (a plugin installed or changed through sync or a backup asks for a review once); a sealed DuckDB, runbook and plugin sandbox; no cloud backup of keys on Android; credentials never restored from backups; pinned, least-privilege CI.

### Platform
- A module registry with presets.
- Sandboxed plugins with a plugin API.
- A REST API with OpenAPI 3.1, an SDK, Standard Webhooks, API keys and deep links.
- The developer module: code graph, drift detection, verified diagrams, runbooks, session lessons, CLI and Agent Skill.
- Accessibility: read aloud, a reading mode, keyboard navigation and an axe-clean UI.
- Android, iOS (Capacitor) and an installable web app; tested on Chromium, WebKit and Firefox.
- A desktop app for macOS, Windows and Linux (Tauri 2): notes as a folder, tray, launch at login, `inkwright://` links, Open with for PDFs, signed updates and the MCP server running alongside (docs/DESKTOP.md).
- A memory timeline (opt-in, desktop): the window in front read on the device, redacted before it is saved, kept for the days you choose, searchable in plain words and erasable everywhere; and a journal that writes itself each evening from your notes, recordings, calendars and the timeline, every sentence with its sources (docs/MEMORY_TIMELINE.md).
- A lean, fast app: a 20 MB download from Google Play on an arm64 phone (a 37 MB APK from GitHub), and the library is usable in 1.1 s on a mid-range phone's CPU. DuckDB, the on-device AI runtime and the code parsers download once, verified, when first used; release builds are shrunk with R8 and split per ABI ([PERFORMANCE.md](docs/PERFORMANCE.md)).
