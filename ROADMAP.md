# Roadmap

Inkwright ships in small, tested steps. This page lists what is next and what is deliberately out of scope. Ideas and votes go to [Discussions](https://github.com/dev-null-k2/inkwright/discussions).

## Next

- **App stores.** Google Play (listing ready, see `docs/PUBLISHING.md`) and the iOS/iPadOS App Store (the app is built and tested on every change, and tagged releases upload to TestFlight once the Apple developer account is connected; see `docs/IOS.md`).
- **Real-device evals.**
  - Pen-to-pixel latency, measured with a high-speed camera on as many styluses as we can borrow.
  - Scribble-erase accuracy on recorded real handwriting rather than synthetic strokes.
- **Live collaboration** out of beta. This depends on TURN guidance and wider testing across different networks.
- **A desktop shell** (Tauri) with a bundled local-model runner and a background MCP server that starts with the computer.
- **Prompt-injection defence.** The current detector is a weak heuristic on held-out attacks (see the README). Planned work:
  - a small on-device classifier;
  - live-model evals in CI.
- **Handwriting citations.** Today `[@key]` citations work in typed text only; they should work in recognised handwriting too.

## Later

- An Apple Pencil hover preview, and squeeze and barrel-roll gestures.
- Shared team vaults with per-folder roles, built on the existing policy file.
- A federated search across a team's MCP servers.
- Plugin marketplace signing and reviews.

## Not planned

- An Inkwright cloud that holds your notes. The architecture is local-first on purpose: storage is yours (Google Drive, WebDAV, a folder or peer-to-peer).
- Training on user data. There is no Inkwright server to send it to.
