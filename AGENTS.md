# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor, Gemini CLI) working in this repository. People should start with [CONTRIBUTING.md](CONTRIBUTING.md). For connecting agents *to a user's notebook*, see [docs/AGENTS.md](docs/AGENTS.md).

## Map
- `packages/core`: pure TypeScript with no DOM or platform code. Model (`model.ts`), vault (`vault.ts`), `NoteDocument` (undo and commit), gestures, handwriting synthesis, compiler, code graph (`dev/`).
- `packages/ai`: providers, `runAgent`, tools, the trust guard (`trust/`), the compiler (`compiler/`), evals in `evals/`.
- `packages/sync`: backends and the three-way merge. Every new vault field needs a merge rule and a test here.
- `apps/web`: the React app. The ink engine is `src/canvas/engine.ts`. Features live in their own folders and register in `src/modules/builtin.ts`.
- `apps/mcp-server`: MCP, A2A, REST (`src/api`), webhooks, the runner and the CLI.

## Rules
1. New vault fields are optional. Document them in `docs/VAULT_FORMAT.md` and merge them in `packages/sync`.
2. Anything AI creates carries `origin: 'ai'` and goes through `NoteDocument.commit`.
3. Every model call goes through `getActiveAI()` (the guarded provider). Check `aiCanSee` and `aiMaySend` before sending note content.
4. A new feature is a module with an off switch. Keep edits to `Editor.tsx`, `Settings.tsx`, `Library.tsx` and `AIPanel.tsx` small and additive.
5. Use the design tokens in `apps/web/src/styles/tokens.css`, never hex values in components. Use sentence case.
6. Logic gets unit tests (Vitest), flows get Playwright specs that run in every engine, and AI behaviour gets an eval with a scripted model.

## Commands
```sh
npm run typecheck
npx vitest run --project <core|ai|sync|mcp|web|platform|evals> <path>
cd apps/web && PW_PORT=4300 npx playwright test e2e/<spec>.ts --project desktop
```
