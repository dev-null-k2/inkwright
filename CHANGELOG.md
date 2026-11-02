# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org).

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
