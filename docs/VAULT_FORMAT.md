# Inkwright vault format (v2)

Everything a user creates in Inkwright is plain files in a **vault** folder. The app, the sync
engine, the MCP server and any third-party tool read and write the same layout. The TypeScript
reference implementation is `packages/core/src/codec.ts` + `vault.ts`.

```
<vault>/
  inkwright.json                         manifest {app, formatVersion, createdAt}
  notebooks/<notebookId>/notebook.json  NotebookMeta
  notes/<noteId>/note.json              NoteMeta (pretty JSON)
  notes/<noteId>/note.md                Markdown export — generated, safe to read, never parsed back
  notes/<noteId>/pages/<pageId>.ink.json  PageInk (compact JSON) — the source of truth for ink
  notes/<noteId>/pages/<pageId>.svg     SVG render of the page — generated
  notes/<noteId>/assets/<name>          images, PDFs, audio recordings referenced by pages/notes
  notes/<noteId>/assets/<clipId>.transcript.json  transcript of a recording (+ its summary)
  notes/<noteId>/assets/page-summaries.json       summaries of the note's pages, by page id

  notes/<noteId>/history/<id>.json      version history: one manifest per snapshot (see "Version history")
  notes/<noteId>/history/blobs/<h>.json page contents shared by snapshots, content-addressed
  ai/skills/<name>/SKILL.md             Agent Skills the user imported (+ their bundled files)
  ai/skills.json                        which skills are switched off
  ai/memory.json                        assistant memory: instructions, facts, proposals
  ai/routines/<routineId>.json          routines (background agents) and their run state
  ai/activity/<runId>.json              AI activity log: what agents changed, for undo
  templates/<templateId>/template.json  note templates (see "Templates")
  templates/<templateId>/assets/<name>  files a template's pages use
  ai/leases/routines.json               which always-on runner runs routines automatically
  ai/approvals/<id>.json                actions an unattended agent is waiting for your OK on
  ai/lessons.json                       lessons proposed from coding-agent sessions (see "Code sources")
  code/sources/<sourceId>/source.json   a mounted repository: where it came from, last scan (see "Code sources")
  code/sources/<sourceId>/graph.json    its code graph: symbols with signature hashes, edges
  notes/<noteId>/assets/provenance.json where each AI-written sentence of the note came from (see "Context compiler")
  ai/compiler/config.json, state.json   context compiler: sources, settings, compiled pages
  ai/compiler/proposals/<id>.json       compiled-wiki changes waiting for review (and decided ones)
  ai/ledger/<conflictId>.json           contradictions the user dismissed or resolved
  ai/study/<deckId>.json                flashcard decks with FSRS state
  ai/packs/<id>/pack.md, pack.json      saved context packs (served by the MCP server)
  plugins/plugins.json                  installed plugins: enable switch, granted permissions, source (see "Plugins")
  plugins/<pluginId>/manifest.json, …   a plugin's files exactly as published (code, docs, images)
  plugins/<pluginId>/data.json          a plugin's private storage and its settings
  api/keys.json                         REST API keys, as SHA-256 hashes only (see "API keys")
  ai/evals/memory.json                  the latest "Does my memory help?" report
  ai/policy.json                        AI policy: routing, notebook/tag permissions, budgets, privacy, retention
  ai/proposals/<id>.json                changes agents proposed (dry run), waiting for approval
  ai/usage/<YYYY-MM>/<device>.json      AI usage meter: tokens, cost and savings per day and provider
  ai/audit/<device>/<YYYY-MM>.jsonl     audit trail: signed, hash-chained record of what AI saw and did
  branches/<branchId>.json              a branch of proposed changes: per note its base and head (see "Branches")
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
      "input": "pen",                       // optional: pen | touch | mouse — how it was written in Inkwright
      "origin": "ai",                       // optional: ai | solver | recognized | import — not handwriting
      "nib": 40,                            // optional, calligraphy pen only: nib angle in degrees
      "layer": "drawing",                   // optional: the drawing layer (absent = writing layer)
      "author": { "id": "3f2a9c1b", "name": "Grace" },  // optional: written by a live collaborator (below)
      "points": [[x, y, t, p?, tilt?, orient?], …] }   // t = ms since stroke start; p 0..1; radians
  ],
  "texts":  [{ "id", "x", "y", "width", "text" /* Markdown */, "fontSize", "color", "font": "sans|serif|mono|hand", "createdAt", "origin?", "author?" }],
  "images": [{ "id", "x", "y", "width", "height", "asset", "rotation", "createdAt", "origin?" }],
  "objects": [ … ],                                                            // optional: tables, solved results, graphs, sticky notes, tape (below)
  "layers": { "drawing": { "hidden": true, "locked": true } },                 // optional: layer state (below)
  "sealed": { "v": 1, "iv": "…", "data": "…" },                                // only in locked notes (see "Locked notes")
  "authorship": { "v": 1, "events": [ … ] },                                   // optional: hash chain (docs/AUTHORSHIP.md)
  "background": { "kind": "pdf|image", "asset": "file.pdf", "pageNumber": 1, "rotation": 90 },   // optional
  "underlay": { "asset": "….png", "width": 1400, "height": 1980, "kind": "photo" },   // optional: hidden photo the ink was traced from (below)
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

Pens: `fountain | ballpoint | pencil | brush | calligraphy | marker | highlighter | dashed`.

**Calligraphy pen.** A broad, flat nib: the outline is the area a nib `size` wide (with a hairline
thickness of 7 % of that) sweeps along the points while held at `nib` degrees, measured clockwise
from the page's x axis (default 40). Moving across the nib draws the full width, moving along it a
hairline. Pressure, when present, opens the nib between 72 % and 128 %. The reference is
`calligraphyOutline` in `packages/core/src/outline.ts`; readers that don't know the pen can draw it
as a fountain pen of the same size.

**Layers.** A stroke with `"layer": "drawing"` is on the page's drawing layer, drawn before (under)
all writing-layer strokes; otherwise it is on the writing layer. `PageInk.layers` holds each layer's
`hidden` (not drawn or exported) and `locked` (can't be erased, selected or scratched out) flags;
absent means shown and unlocked. Layers apply to strokes only — page objects keep their own places.

Missing pressure /
tilt / orientation are omitted from the point array (or `-1` when a later field is present).

`input` and `origin` (strokes, texts, images) say how content was made; see
[AUTHORSHIP.md](AUTHORSHIP.md). Absent `origin` means made by the user in the app. Readers that
don't know them ignore them; writers keep them when they rewrite an item.

`author` (strokes and text boxes, optional) marks an item a live collaborator wrote or changed on
this page ([COLLABORATION.md](COLLABORATION.md)): `id` is the first 8 hex digits of their device
key's fingerprint, `name` the name they gave (shown, never trusted). It is stamped by the device
that *received* the edit, never taken from the sender, and is part of the item's content (its
authorship digest covers it), so such an item never counts as the vault owner's handwriting.
Authorship chain events for collaborators' edits carry `"by": "<author id>"`. Each device keeps its
own point of view: a stroke Grace wrote has `author` in Ada's vault and none in Grace's.

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

{ "type": "diagram", "id", "x", "y", "createdAt", "width": 520, "height": 340,
  "ir": { "title?", "direction?": "TB|LR", "nodes": [ … ], "edges": [ … ], "groups?": [ … ], "acyclic?", "layout?" },
  "color": "#FF1B1F24", "origin?": "ai" }
```

**Diagrams** are verified architecture diagrams: `ir` is the typed diagram IR (docs/DEVELOPERS.md
§ 4), valid when written, and the picture is laid out from it (`layoutDiagram` in
`packages/core/src/dev/diagram.ts`) and scaled to `width` × `height`. Tools that change the IR must
keep it valid (`validateDiagram`); readers that don't draw diagrams can show `ir` as text.

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

**Sticky notes and tape** are *overlays*: drawn over the ink and typed text, in list order.

```jsonc
{ "type": "sticky", "id", "x", "y", "createdAt", "width": 180, "height": 180,
  "color": "#FFFCE58A",                  // the note's paper
  "text": "Call Mum",                    // optional typed text, shown at the top
  "strokes": [ /* InkStroke, coordinates relative to the sticky's top-left */ ],
  "collapsed": false }                   // true: folded to a 26-unit icon at (x, y)

{ "type": "tape", "id", "x", "y", "createdAt",
  "dx": 240, "dy": 0,                    // the strip runs from (x, y) to (x + dx, y + dy)
  "width": 20, "color": "#FF8FA7B8" }    // thickness (page units) and opaque colour
```

A sticky's handwriting belongs to it, so it moves and folds with the note; its `text` is included
in search and `note.md` ("Sticky note: …"). Tape always covers what is under it in files, exports and
thumbnails; revealing a strip (tapping it, or "Reveal all tape") is a view state of the open note
and never saved. Writers must keep overlays they don't draw, like any object.

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

`lock` is present while the note is locked with a passcode (see "Locked notes").

`codeRefs` (optional) holds, per code link in the note (`[[code:path#Symbol]]` typed or recognized,
or an ink link whose `target` starts with `code:`), what the link was written or last reviewed
against: `{ "src/auth.ts#createSession": { "hash", "signature", "sourceId?", "linkedAt", "reviewedAt?" } }`.
A scan whose signature hash differs makes the link *drifted* (see "Code sources"). Keys of links no
longer in the note may remain; they are ignored.

`certificate` points at the note's latest signed authorship certificate in `assets/` (format in
[AUTHORSHIP.md](AUTHORSHIP.md)).

### Transcripts and page summaries

A recording's transcript lives next to its audio, `assets/<clipId>.transcript.json`
(`packages/core/src/transcript.ts`):

```jsonc
{
  "formatVersion": 1,
  "clipId": "01JC…",                  // the recording in note.json `recordings`
  "run": "01JD…",                     // one transcription pass (live, or "transcribe again")
  "engine": "device:moonshine-base",  // or "browser", "provider:openai:gpt-4o-mini-transcribe", "native:…"
  "where": "device",                  // device | browser | provider: where the audio was processed
  "language": "en-US",                // optional
  "complete": true,                   // false while still being transcribed
  "updatedAt": 0,
  "segments": [ { "id": "1kq-0", "startMs": 1200, "endMs": 4800, "text": "Today we cover convolution." } ],
  "lecture": { "summary": "…", "keyTerms": ["…"], "todos": ["…"], "at": 0, "by": "On this device · Qwen3 1.7B" }  // optional
}
```

Segment times are milliseconds from the start of the recording, so a segment's wall-clock span is
`clip.startedAt + startMs … clip.startedAt + endMs`. The ink "written while it was said" is every
stroke whose writing time (`createdAt` to `createdAt` + its last point's `t`) overlaps that span,
extended by 1.5 s for writing lag, and every text box created in it. Segments are sorted by
`startMs`; ids are unique within a run.

`assets/page-summaries.json` holds AI-written summaries of pages, keyed by page id:
`{ "formatVersion": 1, "updatedAt", "pages": { "<pageId>": { "text": "- …", "at", "by", "clipIds": ["…"] } } }`.
A page's summary draws on what is on the page and on the segments assigned to it: each segment
goes to the page with the most writing during it, else the page last written on before it, else
the first page written on after it. Summaries are suggestions; nothing on the page changes unless
the user adds a summary to it (as an ordinary text box).

Readers that don't know these files ignore them (they look like any other asset). Search indexes
transcript segments as "what was said" passages anchored to the page and the ink written then.

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

## Links, tags and daily notes

- **Wiki links** are text: `[[Title]]`, `[[Title#Page 2]]`, `[[Title|alias]]`, `[[Folder/Title]]`,
  `![[Title]]`, in a text box's Markdown or in `recognizedText`. Titles match case-insensitively
  (whitespace collapsed, a `.md` suffix ignored); a `Folder/Title` path picks the note in that
  notebook; ties go to the linking note's notebook, then the most recently edited note.
  `packages/core/src/links.ts` is the reference.
- **Links on handwriting** live on the page:

  ```jsonc
  "links": [{ "id", "strokeIds": ["…"], "target": "Title#Page 2", "noteId": "…?", "createdAt" }]
  ```

  The ink stays ink; the link rides on its strokes. `target` is a wiki-link target; `noteId` is the
  note it resolved to when made (resolution prefers it, so renames never break it). A link whose
  strokes are all erased is ignored. Sync merges `links` by id like texts and images.
- **Inline tags.** `#tags` in typed text or recognized handwriting (Obsidian's rule: `#` after
  whitespace or punctuation, letters/digits/`_`/`-`/`/`, at least one non-digit; not in links,
  code or URLs) are added to `tags`. `inlineTags` remembers which ones came from the text, so
  deleting the `#tag` removes it again without touching tags set by hand.
- **Daily notes** carry `"daily": "YYYY-MM-DD"` (local day) and are titled with that day, in the
  "Journal" notebook. `[[2026-11-02]]` opens (or starts) that day's note.
- **`properties`** (optional object) holds front-matter properties imported from Markdown that
  Inkwright has no field for; they are written back on Obsidian export (docs/OBSIDIAN.md).
- Renaming a note in the app rewrites `[[Old title…]]` links (and ink link targets) in the notes
  that pointed to it. Other writers should do the same or leave links to resolve by `noteId`.

## Templates (`templates/<id>/template.json`)

```jsonc
{ "id", "name", "kind": "paged|board", "paper": { … }, "pageSize": { … }, "tags": ["…"],
  "pages": [ /* PageInk without recognition results; ids are placeholders */ ],
  "createdAt", "updatedAt", "formatVersion": 2 }
```

A note made from a template gets fresh ids for itself, its pages and every item (ink links are
remapped to the new stroke ids), and `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{title}}`,
`{{weekday}}`, `{{yesterday}}`, `{{tomorrow}}` in typed text are filled in (Moment-style formats,
as in Obsidian). Files used by the template's pages are under `templates/<id>/assets/` and are
copied into the new note.

## Locked notes

A note locked with a passcode keeps its content encrypted at rest — on the device and in every
synced copy. The key is derived from the passcode and never stored. The reference implementation is
`packages/core/src/lock.ts` (with `Vault.lockNote`, `removeLock`, `unlock`, `forget`); the threat
model is in [PRIVACY.md](PRIVACY.md).

```jsonc
// note.json
"lock": {
  "v": 1,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64url, 16 bytes>" },
  "cipher": "AES-GCM-256",
  "check": { "v": 1, "iv": "<base64url, 12 bytes>", "data": "<base64url>" },   // AES-GCM("inkwright-lock-check-v1"), AAD "inkwright:check"
  "meta":  { "v": 1, "iv": "…", "data": "…" },                                 // optional: sealed { summary, forms, properties }
  "lockedAt": 1730000000000 }
```

- **Key:** PBKDF2-HMAC-SHA-256 over the passcode (Unicode NFKC) with `salt` and `iterations` →
  a 256-bit AES-GCM key. A passcode is right when `check` decrypts to `inkwright-lock-check-v1`.
- **Pages:** each `pages/<pageId>.ink.json` is `{ "id", "formatVersion", "strokes": [], "sealed": {…} }`,
  where `sealed` is AES-GCM (random 96-bit IV) of the page file's normal JSON, with associated data
  `inkwright:page:<pageId>`. Readers that don't know locks see a blank page; the derived SVG and
  `note.md` are blank too.
- **Metadata:** `summary`, `forms` and `properties` move into `lock.meta` (AAD `inkwright:meta:<noteId>`).
  The title, tags, notebook, dates, page ids and sizes and recording list stay readable, so the
  library can list and sort the note.
- **Assets:** every file in `assets/` is `"INKSEAL1"` ‖ 12-byte IV ‖ AES-GCM ciphertext, with AAD
  `inkwright:asset:<file name>`.
- **History:** snapshots are sealed too (see "Version history").
- **Writers** that don't hold the key must not write a locked note's pages or assets (the reference
  `Vault` refuses with `NoteLockedError`); metadata-only changes (rename, tags, move, pin, trash) are
  fine. Removing a lock writes every file back in plain form and deletes `lock`.
- **Sync** treats sealed files like any other: `sealed` merges field-wise (the newer side wins if both
  devices changed the same locked page offline — the other side's version survives in its version
  history only if that device had the note open).

## Version history

Automatic snapshots of a note: when it is opened and closed, every ten minutes while it is being
edited, before the assistant, a routine or an outside agent changes it, and before a version is
restored. A snapshot identical to the latest one is not written. Reference: `VersionHistory` in
`packages/core/src/history.ts`.

```jsonc
// notes/<noteId>/history/<snapshotId>.json      (snapshot ids are ordinary time-sortable ids)
{ "v": 1, "id", "noteId", "takenAt": 1730000000000,
  "reason": "open|close|interval|agent|restore|manual",
  "blobs": ["<hash>", …],                // page contents in page order
  "digest": "<hex>",                     // fingerprint of meta + blobs, to skip duplicates
  "meta": { /* NoteMeta at the time, without lock */ }, "pageIds": ["…"],   // plain notes
  "sealed": { "v": 1, "iv", "data" },    // locked notes instead: { meta, pageIds } encrypted, AAD "inkwright:snapshot:<id>"
  "device": "Kitchen tablet" }           // optional
// notes/<noteId>/history/blobs/<hash>.json
<the page file's JSON>                   // locked notes: a sealed box of it, AAD "inkwright:history:<hash>"
```

`<hash>` is the first 40 hex digits of SHA-256 of the page JSON (of `lockSalt + ":" + JSON` for a
locked note), so unchanged pages are stored once. Every file is written once and never modified, so
devices can't conflict over them; sync copies them as whole files.

**Retention** (`retainSnapshots`): everything from the last two hours; the newest snapshot of each
hour for a day; of each day for 30 days; of each week for a year; at most 300; the newest snapshot is
always kept. Pruning deletes manifests outside these rules and then blobs no manifest uses; it never
needs the key.

**Restoring** replaces the note's pages, page order, and title, tags, paper, page size, summary and
form values with the snapshot's, through ordinary edits (so the authorship chain records them and
undo steps back), after taking a "restore" snapshot of the current state. A single page can instead
be copied into the note with fresh ids.

## Time travel and branches

**Time travel** ("show my notes as of a date") adds nothing to the vault: a reader assembles the
past from version history (`AsOfFS` in `packages/core/src/timeline.ts`). For a time `t`, a note
created after `t` is absent; a note unchanged since (`updatedAt <= t`) is shown as it is (in the
trash only if `trashedAt <= t`); a note changed since is shown from its newest snapshot taken at or
before `t`; a note changed since with no snapshot that old is left out and reported, never shown
with content it did not have then. Notebooks and assets are shown as they are now.

### Branches (`branches/<branchId>.json`)

A branch holds changes proposed by an agent (dry run, docs/TRUST.md) as a shadow copy of only
the notes they touch, to compare with the notes and then merge or discard. Reference:
`BranchStore` in `packages/core/src/branches.ts`.

```jsonc
{ "v": 1, "id": "01J…", "name": "Assistant tidy-up",
  "createdAt": 1730000000000, "updatedAt": 1730000100000,
  "status": "open|merged|discarded", "decidedAt": 1730000200000,      // decidedAt once decided
  "origin": { "source": "assistant", "label": "Assistant" },
  "proposals": ["<proposalId>", …],                                   // ai/proposals applied on it, in order
  "notes": {
    "<noteId>": {
      "title": "Plan (tidied)",
      "base": { "meta": { /* NoteMeta, no lock */ }, "pageIds": ["…"], "blobs": ["<hash>", …] },  // null: made on the branch
      "head": { "meta": { … }, "pageIds": ["…"], "blobs": ["<hash>", …] }
    } } }
```

`base` is the note as it was in the vault when the branch first changed it; `head` is the branch's
version. Page contents are blobs in `notes/<noteId>/history/blobs/<hash>.json`, named exactly like
version history's (first 40 hex digits of SHA-256 of the page JSON), so a page a branch did not
change is the same file as the history's and costs nothing. Version-history pruning keeps blobs
that open branches use; discarding a branch deletes the folders of notes that exist only on it.
Locked notes are never put on a branch. Branch files sync like other files (newest wins); their
blobs are write-once.

**Merging** a branch is a three-way merge per note — base, the note now, the branch's head — with
the same rules sync uses for `note.json` and pages (`mergeBranchNote` in
`packages/sync/src/branch-merge.ts`): what changed in the note since the branch started is kept,
items and fields both sides changed take the branch's version. The result is applied as one
ordinary edit (version history snapshots the note first; the authorship chain records the change),
and everything the agent wrote carries `origin: "ai"`.

## NotebookMeta (`notebook.json`)

`{ "id", "name", "color", "parentId?", "createdAt", "formatVersion" }` — notebooks nest via `parentId`.

## Sync

Sync engines (Google Drive, WebDAV, local folder) mirror this tree file-for-file. Conflicts on
`*.ink.json` and `note.json` are merged three-way against the last-synced base: strokes/texts/
images/objects are unioned by id with deletions honoured from either side; authorship chain events
are unioned and ordered by time (including collaborators' events with `by`; an item's `author`
is part of its content, so it merges like any other field); scalar metadata takes the most
recent `updatedAt`. `forms` merges per PDF and per field (filling different fields on two devices
keeps both; the newer note wins a field both changed). `codeRefs` merges per link the same way. Transcripts merge too: within the same `run`,
segments are unioned by id (one-sided edits and deletions honoured, the newer file wins a segment
both changed) and `complete` is true if either side finished; different runs (one device
transcribed the recording again) are not mixed — the newer file's run wins whole. The lecture
summary with the newer `at` wins. Page summaries merge per page id, newer `at` winning. Derived files are regenerated after merge. Sync state lives outside the vault
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
(`references/`, `assets/`, `scripts/`). Inkwright never executes scripts. `ai/skills.json` is
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

Times are the device's local time. A routine runs while Inkwright is open; a slot missed while it
was closed runs once on the next open (`slots` records it so no device repeats it). The always-on
runner (`inkwright-agent run`, see docs/AGENTS.md) runs the same routines from a computer.

**Routines lease** — `ai/leases/routines.json`, written by an always-on runner while it runs:

```jsonc
{ "holder": "runner:<host>:<pid>:<random>", "label": "The Inkwright agent on <host>",
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
still that text; `text_replaced {noteId, pageId, textId, before, after}` (an accepted compiled-wiki
update) → put `before` back if the text box still holds `after`; `external {server, detail?}` —
a change in a connected app, listed only. The newest 300 runs are kept (and fewer days when the
AI policy's `retention.activityDays` says so; none are removed under legal hold).

**AI policy** — `ai/policy.json`, written by Settings › AI › Routing & privacy (or by hand). Only
fields that differ from the defaults are present; every field is optional and readers fill in the
defaults. The full schema and defaults are in docs/TRUST.md › The policy file:

```jsonc
{ "version": 1,
  "routes": { "background|chat|heavy|vision": "auto|device|off|provider:<provider config id>" },
  "notebooks": { "<notebookId>": { "access?": "none|read|read-write", "localOnly?": true } },
  "tags": { "<tag, lower case, no #>": { "access?": "…", "localOnly?": true } },
  "budgets": { "<provider config id or provider id>": { "monthlyUsd": 20, "onExceed": "device|block" } },
  "privacy": { "mode": "redact|off", "kinds": { "<email|phone|card|iban|gov_id|secret|address|name|ip>": "redact|block|allow" }, "allowList?": [] },
  "compression": { "enabled", "minTokens", "deviceSummaries" },
  "injection": { "spotlight", "confirmWritesAfterSuspicious", "confirmWritesAfterAnyRead?" },
  "tools": { "deny": ["<tool name or * pattern>"], "allowOnly?": [] },
  "agentWrites": { "assistant|routine|external": "apply|propose" },
  "retention": { "activityDays", "auditDays", "historyDays", "legalHold" },
  "prices": { "<model pattern>": { "input", "output", "cachedInput?" } } }
```

A field with a mistake is reported and keeps its default (so a typo never weakens protection).
Sync treats it as a whole file like the rest of `ai/`.

**Proposals** — `ai/proposals/<id>.json`, a change an agent proposed under dry run:

```jsonc
{ "id", "createdAt", "source": "assistant|routine|external", "label", "noteId?", "noteTitle?",
  "summary", "before", "after",
  "op": { "op": "createNote", "args": { "title", "text", "notebookId?", "tags?" } }
      | { "op": "appendText", "noteId", "text", "pageIndex?" } | { "op": "updateNote", "noteId", "patch" }
      | { "op": "createNotebook", "name", "parentId?" } | { "op": "trashNote", "noteId" },
  "status": "pending|applied|rejected|failed", "decidedAt?", "outcome?" }
```

Approving applies `op` through the same recorded host as a live agent (so it lands in Activity).
Decided proposals are removed after 30 days.

**Usage** — `ai/usage/<YYYY-MM>/<device>.json`, one file per device and month (so devices never
write the same file): `{ "version": 1, "device", "month", "rows": [ { "day": "YYYY-MM-DD",
"provider", "label", "model", "local", "calls", "inputTokens", "outputTokens",
"uncompressedInputTokens", "costUsd": number|null, "savedUsd": number|null, "redactions",
"blocked" } ] }`. Budgets sum every device's rows for the month.

**Audit trail** — `ai/audit/<device>/<YYYY-MM>.jsonl`, one JSON object per line, append-only, one
hash chain per device (`<device>` is the short authorship-key fingerprint in the app, `srv-<hash>`
for a server). Each event: `{ "v": 1, "seq", "at", "dev", "prev", "kind", …fields, "hash",
"sig?" }` where `hash` is SHA-256 (hex) of the canonical JSON (sorted keys, no whitespace) of the
event without `hash` and `sig`, `prev` is the previous event's hash (`genesis:<dev>` for the
first), and `sig` is an ES256 signature (base64url) over the 32 hash bytes by the key declared in
the latest `key` event (`data.publicJwk`; each month file starts with one). Kinds and fields are
listed in docs/TRUST.md › Audit trail. Retention removes whole months and then records a
`retention` event whose `data.prunedHead` is the hash the remaining chain starts after.

**Runbook runs** (docs/DEVELOPERS.md § 5) are activity runs with `source: "external"`, `label:
"Runbook"` and one `external` op (`server: "Runbook"`, `tool: "run_http|run_sql|run_js"`, the
outcome in `summary`, the block's first 300 characters in `detail`); status `cancelled` when the
user declined a request. They change nothing in the notes, so there is nothing to undo.

## Code sources (`code/`)

Repositories the developer module has read (docs/DEVELOPERS.md). Written by the app, the
`inkwright scan` CLI or any tool; each source is its own folder, synced as whole files. Ids match
`^[0-9A-Za-z_-]{1,64}$`. The reference is `CodeStore` in `packages/core/src/dev/codegraph.ts`.

```jsonc
// code/sources/<id>/source.json
{ "id": "shop", "name": "shop", "kind": "folder|zip|tarball|cli|graphify|generic",
  "origin": "shop-main.zip", "createdAt", "scannedAt",
  "stats": { "files": 42, "symbols": 310, "edges": 512, "skipped?": 3 }, "formatVersion": 1 }

// code/sources/<id>/graph.json (compact JSON)
{ "formatVersion": 1, "sourceId": "shop", "name": "shop", "scannedAt",
  "generator": "inkwright-tree-sitter/1",            // or "graphify/<version>", "generic-json"
  "files": [ { "path": "src/auth.ts", "language": "typescript", "hash": "<16 hex>", "size": 812 } ],
  "symbols": [ {
      "id": "src/auth.ts#SessionStore.put",           // path#qualified: exactly what a code link names
      "name": "put", "qualified": "SessionStore.put",
      "kind": "function|method|class|interface|type|enum|const|struct|trait|route|module",
      "file": "src/auth.ts", "line": 14, "endLine": 18,
      "signature": "put(s: Session): void",           // the declaration without its body
      "hash": "<16 hex>",                              // SHA-256 of the normalised signature
      "bodyHash?": "<16 hex>", "exported?": true, "doc?": "First doc-comment line",
      "source?": "<first 80 lines>", "route?": { "method": "GET", "path": "/health" } } ],
  "edges": [ { "from": "<symbol id or file path>", "to": "<symbol id, file path, Go package folder, or module:<name>>",
               "kind": "calls|imports|contains|extends|implements|references|handles",
               "confidence?": "extracted|inferred|ambiguous" } ],
  "skipped?": 3, "warnings?": ["…"] }
```

The signature is normalised before hashing: whitespace collapsed, spaces around punctuation
removed, trailing commas dropped — so reformatting never reads as a change. Writers sort files,
symbols and edges (by path, line, id) so the same code always gives the same file.

**Lesson proposals** — `ai/lessons.json`:

```jsonc
{ "version": 1, "items": [
  { "id", "text": "Run migrations with --dry-run first", "why?", "noteId?", "noteTitle?",
    "status": "proposed|accepted|dismissed", "createdAt", "decidedAt?" } ] }
```

Accepted lessons are appended to the `AGENTS.md` note as text; decided ones stay (newest 300) so
the same lesson is not proposed twice.

## Context compiler

The compiled wiki, provenance, contradiction ledger, study decks and context packs
(docs/COMPILER.md). Reference: `packages/core/src/compiler/`, `packages/ai/src/compiler/`.

**Compiled pages** are ordinary notes in the notebook "Compiled wiki" (people in "Compiled wiki ›
People"), tagged `compiled`, with one AI text box (`origin: "ai"`) holding Markdown: `# Title`, one
bullet per claim, and `Sources: [[Note]] · …`. Users may edit them; lines without provenance are
kept as "Your notes" when the page is updated.

**Provenance** — `notes/<noteId>/assets/provenance.json` (any note with AI text: compiled pages,
answers inserted from the assistant, the saved summary):

```jsonc
{ "formatVersion": 1, "updatedAt": 0,
  "gens": { "g…": { "by": "On this device · Qwen3 1.7B", "provider": "device", "model": "…",
                    "prompt": "compiler.page/1", "at": 0 } },
  "items": {
    "text:<textBoxId>": { "at": 0, "gen": "g…",
      "claims": [ { "s": "Latency must stay under 50 ms.", "t": "E",          // E | I | A
                    "src": ["<noteId>/1/64,80,600,21.6#a1b2c3d4"], "c": 1, "why?": "…" } ],
      "prev": { "gen": "g…", "claims": [ … ] } },                             // previous generation (undo)
    "summary": { … }, "page:<pageId>": { … } } }
```

A claim is one sentence, found again in the text by its normalised wording. `t`: EXTRACTED (quoted),
INFERRED (synthesised from the cited sources), AMBIGUOUS (sources disagree or support is unclear).
A source anchor is `<noteId>/<page, 1-based>[/x,y,w,h][@<clipId>:<ms>]#<hash>`: the region in page
units, optionally a moment in a recording, and the hash of the source sentence (32-bit FNV-1a of
its normalised text plus its length, base 36) when it was read. When no sentence of the cited note
has that hash any more, the claim is stale; hash `0` marks a region with no sentence behind it
(never stale). Sync merges the file per item (the newer `at` wins one both sides changed; a
deletion on one side of an unchanged item is honoured); generations are unioned.

**Compiler state** — `ai/compiler/config.json`
`{ version, sources: { notebooks, tags, notes }, people, ai: "device|active|none", notebookId?,
ledger, threshold, updatedAt }` and `ai/compiler/state.json`
`{ formatVersion, pages: { "<key>": { key, kind, title, noteId, pageId, textId, fingerprint,
sourceNotes, at } }, declined?: { "<key>": "<fingerprint>" }, lastCompileAt? }` (whole files;
the state can always be rebuilt by compiling again). Proposals —
`ai/compiler/proposals/<id>.json`: `{ id, createdAt, reason, gen, status: "pending|done", runIds?,
items: [ { id, key, kind, title, action: "create|update|archive", noteId?, fingerprint,
sourceNotes, sourceTitles, added, removed, kept, next, dropped: [{ text, reason }], gen?, note?,
index?, decision?: "accepted|rejected", decidedAt? } ] }` (claims as in provenance; one file per
proposal; the newest 30 decided ones are kept).

**Ledger decisions** — `ai/ledger/<conflictId>.json`: `{ id, status: "dismissed|resolved",
note?, a, b, at }` where `a`/`b` are the two sentences. The conflict id is derived from both
sentences' hashes, so a decision holds while they stay the same.

**Study decks** — `ai/study/<deckId>.json` (deck id = the note id, or a new id):

```jsonc
{ "formatVersion": 1, "id", "title", "noteId?", "notebookId?", "updatedAt",
  "cards": [ { "id", "q", "a", "src": "<anchor>", "from": "note|highlight|ink|wiki|manual",
               "origin": "ai|extracted|user", "createdAt", "updatedAt", "suspended?": false,
               "mem": { "due", "s", "d", "reps", "lapses", "state": 0, "step", "sched", "last?" } } ],
  "reviews": [ { "card", "at", "rating": 1, "answer?", "score?" } ] }   // latest 500
```

`mem` is the FSRS-6 card (ts-fsrs) with times in epoch ms: stability `s` (days), difficulty `d`,
state 0 new / 1 learning / 2 review / 3 relearning. Sync merges decks card by card (a card both
sides reviewed takes the newer `updatedAt`) and unions reviews.

**Context packs** — `ai/packs/<id>/pack.md` (the cited Markdown) and `pack.json`
(`format: "inkwright-context-pack/1"`, compiled claims with sources, notes, images as base64). The
MCP server lists them as `inkwright://packs/{id}`. **Memory eval** — `ai/evals/memory.json`: the
last report (questions, per-condition results, accuracy, citation accuracy, tokens, McNemar
comparisons).


## Plugins (`plugins/`)

Third-party plugins (docs/PLUGINS.md). The files of a plugin are stored exactly as published
under `plugins/<id>/` (`id` = the manifest's id); only code, JSON, CSS, Markdown, text and image
files are kept, at most 5 MB. `plugins/<id>/data.json` is the plugin's own storage
(`{"settings": {…}, "storage": {…}}`); it survives updates and is removed on uninstall.

```jsonc
// plugins/plugins.json
{
  "formatVersion": 1,
  "plugins": [
    {
      "id": "app.inkwright.examples.word-count",
      "version": "1.0.0",
      "enabled": true,
      "granted": ["notes:read", "editor:read", "events"],   // a subset of the manifest's permissions
      "source": { "kind": "catalog", "catalogId": "app.inkwright.examples.word-count" },  // or url | zip | folder
      "installedAt": 1730000000000,
      "updatedAt": 1730000000000                            // bumped on every change to the record
    }
  ]
}
```

Readers ignore unknown fields and records without `id`/`version`. A plugin whose files are
missing (half-synced) or whose manifest no longer validates is listed but never run.

## API keys (`api/keys.json`)

Keys for the REST API of `inkwright-mcp --http` (docs/API.md). Only hashes are stored: a key is
`ink_<id>_<secret>` with a 10-character public id and 32 random bytes (base64url); `hash` is the
hex SHA-256 of the whole key.

```jsonc
{
  "formatVersion": 1,
  "keys": [
    { "id": "k3v9x0aq1m", "name": "Shortcuts", "prefix": "ink_k3v9x0aq1m", "hash": "9f2c…(64 hex)",
      "scopes": ["notes:read", "notes:write"], "createdAt": 1730000000000, "updatedAt": 1730000000000,
      "createdBy": "app", "expiresAt": 1760000000000, "revokedAt": 1740000000000 }
  ]
}
```

Scopes: `notes:read`, `notes:write`, `routines:run`, `webhooks`, `admin`. Records with a hash that
is not 64 hex characters are ignored, so a plaintext key can never be accepted.

### Sync

- `plugins/plugins.json` merges per plugin id: when both devices changed a record the newer
  `updatedAt` wins; a plugin uninstalled on one device and untouched on the other stays
  uninstalled, but one updated meanwhile survives.
- `api/keys.json` unions keys by id and never drops one (a stale copy must not resurrect a
  deleted key as valid); `revokedAt` set on either side wins.
- `plugins/<id>/*` and `data.json` follow the default newest-wins rule.

Webhook subscriptions and their signing secrets are not in the vault: the server keeps them in
its state folder (`--state-dir`), so secrets never sync to a cloud drive.

## Ink actions (docs/INK_ACTIONS.md)

All optional; readers that don't know them ignore them, and sync merges them like the rest of a
page (objects by id, other page fields field-wise).

**Photo underlay** (`PageInk.underlay`). The straightened photo a page's strokes were traced from
("Photo to ink"): a PNG asset of the note covering the whole page, `width` × `height` pixels.
Never drawn, thumbnailed or exported; the app can show it over the ink to compare. The traced
strokes are ordinary strokes with `origin: "import"`.

```jsonc
"underlay": { "asset": "01JD….png", "width": 1400, "height": 1980, "kind": "photo" }
```

**Data tables** (`TableObject.data`). A table showing data from the data sandbox: the grid holds a
preview (header + first rows) and `data` points at the full data. `asset` is the note asset with
the data ("" for a query result kept on the page), `table` its SQL table name, `query` the SQL
that produced a result table.

```jsonc
{ "type": "table", …, "origin": "import|solver",
  "data": { "asset": "sales.csv", "table": "sales", "rowCount": 1204,
            "columns": [{ "name": "region", "type": "text" }, { "name": "amount", "type": "number" }],
            "query": "SELECT …" } }
```

**Data files** (`notes/<id>/assets/`). The shared data-attachment format of the data sandbox and
the developer module's runbook SQL blocks: each `.csv`, `.tsv`, `.json` (and, for the sandbox,
`.ndjson`) asset is one table named after the file by `sqlIdent` ("Sales 2024.csv" →
`sales_2024`). Spreadsheets are kept as dropped (`.xlsx`, `.xls`, `.ods`) and converted to one
`<book>-<sheet>.csv` per sheet (`<book>.csv` for a single sheet). The app's own JSON assets
(`provenance.json`, `page-summaries.json`, `*.transcript.json`, `authorship-*.json`) are not data.

**Query log** (`notes/<id>/assets/data-queries.jsonl`). One JSON object per line, appended for
every query run on the note's data — by the user or the assistant — with every attempt of the
repair loop:

```jsonc
{ "at": 1730000000000, "by": "you|assistant", "question": "total by region", "ok": true,
  "attempts": [{ "sql": "…", "ok": false, "error": "Binder Error: …", "ms": 4, "engine": "DuckDB" },
               { "sql": "…", "ok": true, "rowCount": 3, "ms": 6, "engine": "DuckDB" }] }
```

**Overlay origin.** Sticky notes (and tape) may carry `origin` like other objects; executable
diagrams keep step results as stickies with `origin: "ai"` (an AI step) or `"solver"` (computed on
the device).

**AI ink.** Answers written in handwriting are ordinary strokes with `origin: "ai"`. Their
provenance, while the compiler is on, is in the note's `provenance.json` under `ink:<first stroke
id>` (typed answers: `text:<id>`).

**Paper notes** (`NoteMeta.properties`). A paper in the library of papers is a note tagged
`paper` (in the "Papers" notebook) whose properties hold the reference: readable fields that
become YAML front matter on Obsidian export, plus the full CSL-JSON item, and the attached PDF's
asset once one is matched.

```jsonc
"properties": {
  "citekey": "lecun2015", "reference-type": "article-journal",
  "authors": ["Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton"], "year": 2015,
  "container": "Nature", "doi": "10.1038/nature14539",
  "csl": { "id": "lecun2015", "type": "article-journal", "title": "Deep learning", … },
  "pdf": "01JD….pdf"
}
```
