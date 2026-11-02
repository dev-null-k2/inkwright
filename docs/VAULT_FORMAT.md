# Inkstone vault format (v2)

Everything a user creates in Inkstone is plain files in a **vault** folder. The app, the sync
engine, the MCP server and any third-party tool read and write the same layout. The TypeScript
reference implementation is `packages/core/src/codec.ts` + `vault.ts`.

```
<vault>/
  inkstone.json                         manifest {app, formatVersion, createdAt}
  notebooks/<notebookId>/notebook.json  NotebookMeta
  notes/<noteId>/note.json              NoteMeta (pretty JSON)
  notes/<noteId>/note.md                Markdown export — generated, safe to read, never parsed back
  notes/<noteId>/pages/<pageId>.ink.json  PageInk (compact JSON) — the source of truth for ink
  notes/<noteId>/pages/<pageId>.svg     SVG render of the page — generated
  notes/<noteId>/assets/<name>          images, PDFs, audio recordings referenced by pages/notes
```

Rules

- Ids are 22-char Crockford base32 (`newId()`), time-sortable, and must match `^[0-9A-Za-z_-]{1,64}$`.
  Asset names must match `^[0-9A-Za-z_.-]{1,96}$`. Paths never contain `..`.
- Units: 1 page unit = 1/96 inch. Colors are `#AARRGGBB`.
- Writers bump `updatedAt` (epoch ms) on every change and write `formatVersion: 2`. Readers accept
  v1 (Android prototype) and ignore unknown fields.
- `note.md` and `*.svg` are derived; tools may regenerate them at any time. Never edit ink by
  editing SVG.
- Deleting a note to Trash sets `trashedAt` in `note.json`; purge deletes `notes/<id>/`.

## PageInk (`*.ink.json`)

```jsonc
{
  "id": "01JC…",
  "formatVersion": 2,
  "strokes": [
    { "id": "…", "pen": "fountain", "color": "#FF1B1F24", "size": 2.6, "createdAt": 1730000000000,
      "shape": "rectangle",                 // optional, when snapped to a shape
      "points": [[x, y, t, p?, tilt?, orient?], …] }   // t = ms since stroke start; p 0..1; radians
  ],
  "texts":  [{ "id", "x", "y", "width", "text" /* Markdown */, "fontSize", "color", "font": "sans|serif|mono|hand", "createdAt" }],
  "images": [{ "id", "x", "y", "width", "height", "asset", "rotation", "createdAt" }],
  "background": { "kind": "pdf|image", "asset": "file.pdf", "pageNumber": 1, "rotation": 90 },   // optional
  "paper": { … }, "size": { … },                                               // optional per-page overrides
  "recognizedText": "…", "recognizedAt": 0, "recognizedBy": "mlkit|gemini-2.5-flash|…"   // optional
}
```

`background.rotation` (optional, degrees, a multiple of 90) is a clockwise turn the user added on
top of the source page's own orientation (a PDF page's `/Rotate`); the page's `size` is already
swapped to match. Readers that don't know it show the page unturned.

Pens: `fountain | ballpoint | pencil | brush | marker | highlighter | dashed`. Missing pressure /
tilt / orientation are omitted from the point array (or `-1` when a later field is present).

## NoteMeta (`note.json`)

```jsonc
{
  "id", "title", "kind": "paged|board",
  "paper": { "style": "ruled_narrow", "tint": "ivory", "texture": "standard", "spacing": 0 },
  "pageSize": { "name": "A4", "width": 793.7, "height": 1122.5 },   // width/height 0 = infinite
  "pageIds": ["…"], "notebookId": "…?", "tags": ["…"],
  "createdAt", "updatedAt", "pinned": false, "color": "#AARRGGBB?",
  "recordings": [{ "id", "asset", "startedAt", "durationMs", "mimeType", "title?" }],
  "summary": "…?", "trashedAt": 0, "formatVersion": 2,
  "forms": { "file.pdf": { "applicant.name": "Ada Lovelace", "agree": true, "color": "blue", "langs": ["en", "fr"] } }   // optional
}
```

### PDF form values (`forms`, "Fill & sign")

Values the user typed into the AcroForm fields of an imported PDF. Keys are the PDF's asset name,
then the field's fully qualified name (`parent.child`, as in the PDF). The PDF asset itself is never
modified; exporters write the values into a copy. Value by field type:

| Field | Value |
|---|---|
| Text, dropdown, single-choice list | string (dropdowns/lists: the option's export value) |
| Checkbox | `true` / `false` |
| Radio group (or checkboxes sharing a name with different on-states) | the selected widget's state / export value, or `"Off"` |
| Multi-select list | string array of export values |

A field with no entry shows the value saved in the PDF. Writers drop empty maps (no `forms` key when
nothing is filled). Signatures, initials, checkmarks and text placed on a page (flat PDFs) are not
form values: they are ordinary `strokes`, `texts` and `images` of the page. Signatures typed or
imported as images are stored as `assets/sig-<id>.png` (transparent PNG); drawn ones are strokes.

The signature *library* (saved signatures and initials for reuse) is not part of the vault: it is
kept on each device only, encrypted with the app's WebCrypto secret store, and never synced.

Paper styles: `blank ruled_narrow ruled_wide dot_grid square_grid graph_mm isometric cornell music
planner_day planner_week todo`. Tints: `white ivory cream recycled kraft mint blush slate midnight`.
Textures: `smooth standard toothy`.

## NotebookMeta (`notebook.json`)

`{ "id", "name", "color", "parentId?", "createdAt", "formatVersion" }` — notebooks nest via `parentId`.

## Sync

Sync engines (Google Drive, WebDAV, local folder) mirror this tree file-for-file. Conflicts on
`*.ink.json` and `note.json` are merged three-way against the last-synced base: strokes/texts/
images are unioned by id with deletions honoured from either side; scalar metadata takes the most
recent `updatedAt`. `forms` merges per PDF and per field (filling different fields on two devices
keeps both; the newer note wins a field both changed). Derived files are regenerated after merge. Sync state lives outside the vault
(app storage), never inside it.
