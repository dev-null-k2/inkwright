# @inkwright/plugin-api

Types and rules shared by Inkwright plugins and the app that hosts them:

- `InkwrightAPI` — what `activate(inkwright)` receives (notes, editor, commands, AI tools,
  importers, exporters, events, storage, settings, network, UI, clipboard, messages), and
  `definePlugin` for typed plugin modules;
- `validateManifest`, `compareVersions` — the `manifest.json` schema;
- `PERMISSIONS`, `PERMISSION_INFO`, `noteInScope`, `hostAllowed` — the permission model;
- `METHODS`, `PROTOCOL_VERSION` — the versioned postMessage protocol and the permission each
  call needs;
- `createPluginClient` — the plugin side of the protocol over any transport.

Writing a plugin: see [docs/PLUGINS.md](../../docs/PLUGINS.md) and
`examples/create-inkwright-plugin`.
