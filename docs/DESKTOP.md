# The desktop app (macOS, Windows, Linux)

`apps/desktop` wraps the web app in a [Tauri 2](https://tauri.app) shell. It is the same Inkwright
— one TypeScript codebase — plus what only a desktop app can do:

| | What it does | Where |
|---|---|---|
| **Your notes in a folder** | The vault is a real folder (default `~/Documents/Inkwright`, or your home folder when the OS has no Documents folder), shared with the MCP sidecar, Obsidian, backup tools and folder sync. Changes others make there show up in the app. | `src-tauri/src/vault.rs`, `watch.rs`; `apps/web/src/desktop/fs.ts` |
| **Tray** | Closing the window keeps Inkwright running in the tray (switchable), so routines, the evening journal, the memory timeline and agents keep working. The tray menu opens the app or the timeline, pauses capture, and quits. | `lib.rs` |
| **Launch at login** | Opt-in (Settings › Desktop app); starts hidden in the tray. | `tauri-plugin-autostart` |
| **`inkwright://` links** | The same links as the Android app and the API (docs/API.md § Links): `inkwright://new?title=…`, `open`, `search`, `capture`, `today`. A second launch hands its link to the running app. | `tauri-plugin-deep-link`, `tauri-plugin-single-instance` |
| **Open with… for PDFs** | Registered as a viewer for `.pdf` (rank "Alternate": it never takes over as the default). The file is imported as a note to read, annotate, fill and sign. | `bundle.fileAssociations` |
| **Agents with the window closed** | The MCP server runs as a sidecar on `http://127.0.0.1:7337/mcp` with a bearer token. | `sidecar.rs`, `scripts/build-sidecar.mjs` |
| **Memory timeline capture** | The window in front, as facts and pixels for the on-device pipeline (docs/MEMORY_TIMELINE.md). | `recall.rs` |
| **Calendar subscriptions** | Fetches `.ics` addresses for the journal (calendar servers send no CORS headers). | `calendar.rs` |
| **Updates** | Checked daily, downloaded in the background, installed when you choose to restart; every update must be signed with the project's key. | `tauri-plugin-updater` |

The web app finds out it is in the desktop shell at run time (`__TAURI_INTERNALS__`,
`apps/web/src/desktop/bridge.ts`) and every desktop call is a dynamic import, so the web and Android
builds carry none of it. The `desktop` module (Settings › Modules) owns links, opened files, tray
commands and updates; Settings › Desktop app holds the folder, login, tray, agents and updates.

## Building

Prerequisites: Node 22, Rust (stable), and the platform's webview libraries:

- **macOS**: Xcode command line tools.
- **Windows**: Visual Studio Build Tools (C++), WebView2 (preinstalled on Windows 11).
- **Linux** (Debian/Ubuntu): `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf`, and for screen capture `libpipewire-0.3-dev libspa-0.2-dev libclang-dev libxcb1-dev libxcb-randr0-dev libwayland-dev libegl-dev libgbm-dev`.

```sh
npm ci
npm run sidecar -w @inkwright/desktop     # the MCP server as one executable (once per change to it)
cd apps/desktop
npx tauri dev                              # the web app's dev server in the desktop shell
npx tauri build                            # installers for this OS (runs the web build and the sidecar first)
npx tauri build --target universal-apple-darwin   # macOS: Apple silicon + Intel in one app
npm run check                              # cargo check + cargo test
npm run icons                              # regenerate icons from apps/web/public/icons/icon.svg
```

The web build for the shell is `vite build --mode desktop` (`apps/web/dist-desktop`): no service
worker (the shell serves the files), the content security policy from `tauri.conf.json` (which
adds Tauri's IPC to the web build's policy), and the on-device OCR files for the memory timeline.

## The MCP sidecar

The MCP server (`apps/mcp-server`, the same `inkwright-mcp` people install with npm) is built into
a single executable with **Node's single executable applications** (SEA): esbuild bundles it into
one CommonJS file, `node --experimental-sea-config` makes a blob, and postject injects it into a
copy of the Node binary (re-signed ad hoc on macOS; the release build signs it again). For a macOS
universal build the script fetches the official Node binary for the other architecture, checks it
against `SHASUMS256.txt` and joins both with `lipo`.

Why SEA: it is Node itself — no third-party runtime patching (pkg is unmaintained, nexe lags
behind), the server runs on exactly the Node it is tested with, and it builds on every CI runner.
The cost is size: about 125 MB on disk (43 MB gzip-compressed, 29 MB with xz, as measured for the Linux x86_64 build). The server's optional
add-ons are left out of the sidecar: PNG page rendering (`@resvg/resvg-js`; agents get SVG and PDF)
and the code graph's grammars (the `inkwright` developer CLI, installed with npm, has them).

While Inkwright runs, the shell starts it with `--vault <your folder> --http 7337` and the token in
the environment (`INKWRIGHT_MCP_TOKEN`), never on the command line, where other users of the
computer could read it. It listens on 127.0.0.1 only and refuses requests without the token. It is
restarted if it stops (at most three times a minute); its last lines of output are in Settings ›
Desktop app. To connect Claude Code:

```sh
claude mcp add --transport http inkwright http://127.0.0.1:7337/mcp --header "Authorization: Bearer <token from Settings › Desktop app>"
```

Clients that launch servers themselves (Claude Desktop's stdio config) can point at the sidecar
executable inside the app (`Inkwright.app/Contents/MacOS/inkwright-mcp`, `inkwright-mcp.exe` next
to `Inkwright.exe`, `/usr/bin/inkwright-mcp` from the .deb) with `--vault <folder>`. The AI policy
(docs/TRUST.md) applies to agents either way.

## Updates: setting up the key

The updater refuses any update not signed with the project's key, so the key pair must exist
before the first release:

```sh
npx tauri signer generate -w ~/.tauri/inkwright.key     # keep the private key and its password safe
```

- Put the **public key** (the `.pub` file's contents) in the repository variable
  `TAURI_UPDATER_PUBKEY` (Settings › Secrets and variables › Actions › Variables). The release
  workflow writes it into the build; `tauri.conf.json` keeps the placeholder
  `REPLACE_WITH_YOUR_UPDATER_PUBLIC_KEY` so no key is committed. For local release builds, put it
  in `plugins.updater.pubkey` instead.
- Put the **private key** and its password in the secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Builds without both produce no update signatures and the app shows "This build has no update
  key" and never checks. The endpoint is
  `https://github.com/dev-null-k2/inkwright/releases/latest/download/latest.json`, which the
  release workflow writes from the build's signatures and uploads with each release (change it in
  `tauri.conf.json` for a fork).

If the private key is lost, installed apps can't be updated by a new key: they must be reinstalled.

## Releasing

`.github/workflows/desktop.yml`:

- **On pull requests** that touch the desktop app or the MCP server: builds the sidecar and runs
  `cargo test` on macOS, Windows and Linux.
- **On a version tag** (`git tag v1.2.0 && git push --tags`): `tauri build` makes a universal macOS
  `.dmg`, Windows `.msi` and NSIS `.exe`, and Linux `.deb`, `.rpm` and `.AppImage`, with the version
  from the tag (only plain versions such as `1.2.0` or `1.2.0-beta.1` are accepted). A separate
  publish job attaches them, their update signatures and `latest.json` (when the updater key is
  set) to the version's GitHub release, the same one `release.yml` makes for Android and the web.

The release follows the security review's hardening (docs/SECURITY_REVIEW.md, SR-09): actions are
pinned to commit SHAs; the build jobs, which run project code, have a read-only token and no
persisted git credentials, and only the publish job, which runs no project code, can write; the
release build uses no cache; each signing secret reaches only the step that needs it; and the
Windows certificate is removed from the runner after the build, even when it fails.

Signing happens when the secrets exist and is skipped when they don't (the build still works):

| Platform | Secrets | Without them |
|---|---|---|
| macOS | `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`; notarization: `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` | Ad hoc signed: Gatekeeper asks users to allow it in System Settings › Privacy & Security |
| Windows | `WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD` | Unsigned: SmartScreen warns |
| Linux | — | Packages are not signed (the usual for direct downloads) |
| Updates | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, variable `TAURI_UPDATER_PUBKEY` | No self-update |

## Permissions the OS will ask for

- **macOS**: *Screen Recording* the first time capture is switched on (the memory timeline; System
  Settings › Privacy & Security › Screen & System Audio Recording), *Microphone* for recordings and
  optional timeline transcription. Launch at login uses a LaunchAgent.
- **Windows**: none beyond the microphone prompt.
- **Linux**: none on X11. Wayland sessions don't allow capturing other windows (the app says so).

## Security

- The window loads only the bundled app; capabilities (`src-tauri/capabilities/default.json`) give
  it the plugins' minimum permissions, and the CSP is the web build's, plus Tauri's IPC.
- Every vault path from the web view is checked in Rust: relative, `/`-separated, no `..`, no
  drive or root components, and no symlinks out of the vault folder. Writes are atomic.
- `opened_file_read` reads only paths the OS handed to Inkwright ("Open with", a second launch).
- The MCP token is 32 random bytes from the OS, stored owner-only (`0600`) in the app's config
  folder, passed through the environment, and replaceable in Settings.
- Calendar fetching accepts only `https:`/`webcal:` addresses, at most 10 MB, and only iCalendar
  content.

## What has been verified, and where

| Verified | How |
|---|---|
| The Rust side compiles and its tests pass on Linux (x86_64): vault path checks, atomic writes, symlink escapes, folder watching (own writes ignored), settings and token, sidecar arguments and restart budget (with a fake server that exits), frame signature and OCR image, own windows by process, calendar address checks, file arguments | `cargo test` (17 tests) on Linux during development; on macOS, Windows and Linux in CI (`desktop.yml`, on every pull request that touches the app) |
| The sidecar builds as a Node SEA executable on Linux and serves MCP over HTTP with the token (401 without it, tools listed with it) | `npm run sidecar`, then a client against it |
| The real app runs on Linux (WebKitGTK, Xvfb): the web app boots in the shell, writes the vault through the Rust commands into the folder, the sidecar starts with the generated token and lists the note the app wrote | debug build, run headless (during development, not in CI) |
| `tauri.conf.json` validates against Tauri's schema | `tauri inspect` |
| The web side of the desktop features: DesktopFS over the shell, the capture loop with real OCR and redaction, tray state, external-change handling | Vitest and Playwright with the shell mocked (`e2e/memory.spec.ts`) |

Only CI or a real machine can verify:

- **macOS**: the universal build and `lipo`ed sidecar, signing and notarization, Screen Recording
  permission and xcap capture, `IsSecureEventInputEnabled`, the tray as a template icon, the
  LaunchAgent, `webcal:`/`inkwright:` links and "Open with" from Finder (`RunEvent::Opened`).
- **Windows**: the MSVC build, WebView2, UI Automation password detection, `GetLastInputInfo`,
  the NSIS/MSI installers and their file association and URL scheme registration, code signing.
- **Linux**: the `.deb`/`.rpm`/`.AppImage` packages, the tray on real desktops (GNOME needs the
  AppIndicator extension), capture and focus detection under a real window manager (Xvfb has
  none), GNOME/KDE idle and lock over D-Bus.
- **Everywhere**: the updater end to end (needs a signed release), and OCR speed on real screens.
- **The release workflow** itself runs only on a version tag: the installers' names as collected,
  the merged `latest.json` and signing with real secrets are first exercised by a tagged release
  (a pre-release tag such as `v1.0.1-rc.1` is the safe way to try it).
