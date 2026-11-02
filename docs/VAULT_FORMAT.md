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
  "background": { "kind": "pdf|image", "asset": "file.pdf", "pageNumber": 1 },   // optional
  "paper": { … }, "size": { … },                                               // optional per-page overrides
  "recognizedText": "…", "recognizedAt": 0, "recognizedBy": "mlkit|gemini-2.5-flash|…"   // optional
}
```

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
  "summary": "…?", "trashedAt": 0, "formatVersion": 2
}
```

Paper styles: `blank ruled_narrow ruled_wide dot_grid square_grid graph_mm isometric cornell music
planner_day planner_week todo`. Tints: `white ivory cream recycled kraft mint blush slate midnight`.
Textures: `smooth standard toothy`.

## NotebookMeta (`notebook.json`)

`{ "id", "name", "color", "parentId?", "createdAt", "formatVersion" }` — notebooks nest via `parentId`.

## Sync

Sync engines (Google Drive, WebDAV, local folder) mirror this tree file-for-file. Conflicts on
`*.ink.json` and `note.json` are merged three-way against the last-synced base: strokes/texts/
images are unioned by id with deletions honoured from either side; scalar metadata takes the most
recent `updatedAt`. Derived files are regenerated after merge. Sync state lives outside the vault
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
was closed runs once on the next open (`slots` records it so no device repeats it).

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
`notebook_created {notebookId, name}` → delete it if still empty; `external {server, detail?}` —
a change in a connected app, listed only. The newest 300 runs are kept.
