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
  ai/skills/<name>/SKILL.md             Agent Skills the user imported (+ their bundled files)
  ai/skills.json                        which skills are switched off
  ai/memory.json                        assistant memory: instructions, facts, proposals
  ai/routines/<routineId>.json          routines (background agents) and their run state
  ai/activity/<runId>.json              AI activity log: what agents changed, for undo
  ai/leases/routines.json               which always-on runner runs routines automatically
  ai/approvals/<id>.json                actions an unattended agent is waiting for your OK on
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
      "input": "pen",                       // optional: pen | touch | mouse — how it was written in Inkstone
      "origin": "ai",                       // optional: ai | solver | recognized | import — not handwriting
      "points": [[x, y, t, p?, tilt?, orient?], …] }   // t = ms since stroke start; p 0..1; radians
  ],
  "texts":  [{ "id", "x", "y", "width", "text" /* Markdown */, "fontSize", "color", "font": "sans|serif|mono|hand", "createdAt", "origin?" }],
  "images": [{ "id", "x", "y", "width", "height", "asset", "rotation", "createdAt", "origin?" }],
  "objects": [ … ],                                                            // optional: tables, solved results, graphs (below)
  "authorship": { "v": 1, "events": [ … ] },                                   // optional: hash chain (docs/AUTHORSHIP.md)
  "background": { "kind": "pdf|image", "asset": "file.pdf", "pageNumber": 1, "rotation": 90 },   // optional
  "paper": { … }, "size": { … },                                               // optional per-page overrides
  "recognizedText": "…", "recognizedAt": 0, "recognizedBy": "mlkit|gemini-2.5-flash|…",  // optional
  "recognizedLines": [                                                         // optional
    { "text": "fourier transform", "strokeIds": ["…"], "bounds": { "minX", "minY", "maxX", "maxY" } }
  ]
}
```

`background.rotation` (optional, degrees, a multiple of 90) is a clockwise turn the user added on
top of the source page's own orientation (a PDF page's `/Rotate`); the page's `size` is already
swapped to match. Readers that don't know it show the page unturned.

`recognizedLines` anchors each recognized line to the strokes it came from (written by line-by-line
recognizers such as ML Kit). Search results and AI citations use it to point at the exact
handwriting. It always describes the current `recognizedText`; writers that replace the text
without line anchors drop it. Readers that don't know it ignore it.

Pens: `fountain | ballpoint | pencil | brush | marker | highlighter | dashed`. Missing pressure /
tilt / orientation are omitted from the point array (or `-1` when a later field is present).

`input` and `origin` (strokes, texts, images) say how content was made; see
[AUTHORSHIP.md](AUTHORSHIP.md). Absent `origin` means made by the user in the app. Readers that
don't know them ignore them; writers keep them when they rewrite an item.

### Page objects (`objects`, "ink that does things")

Live objects made from ink, drawn **under** the strokes (handwriting in a table cell sits on top of
the grid). Every object has `id`, `type`, `x`, `y` (top-left, page units), `createdAt`, and an
optional `origin`. Readers that don't know `objects` show the page without them (the ink is all
still there); readers that don't know a `type` skip that object. Writers must keep objects they
don't understand.

```jsonc
{ "type": "table", "id", "x", "y", "createdAt",
  "cols": [120, 90, 90],                 // column widths, left to right
  "rows": [32, 32, 32],                  // row heights, top to bottom
  "cells": [[{ "text": "Item" }, {}, {}], [{ "recognized": "milk" }, {}, {}], …],   // [row][col]
  "color": "#FF1B1F24", "lineWidth": 1.6, "header": true }

{ "type": "math", "id", "x", "y", "createdAt",
  "input": "2x + 3 = 7", "latex": "2x+3=7", "result": "x = 2", "steps": ["…"],
  "fontSize": 22, "color": "#FF1B1F24", "source": ["<stroke ids>"], "origin": "solver|ai" }

{ "type": "graph", "id", "x", "y", "createdAt", "width": 320, "height": 220,
  "functions": [{ "expr": "x^2-4", "color": "#FF2F6FB5", "label": "y" }],
  "view": { "xMin": -10, "xMax": 10, "yMin": -6, "yMax": 30 }, "origin": "solver" }
```

**Tables.** `cells` is always `rows.length × cols.length`. A cell's `text` is what was typed into
it; `recognized` is what was read from the ink written in it (typed text wins when both exist).
Ink written in a table is an ordinary stroke in `strokes`: it belongs to the cell that contains
the centre of its bounds, and moves with that cell when rows or columns are inserted, removed or
resized (`relayoutStrokes` in `packages/core/src/objects.ts`). Markdown and CSV exports use typed
text, else recognized text.

**Solved results** (`math`) are machine-made answers shown next to the handwriting they came
from, in a handwriting-style font with a faint wash so they are never mistaken for the user's ink.
`input` is plain ASCII maths. `origin` is `solver` when the device read and solved it, `ai` when
an AI read the handwriting (the answer is still checked by the on-device solver when it can).

**Graphs** plot each `expr` as y = f(x) over `view`. Expressions use the syntax in
`packages/core/src/mathexpr.ts`: `+ - * / ^`, implicit multiplication (`2x`, `3sin(x)`),
`sqrt abs exp ln log(=log10) sin cos tan asin acos atan sinh cosh tanh sec csc cot floor ceil`,
`pi`, `e`, `|x|`, `n!`. Any tool can redraw them; SVG exports already include them.

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
  "forms": { "file.pdf": { "applicant.name": "Ada Lovelace", "agree": true, "color": "blue", "langs": ["en", "fr"] } },   // optional
  "certificate": { "asset": "authorship-1730000000000.json", "signedAt": 1730000000000 }   // optional, latest signed authorship certificate
}
```

`certificate` points at the note's latest signed authorship certificate in `assets/` (format in
[AUTHORSHIP.md](AUTHORSHIP.md)).

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
images/objects are unioned by id with deletions honoured from either side; authorship chain events
are unioned and ordered by time; scalar metadata takes the most
recent `updatedAt`. `forms` merges per PDF and per field (filling different fields on two devices
keeps both; the newer note wins a field both changed). Derived files are regenerated after merge. Sync state lives outside the vault
(app storage), never inside it.

## Assistant data (`ai/`)

Everything the in-app assistant keeps lives next to the notes so it syncs with them. All files
are JSON (or Markdown for skills); readers ignore unknown fields. Sync treats them as whole files
(three-way merge is only for ink and note files), so each run and routine is its own file and two
devices rarely touch the same one. Nothing secret is stored here: API keys, MCP sign-ins and
tokens stay in each device's encrypted secret store and never sync.

**Skills** — `ai/skills/<name>/` is an [Agent Skill](https://agentskills.io/specification):
`SKILL.md` with YAML frontmatter (`name` — must equal the folder name, 1–64 chars of `a-z0-9-`,
no leading/trailing/double hyphens; `description` ≤ 1024 chars; optional `license`,
`compatibility` ≤ 500 chars, `metadata` (string map), `allowed-tools`) and any bundled files
(`references/`, `assets/`, `scripts/`). Inkstone never executes scripts. `ai/skills.json` is
`{ "disabled": ["skill-name", …] }` (built-in skills can be switched off too; they ship with the
app and are not written here).

**Memory** — `ai/memory.json`:

```jsonc
{ "version": 1, "items": [
  { "id", "kind": "instruction|fact", "text", "status": "active|proposed",
    "source": "user|assistant", "createdAt", "updatedAt", "reason?" }
] }
```

Only `active` items reach the model. `proposed` items come from the assistant's `remember` tool
and wait for the user.

**Routines** — `ai/routines/<id>.json`:

```jsonc
{ "id", "name", "prompt", "enabled", "ai": "<provider config id>|null",
  "tools": { "notes": "read|write", "skills": true, "mcpServers": ["<connection id>"] },
  "triggers": [ { "kind": "daily", "time": "18:00" }, { "kind": "weekly", "day": 1, "time": "08:00" },
                { "kind": "note-saved", "tag": "email" }, { "kind": "recording-ended" },
                { "kind": "before-date", "days": 3, "keyword": "exam" } ],
  "template?", "createdAt", "updatedAt",
  "state": { "lastRunAt?", "lastStatus?", "lastError?", "slots": { "<trigger index>": <slot ms> },
             "firedDates": ["<noteId>@YYYY-MM-DD"] } }
```

Times are the device's local time. A routine runs while Inkstone is open; a slot missed while it
was closed runs once on the next open (`slots` records it so no device repeats it). The always-on
runner (`inkstone-agent run`, see docs/AGENTS.md) runs the same routines from a computer.

**Routines lease** — `ai/leases/routines.json`, written by an always-on runner while it runs:

```jsonc
{ "holder": "runner:<host>:<pid>:<random>", "label": "The Inkstone agent on <host>",
  "kind": "runner", "acquiredAt", "renewedAt", "expiresAt" }
```

While `expiresAt` is in the future, only the holder acts on automatic triggers (times, dates,
note saves, recordings); the app and other runners leave them to it ("Run now" always runs where
it is pressed). The holder renews it every minute (10-minute lifetime) and deletes it when it stops,
so the app takes over at once — or after expiry if the computer went to sleep. A missing or
unreadable file means no lease.

**Pending approvals** — `ai/approvals/<id>.json`, actions an unattended agent (a routine run by the
runner, or through an MCP client that can't ask mid-call) wanted to take but that need a person's
OK, such as moving a note to Trash:

```jsonc
{ "id", "tool": "trash_note", "args": { "note_id": "…" }, "title": "Move “…” to Trash",
  "detail?", "source": "<routine or agent name>", "routineId?", "createdAt",
  "status": "pending|approved|denied|failed|expired", "decidedAt?", "decidedBy?", "outcome?" }
```

Approving runs exactly the recorded call (logged as its own Activity run, so it can be undone);
pending approvals older than seven days read as `expired`.

**Activity** — `ai/activity/<runId>.json`, one run per assistant turn, routine run or external
agent connection (the MCP server writes these too):

```jsonc
{ "id", "source": "assistant|routine|external", "label", "routineId?", "prompt?",
  "startedAt", "endedAt?", "status": "running|done|error|cancelled", "reply?", "error?",
  "ops": [ { "id", "at", "tool", "summary", "undoneAt?", "undoNote?", "kind": … } ] }
```

Op kinds and how undo reverses them: `note_created {noteId, title}` → move to Trash;
`note_trashed {noteId, title}` → restore; `text_appended {noteId, pageId, textId, text,
addedPage?}` → remove that text box (and the page, if it was added and is now empty);
`meta_changed {noteId, before, after}` (fields `title`, `tags`, `notebookId` (null = unfiled),
`pinned`, `summary` (null = none)) → put back each field that still has the `after` value;
`notebook_created {notebookId, name}` → delete it if still empty; `handwriting_recognized {noteId,
pageId, text}` (the MCP server's `transcribe_pages`) → clear the page's recognized text if it is
still that text; `external {server, detail?}` —
a change in a connected app, listed only. The newest 300 runs are kept.
