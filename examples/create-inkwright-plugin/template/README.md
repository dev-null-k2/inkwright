# My plugin

An Inkwright plugin. Try it while you write it:

1. Inkwright › Settings › Plugins › **From a folder** → pick this folder. Accept the permissions.
2. Open a note: ••• › Plugins › Say hello, or the panel "My plugin".
3. After a change, install from the folder again (your settings and stored data are kept).

`npm run check` validates `manifest.json` before you publish. To publish, put `manifest.json`
and `main.js` on any https host (GitHub Pages works) and share the link to the folder; people
install it with Settings › Plugins › Install from a link. Bump `version` for updates; set
`updateUrl` if the manifest moves.

API reference: docs/PLUGINS.md in the Inkwright repository, and the types in
`@inkwright/plugin-api`.
