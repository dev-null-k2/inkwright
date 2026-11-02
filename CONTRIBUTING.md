# Contributing to Inkwright

Thanks for wanting to help. Inkwright is a handwriting-first notebook with an agent inside it, and it stays good only if every change keeps three promises: **ink never lags, your files stay yours, and AI never acts without a trace.**

## Ground rules

- **Plain files.** Anything new that's saved goes into the vault as readable JSON, Markdown or SVG, is optional, is documented in [`docs/VAULT_FORMAT.md`](docs/VAULT_FORMAT.md) and merges in `packages/sync`.
- **Provenance.** Ink, text and objects that AI creates carry `origin: 'ai'`. Agent writes go through `NoteDocument.commit`, so they land in the activity log and can be undone.
- **No stubs.** A feature ships working end to end, with tests, or it doesn't ship. Say what doesn't work in the docs rather than faking it.
- **Calm UI.** Use the Duan design tokens (`apps/web/src/styles/tokens.css`), sentence case and plain words. Jade means "you are here" and cinnabar means recording or destructive; neither is used anywhere else.
- **Modules, not a monolith.** New capabilities go in their own folder. They register with the app through its extension points (palette actions, settings slices, agent tools, MCP tools) and can be switched off.

## Setting up

```bash
git clone https://github.com/dev-null-k2/inkwright && cd inkwright
npm install
npm run dev            # http://localhost:5173
```

Android needs JDK 21 and the Android SDK (see [`docs/ANDROID.md`](docs/ANDROID.md)).

## Tests

Run these before opening a pull request.

| What | Command |
|---|---|
| Types | `npm run typecheck` |
| Unit tests and evals | `npm test` |
| One project | `npx vitest run --project core` (core, ai, sync, mcp, web, evals) |
| Browser end-to-end (Chromium) | `npm run e2e` |
| Every engine (WebKit, Firefox) | `npm run e2e:all` |
| Android JVM tests | `cd apps/web/android && ./gradlew testDebugUnitTest` |
| Android device or emulator | `npm run e2e:android` |

[`docs/TESTING.md`](docs/TESTING.md) explains what each layer covers. Specs must pass in every engine, so use the platform's modifier key and never hard-code Ctrl.

Changes to AI behaviour need an eval: add a scripted-model case to `packages/ai/evals` that fails without your change.

## Pull requests

- Keep each pull request to one change, with a description of what the user will notice.
- Include screenshots or a short clip for anything visual, in light and dark.
- Commits use [Conventional Commits](https://www.conventionalcommits.org) prefixes when they fit (`feat:`, `fix:`, `docs:`).
- By contributing you agree your work is licensed under Apache-2.0 (see [`LICENSE`](LICENSE)).

## Where to start

- Issues labelled `good first issue`.
- New paper templates, pens, palettes, agent skills (`SKILL.md` folders) and MCP tools are self-contained and welcome.
- Translations: the app copy lives in plain strings, so a translated README is a great first PR.
