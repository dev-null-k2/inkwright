# Modules and plugins

Inkwright is built from switchable **modules** (its own features) and can run **plugins** (code
other people write). Both are designed so that adding or removing something never puts a note
at risk: data a feature wrote stays in the vault whether the feature is on, off or uninstalled.

- [Modules](#modules) — Settings › Extend › Modules
- [Plugins for users](#plugins-for-users) — Settings › Extend › Plugins
- [Writing a plugin](#writing-a-plugin) — manifest, API, permissions, sandbox
- [How plugins, MCP servers, the REST API and window.inkwright fit together](#how-it-fits-together)

## Modules

Every major feature declares itself in a typed registry (`apps/web/src/modules/`):

```ts
registerModule({
  id: 'smart-ink',
  name: 'Smart ink',
  description: 'Turns drawn grids into tables, solves handwritten maths…',
  defaultEnabled: true,
  dependencies: [],
  contributes: { panels: ['Suggestion chips'], objectTypes: ['table', 'math', 'graph'] },
  whenOff: 'Tables, results and graphs stay on the page…',
  activate: async () => { /* dynamic import, start background work */ return () => { /* stop */ }; },
  aiTools: async () => [/* assistant tools while on */],
});
```

| Field | What the app does with it |
| --- | --- |
| `contributes` | Lists menu items, palette actions, panels, page-object types, assistant tools, importers/exporters, routine templates, settings sections, screens and background work. Palette actions and settings sections owned by a switched-off module disappear automatically; Settings › Extend › Modules shows the list under "What it adds". |
| `dependencies` | Turning a module on turns on what it needs; turning it off asks before also turning off what needs it. |
| `activate` | Runs (lazily, with dynamic imports inside) while the module is on; the returned function runs the moment it is switched off. Declarations are plain data, so startup stays fast. |
| `aiTools` | Collected by the assistant (`prepareAgentRun`) from modules that are on. |
| `whenOff` | Shown in Settings: what happens to existing data. |

Built-in modules (`modules/builtin.ts`): Fill & sign, Smart ink, Notes that listen, Links & daily
notes, Graph (needs Links), Studio tools, Assistant & routines, Compiled wiki & study (needs the
assistant), On-device AI, Search everything, Proof of authorship, Colour palettes, Plugins,
Developer tools (needs Plugins; off by default) and Links from other apps. Writing, pages,
notebooks, sync, export and undo are the core and always on.

**Presets** switch sensible sets: Student, Writer, Developer, Researcher, Enterprise (no
third-party plugins or developer access) and Minimal (paper and pen). The module state is per
device (`localStorage`), like other settings: a phone can run a leaner set than the laptop.

**Data stays.** Switching a module off removes its UI, background work and assistant tools; it
never edits notes. Smart-ink objects, sticky notes and tape keep rendering (canvas, SVG, PDF)
but can't be edited; filled form values still show and export; transcripts, compiled pages,
certificates and links stay in their files and come back when the module is on again.

**Adding a feature** = adding a module: declare it in `builtin.ts` (or `registerModule` from
its own file), gate its entry points with `useModule(id)` / `isModuleOn(id)`, and put background
work in `activate`.

## Plugins for users

Settings › Extend › Plugins:

- **Browse** — the curated list (shipped inside the app, so it works offline and can't be changed
  remotely).
- **Install from a link** — a plugin's `manifest.json`, its folder URL, or a `.zip` (https).
- **From a .zip** or **from a folder** on this device.

Installing shows what the plugin may do (its permissions, with high-risk ones marked) and what it
adds; you can untick permissions before installing. Afterwards each plugin has an on/off switch,
per-permission switches (revoking stops it at once), its settings, **Check for update** (from the
curated list or its URL; new permissions need a new OK) and **Uninstall** (removes its files,
settings and stored data; notes are untouched).

Plugins are stored in the vault (`plugins/<id>/`, `plugins/plugins.json`, see
VAULT_FORMAT.md), so they sync to your other devices with your notes. A plugin only runs on a
device where you approved it, though: each device remembers the exact code and permissions you
allowed there. One that arrives installed, updated or granted more from elsewhere — another
device, a sync, a restored backup — shows **Review** in Settings › Extend › Plugins and stays off until
you allow it on this device (revoking a permission elsewhere needs no review). Anything that can
write your vault could otherwise put a networked plugin in it. Their commands appear in
the search palette and the editor's ••• › Tools › Plugins, panels in the editor's side panel, exporters
under ••• › Share & export, importers in the palette, and assistant tools in the assistant.

## Writing a plugin

```sh
npm create inkwright-plugin my-plugin        # once published; in this repo:
node examples/create-inkwright-plugin/index.mjs my-plugin
```

Then Settings › Extend › Plugins › From a folder, pick `my-plugin`. Re-install from the folder after a
change (settings and storage are kept). Examples: `examples/plugins/word-count` (panel, command,
assistant tool, exporter, settings, events) and `examples/plugins/webhook` (network).

### The manifest

```json
{
  "id": "com.example.word-count",
  "name": "Word count",
  "version": "1.0.0",
  "author": "You",
  "description": "Counts words.",
  "entry": "main.js",
  "minAppVersion": "1.0.0",
  "apiVersion": 1,
  "permissions": ["notes:read", "editor:read", "events"],
  "noteScope": { "tags": ["work"] },
  "network": { "hosts": ["https://hooks.example.com"] },
  "activation": "onUse",
  "contributes": {
    "commands": [{ "id": "count", "title": "Count words", "keywords": "length", "context": "editor" }],
    "panels": [{ "id": "stats", "title": "Word count" }],
    "aiTools": [{ "name": "reading_time", "description": "…", "parameters": { "type": "object", "properties": {} }, "readOnly": true }],
    "importers": [{ "id": "csv", "title": "CSV rows as notes", "extensions": ["csv"] }],
    "exporters": [{ "id": "txt", "title": "Plain text", "extension": "txt", "mimeType": "text/plain" }],
    "settings": [{ "key": "wordsPerMinute", "type": "number", "title": "Reading speed", "default": 230 }]
  },
  "updateUrl": "https://example.com/word-count/manifest.json"
}
```

`validateManifest` in `@inkwright/plugin-api` is the reference (the template's `npm run check`
uses it). Plugins with `"activation": "onUse"` (the default) only start when one of their
contributions is used; `"startup"` starts them with the app (needed to hear events in the
background).

### The code

One ES module (no imports — bundle dependencies in if you have any) whose default export is:

```js
/** @typedef {import('@inkwright/plugin-api').InkwrightAPI} InkwrightAPI */
export default {
  /** @param {InkwrightAPI} inkwright */
  activate(inkwright) {
    inkwright.commands.register('count', async () => { /* … */ });
    inkwright.ai.registerTool('reading_time', async (args) => ({ minutes: 3 }));
    inkwright.exporters.register('txt', ({ note }) => ({ text: note.markdown }));
    inkwright.importers.register('csv', ({ name, text }) => text.split('\n').map((row) => ({ title: row, text: '' })));
  },
  deactivate() {},
  panels: {
    /** Each panel renders in its own sandboxed frame. */
    async stats(root, inkwright) { root.textContent = String((await inkwright.notes.list()).length); },
  },
};
```

### The API (`InkwrightAPI`, protocol version 1)

| Call | Permission |
| --- | --- |
| `app.info()` — version, platform, granted permissions | — |
| `notes.list({tag, notebook, limit})`, `notes.search(q)`, `notes.get(id)` → title, tags, notebook, dates, `markdown` (typed text and recognized handwriting) | `notes:read` |
| `notes.create({title, text, tags})`, `notes.append(id, text)`, `notes.update(id, {title, tags})` — logged in Activity under the plugin's name, undoable | `notes:write` |
| `editor.current()`, `editor.selection()` | `editor:read` |
| `editor.insertText(text)` — one undo step on the page in view | `editor:write` |
| `events.on('note.created' \| 'note.updated' \| 'note.opened' \| 'note.trashed' \| 'selection.changed', fn)` | `events` |
| `ai.registerTool(name, fn)` for `contributes.aiTools` (tools not marked `readOnly` ask the user before each call) | `ai:tools` |
| `net.fetch(url, {method, headers, body})` → `{status, ok, headers, body}`; only to `network.hosts`; no cookies | `network` |
| `clipboard.writeText(text)` | `clipboard:write` |
| `commands.register`, `importers.register`, `exporters.register` (the user invokes them) | — |
| `storage.get/set/delete/keys` — private JSON storage in the vault (1 MB per value) | — |
| `settings.get()` — values of `contributes.settings` | — |
| `ui.toast(text, tone)`, `ui.openNote(id, page)` | — |
| `messages.post(data)` / `messages.on(fn)` — between the plugin's main code and its panels | — |

Refused calls reject with `PluginApiError` whose `code` is `permission_denied`, `out_of_scope`,
`not_found`, `invalid_argument`, `unavailable`, `timeout` or `internal`.

**Note scope.** With `noteScope`, notes outside the listed tags/notebooks do not exist for the
plugin (lists, search, get and events skip them; writes that would move a note out are
refused; new notes get the scope's first tag). Locked notes are never visible to plugins.

### The sandbox

Each plugin runs in `<iframe sandbox="allow-scripts">` without `allow-same-origin` — an opaque
origin with no access to the app's DOM, cookies, IndexedDB (the vault), localStorage, popups or
top navigation. The frame's own Content Security Policy allows only the runtime script and
`blob:` modules (no `eval`, no remote scripts), `connect-src 'none'` (no fetch, XHR or
WebSocket — network goes through the permission-checked `net.fetch`), images only from
`data:`/`blob:`, and no nested frames. In hosted and native builds the app's own CSP also
applies to the frame, and its `frame-src` stops a plugin from navigating its frame elsewhere.
Panels are separate frames with the same rules; they get the app's palette as CSS variables
(`--ink`, `--ink-2`, `--line`, `--iron`, `--font-title`…) so they look native.

The host (`apps/web/src/plugins/`) talks to frames over `postMessage` with the versioned protocol
in `@inkwright/plugin-api` (`protocol.ts`): messages carry `p: "inkwright-plugin"` and `v: 1`; the
host accepts messages only from that frame's window, checks the method against the `METHODS`
table and the permission on every call (`dispatcher.ts`), so revocation is immediate.

Limits: plugin packages ≤ 5 MB and 200 files (code, JSON, CSS, Markdown, text and images
only); handlers time out (30 s; importers 2 min). In `vite dev` the sandbox runtime is not
bundled the same way, so try plugins in a build (`npm run build && npx vite preview`) or the
installed app. A plugin can still use CPU while it runs; switching it off stops its frames.

Browsers don't apply `connect-src` to WebRTC, so the runtime removes the WebRTC constructors
(`RTCPeerConnection` and friends) before plugin code loads; nested frames can't bring them back,
because inside the opaque-origin sandbox every child frame is cross-origin (security review
SR-12). What remains is low-bandwidth: a frame can still trigger DNS lookups (for example a
`<link rel="dns-prefetch">`), which no CSP governs.

A scoped plugin (`noteScope`) sees the editor only while a note inside its scope is open:
otherwise `editor.current()` is `null`, the selection is empty, `insertText` refuses, and
`note.opened` / `selection.changed` events are not delivered. Locked notes are never visible.

## How it fits together

| | Runs where | Talks to | For |
| --- | --- | --- | --- |
| **Plugins** | inside the app, sandboxed | the plugin API (permission-checked) | UI: commands, panels, exporters/importers, assistant tools |
| **`window.inkwright`** | the app's page (Settings › Extend › Developer, off by default) | the same API and permission model, as "Automation API" | browser extensions, userscripts, the console |
| **MCP servers** (Settings › AI › Connected apps) | anywhere; the assistant connects to them | MCP | giving the in-app assistant outside tools (calendars, issue trackers…) |
| **`inkwright-mcp`** | your computer, over the vault folder | MCP, A2A, REST (`/api/v1`) | outside agents and programs using your notes (docs/AGENTS.md, docs/API.md) |
| **Links** | the OS / browser | `inkwright://…`, `?action=…` | Shortcuts, Tasker, launchers (docs/API.md § Links) |

Rules of thumb: if it needs UI inside Inkwright, write a plugin. If it gives the assistant
abilities that live elsewhere, connect an MCP server — a plugin's `ai:tools` is for small
tools that need nothing but the notes the plugin may read. If it is a program or agent working
on the notes from outside, use `inkwright-mcp` (MCP for agents, REST for programs).
