# Inkstone

Handwriting notes that feel like paper, on every device, with your own AI.

- **Paper feel.** Haptic paper grain spaced by distance (Android), a procedural nib-on-paper sound, and pressure- and tilt-aware pens: fountain, ballpoint, textured pencil, brush, marker, highlighter, dashed. Paper comes in three surfaces (smooth, standard, toothy) and nine tints.
- **Erase like on paper.**
  - Scribble over ink to delete it.
  - Press the pen button once to switch to the eraser and once more to switch back. Hold it to erase only while held.
  - The eraser end works too.
  - Choose a whole-stroke or precise (splitting) eraser.
- **Gestures.**
  - Hold a stroke still to snap it into a perfect line, circle, ellipse, rectangle or triangle.
  - Palm rejection: fingers scroll and pinch-zoom.
  - Two-finger tap undoes, three-finger tap redoes.
- **Lasso.** Move, resize, recolour, duplicate, copy, paste or delete the selection. Convert it to typed text, or ask AI about it.
- **Every kind of page.**
  - Paged notebooks (A4, Letter, Legal, A5, B5, A3, index card, phone, 16:9) and infinite boards.
  - Ruled, dot, square, engineering, isometric, Cornell, music, to-do, daily and weekly planner paper.
  - PDF import and annotation, images and camera photos, Markdown text boxes with checklists.
- **Audio notes.** Record while you write. On playback, tap any ink to hear what was said at that moment.
- **Organized.** Notebooks within notebooks, tags, pins, trash with undo. Search covers titles, typed text and recognized handwriting.
- **Your files.** Notes are saved as plain JSON ink, SVG and Markdown (`docs/VAULT_FORMAT.md`). Sync through Google Drive (sign in with Google), WebDAV or a local folder, with offline-first, stroke-level merging. Export vector PDF, PNG, SVG or Markdown, or make zip backups.
- **Any AI.**
  - Use your own key for OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Perplexity, Cerebras or Azure, a local model in Ollama or LM Studio, or any OpenAI-compatible server.
  - The assistant can transcribe handwriting, summarize, pull out to-dos, make flashcards, translate, answer questions across all your notes, and create, edit and organize notes.
- **Any agent.** The Inkstone MCP server (`apps/mcp-server`) lets Claude Desktop, Claude Code, Cursor, ChatGPT and other MCP clients search, read (including page images) and write your notes.
- **Every device.** Android (native haptics, pen-button keys, on-device ML Kit recognition), iPhone and iPad, and an installable offline app for Mac, Windows, Linux and ChromeOS.

## Quick start (development)

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests + evals
npm run e2e          # browser tests (Playwright)
```

Android: see `docs/ANDROID.md`. Publishing to the web, Play Store and App Store: see `docs/PUBLISHING.md`. Google sign-in and Drive: see `docs/GOOGLE_SETUP.md`.

## Layout

```
packages/core        algorithms, data model, vault, exporters (no platform code)
packages/ai          AI providers, agent, note tools, skills, evals
packages/sync        storage backends, Drive/WebDAV/folder sync, merge, backup
apps/web             the app (React + canvas ink engine), PWA, Capacitor Android/iOS
apps/mcp-server      MCP server for AI agents
docs/                architecture, vault format, setup, publishing, testing, privacy
```

Read `docs/ARCHITECTURE.md` for how it fits together and how to extend it.
