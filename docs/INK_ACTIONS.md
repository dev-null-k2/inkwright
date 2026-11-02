# Ink that does things

Six modules that make what you write act: AI answers written in ink, hand-drawn diagrams that
run, data you can query on a page, photos of paper turned into ink, reading aloud and a reading
view, and a paper workbench with citations. Each one is a module (Settings › Modules) and can be
switched off on its own; switching one off removes its menu items, palette actions, assistant
tools and drop handling, and leaves everything it already made in your notes.

| Module | Where | Code |
|---|---|---|
| AI answers in ink (`ink-answers`) | lasso bar › Answer, ••• › Write the answer here, AI panel reply › Write in ink, tool `write_in_ink` | `packages/core/src/inkanswer/`, `apps/web/src/inkanswer/` |
| Executable diagrams (`canvas-run`) | lasso bar › Run, ••• › Run diagram | `packages/core/src/canvasdag/`, `apps/web/src/canvasdag/` |
| Data sandbox (`data-sandbox`) | drop a file on a page, ••• › Add data / Query data, tools `list_datasets`, `query_data` | `packages/core/src/datasandbox/`, `apps/web/src/datasandbox/` |
| Photo to ink (`photo-ink`) | ••• › Photo to ink, ••• › Show the original photo | `packages/core/src/photoink/`, `apps/web/src/photoink/` |
| Reading and read aloud (`accessibility`) | ••• › Read aloud, ••• › Reading view, Settings › Reading | `packages/core/src/readaloud/`, `apps/web/src/a11y/` |
| Paper workbench (`papers`) | Library › Papers, `[@` in typed text, ••• › Bibliography | `packages/core/src/papers/`, `apps/web/src/papers/` |

The modules are declared in `apps/web/src/inkactions/modules.ts` and registered with the built-in
modules (`apps/web/src/modules/builtin.ts`); the editor wiring is one hook,
`apps/web/src/inkactions/EditorParts.tsx`. Every model call goes through `getActiveAI` (the
guarded gateway: AI policy, PII firewall, budgets and audit trail — docs/TRUST.md), and notes
the AI policy hides from AI are refused before anything is sent (`aiCanSee`).

## AI answers in ink

**What it does.** Lasso a question — handwriting, typed text or both — and choose **Answer**. The
selection goes to your AI (typed and recognized text as text; handwriting as a picture when the
model can see images), and the answer is put in the free space below the selection (else beside
it, else below everything on the page, else on a new page). Settings › Ink actions › *Answer on
the page in* chooses **Handwriting** (default) or **Typed text**; handwriting is laid out with
`handwrite()` in a joined or print hand, in the `--ai-ink` colour (an indigo distinct from every
pen in the tray), and written on over one to two seconds. People who ask their system for reduced
motion get the finished answer at once. Assistant replies get the same action (**Write in ink**),
and the assistant has a `write_in_ink(noteId, page, text, near?)` tool.

**Guarantees.**
- One undo step: the write-on animation is a document *preview* (never saved, never an undo step);
  the strokes are committed once through `NoteDocument.commit`.
- Never your handwriting: strokes carry `origin: 'ai'`, so the authorship chain classifies them
  as AI ink and certificates never count them as written by you (docs/AUTHORSHIP.md).
- Provenance: while the compiler module is on, the answer's claims are kept in the note's
  provenance file under `ink:<first stroke id>` (or `text:<id>` for typed answers), with the
  model, provider, prompt id `ink.answer/1` and time — the same record Explain reads
  (docs/COMPILER.md).

**Limits.** Handwriting uses two single-line fonts (EMS Allure and EMS Felix): characters they
lack are written as `?`, so Markdown, smart quotes and dashes are simplified first
(`plainForHandwriting`). Long answers shrink to fit (x-height down to 6 units); answers longer
than 1 500 characters are refused by the tool in favour of a text box.

**Privacy.** Only the selection is sent (a cropped picture of it and its text), to the AI you
chose, under your AI policy. Nothing is sent when you have no AI configured.

## Executable diagrams (sketch → graph → run)

**What it does.** Draw boxes and arrows, write or type a label in each box, lasso the diagram and
choose **Run**. The graph is drawn over your sketch for confirmation — boxes outlined, arrows as
they were read; arrows whose direction was only guessed are dashed — with a step card beside each
box. **Run** executes the steps in dependency order (two at a time); **Run this step again** re-runs
one step from the outputs already shown; **Cancel** stops; **Keep results on the page** turns the
outputs into sticky notes (text and numbers), tables and chart images next to their boxes, in one
undo step.

**Reading the sketch** (`extractGraph`). Boxes are snapped rectangles/ellipses/polygons, closed
loops drawn in one stroke, or 2–4 strokes that join end to end into a loop (each piece must use
both of its ends, so a fan of arrows leaving one point is never mistaken for a box). A box around
two or more boxes is a frame, not a step. Labels are typed text and recognized handwriting lines
inside a box; handwriting nobody has recognized yet is read first (on the device, else by the AI).
Each end of a connector attaches to the nearest box within a tolerance that grows with the box.
Direction comes from an arrowhead stroke (a "V" or a single barb whose tip is at one end; each
head goes to the single nearest shaft end, so two arrows into one box never trade heads), else a
hook (a barb drawn in the same stroke), else drawing order (start = tail). Cycles are found with
Tarjan's algorithm and block running; acyclic graphs get a deterministic topological order.

**Steps.** A label starting with a known verb runs on the device, deterministically:
`fetch <url>` (http(s) GET, 15 s, 2 MB, CSV/JSON read as a table, else text), `filter <col> <op>
<value>` (`> >= < <= = != contains is`), `filter <word>`, `sort [by] <col> [desc]`,
`top|limit|first <n>`, `sum|average|min|max [<col>]`, `count`, `chart [bar|line]`, and constants
(`42`, `"text"`). Anything else is an AI step: the label is the instruction and the upstream
outputs (as Markdown tables or text) are its inputs; a Markdown table in the reply becomes a table.

**Quality bar.** `packages/core/evals/canvasdag.eval.ts` generates 120 messy synthetic diagrams
with `handwrite()` labels, four box styles, jittered and curved arrows with V heads, single barbs,
hooks or no head (some drawn backwards), and cycles. Bar: node F1 ≥ 0.98, directed-edge F1 ≥ 0.97,
cycle detection ≥ 0.97, whole diagram exactly right ≥ 0.90. Measured 2 Nov 2026: 1.0 on every
measure. Synthetic sketches bound the geometry; real sketches add habits the generator doesn't
have (arrows that touch text, boxes that overlap), which surface as dashed (guessed) arrows or
loose strokes in the confirmation overlay before anything runs.

**Limits.** `fetch` runs in your browser, so the server must allow cross-origin requests; it never
sends cookies. Steps can't loop or branch. Results are not re-run automatically when the sketch
changes: lasso and Run again.

**Privacy.** Local verbs never leave the device (except `fetch`, to the address you wrote). AI
steps send the step's label and its inputs to your AI under your AI policy.

## Data sandbox

**What it does.** Drop CSV, TSV, JSON (arrays, wrapped arrays, NDJSON), Excel (.xlsx, .xls) or
OpenDocument (.ods) files on a page — or ••• › Add data. Each file becomes a dataset with typed
columns (integer, number, boolean, date, text; thousands separators and `NA`/`null`/empty handled)
and a table on the page showing its first rows. ••• › Query data opens the panel: run read-only
SQL (⌘/Ctrl-Enter), or **Ask** in words, then **Put on page** (a table), **Chart on page** (a bar
or line chart image) or **Copy** (Markdown). The assistant gets `list_datasets` and `query_data`.

**Engines.** [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) (MIT) runs in its own worker,
loaded the first time a query runs (the MVP or exception-handling build, whichever the browser
supports). If it can't start — no Worker or WebAssembly, too little memory, or the single-file
preview build, which leaves DuckDB out — the sandbox falls back to SQLite through sql.js and says
so in the panel. Both get the same tables and column types. Spreadsheets are read with SheetJS
CE 0.20.3 (Apache-2.0), installed from SheetJS's own registry (`cdn.sheetjs.com`) because the
copy on npm (0.18.5) is outdated and has published vulnerabilities.

**Shared with runbooks.** Datasets use the developer module's data-attachment format
(docs/DEVELOPERS.md): one CSV/TSV/JSON file per table in the note's assets, named after the file
(`sqlIdent`: "Sales 2024.csv" → `sales_2024`), columns as SQL identifiers. A file dropped here is a
table in a runbook ```` ```sql ```` block and vice versa. Spreadsheets are stored as one CSV per
sheet (`<book>-<sheet>.csv`) next to the original. Nested JSON objects are flattened to
`parent_child` columns here; runbook blocks keep them as JSON text.

**The repair loop.** `query_data` (and **Ask**) runs `runSqlWithRepair`: the model writes SQL (or
the agent passes its own), the engine runs it, and an error goes back to the model verbatim with
the failed SQL, at most three attempts in all. Every attempt — SQL, error or row count, engine,
time — is returned to the caller and appended to the note's `data-queries.jsonl`, shown as Query
history in the panel.

**Read-only.** Only one `SELECT`/`WITH` statement runs; writes, `ATTACH`, `COPY`, `INSTALL`,
`PRAGMA`, file-reading functions (`read_csv`, `read_parquet`, `query`, …), quoted function names
and file names in table position (`FROM 'x.csv'`) are refused before the engine sees them. That
filter is a convenience; the boundary is DuckDB itself, which starts with external access off:
only the datasets registered for this note can be read, no URL can be fetched and no extension
loaded, and the setting is locked (security review SR-02). A model can't read files or send data
out through SQL.

**Limits.** Data is loaded into memory: comfortable to a few hundred thousand rows. The page table
shows at most 8 rows × 6 columns (the panel shows 200 rows). Charts are bar or line with up to four
series in a fixed, colour-blind-checked palette; one y axis.

**Privacy.** Data never leaves the device unless you Ask in words or the assistant uses
`query_data`: then the tables' schemas and three sample rows (and the question) go to your AI.

## Photo to ink

**What it does.** ••• › Photo to ink: choose or take a photo of handwriting or a diagram on paper.
The page is found automatically (the largest bright region, its extreme corners refined by fitting
a line to each side, so blur doesn't round them off); drag the four corners — or focus one and use
the arrow keys (Shift for bigger steps) — if they are off. **Make ink** straightens the page
(homography), finds ink with Sauvola's adaptive threshold (shadows and uneven light don't become
ink), removes specks, thins it to one-pixel lines (Zhang–Suen), measures the ink's width with a
distance transform, traces the skeleton into polylines (spurs pruned, pieces joined where a line
continues through a junction), and adds a page after the current one with real strokes:
ballpoint, the measured width (pressure follows it along the stroke), the ink's colour when it is
clearly coloured, `origin: 'import'`. The straightened photo is kept as the page's hidden
`underlay`; ••• › Show the original photo lays it faintly over the ink to compare. It is never
drawn into the page, its thumbnail or exports. Tracing runs in a worker.

**Quality bar** (`packages/core/test/photoink.test.ts`). Handwriting from `handwrite()` is
rendered into synthetic photos — a sheet on a desk, perspective, rotation, blur, uneven light and
sensor noise — traced, and compared with the source by symmetric Chamfer distance: under 1.2 page
units for a flat scan and under 2.6 (one stroke width) for phone photos; stroke width within 60 %.
Page corners are found within 2 % of the photo size.

**Limits.** The page's aspect ratio comes from its side lengths in the photo; without the
camera's parameters a strong perspective leaves it a few percent off. Very faint pencil, ruled
lines as dark as the ink, and handwriting crossing the paper's edge trace less well; dots smaller
than the speck filter are dropped. Undo removes the strokes; the added page stays (delete it from
Pages).

**Privacy.** Entirely on the device.

## Reading and read aloud

**Read aloud.** ••• › Read aloud speaks the page — or the lassoed part — in reading order (typed
paragraphs, recognized handwriting lines, sticky notes), and highlights what is being read: the
handwriting's own strokes with the search highlight (`focusStrokes`), typed text with the search
flash. A small player pauses and stops; the sentence being read is announced politely to screen
readers. Handwriting nobody has recognized yet is first read by the on-device recognizer, if
there is one; Read aloud never sends handwriting anywhere by itself. Voice and speed: Settings ›
Reading. Speech uses the Web Speech API: on Android that is the system's text-to-speech through
the WebView. The native plugin has no text-to-speech bridge, so a WebView without
`speechSynthesis` shows that Read aloud is unavailable.

**Reading view.** ••• › Reading view shows the note's typed and recognized text reflowed in your
reading style: a font from those installed on this device (fonts people with dyslexia often
prefer — OpenDyslexic, Lexend, Atkinson Hyperlegible, Andika, Verdana… — are detected by measuring
text; Chromium can list every installed font after you allow it), size, letter, word and line
spacing, a cream, blue or grey background, and **line focus**: the line being read stays clear
while the rest dims; ↑/↓ move between lines. The note itself is never changed.

**Keyboard and screen readers** (the whole app). Every control is reachable with Tab and shows a
jade focus ring (`:focus-visible`, `--iron`). Menus follow the WAI-ARIA menu pattern: focus starts
on the first item; ↑/↓/Home/End move; Escape closes and returns focus to the button that opened
it — popovers return focus the same way. Page layers that hold controls are labelled groups.
`e2e/a11y.spec.ts` runs axe-core (WCAG 2.1 A/AA rules) over the library, the editor with its menu
and a dialog open, and six Settings sections, and allows no serious or critical violation. Fixing
what it found raised three Duan tokens to AA contrast for small text (`--ink-3`, `--moss`,
`--ochre`, and `--ink-3` in Aizome and Celadon).

**Motion and contrast.** Everything added here respects `prefers-reduced-motion` (AI ink appears
at once; no spinners; no fades) and `prefers-contrast: more` (heavier lines and borders on the
diagram overlay, the player and the cards; less dimming in line focus).

## Paper workbench

**Library of papers.** Library › Papers (or the palette: *Library of papers*): **Import
references** reads BibTeX/BibLaTeX (`@string` macros, `#` concatenation, month macros, LaTeX
accents and symbols, BibTeX's name rules including "von" particles, Jr. and `{Corporate
names}`) and CSL-JSON (Zotero, Better BibTeX, Pandoc). Each reference becomes a note in the
**Papers** notebook, tagged `paper`, whose front matter (`NoteMeta.properties`) keeps the
citation key, authors, year, container, DOI, URL and the full CSL item, and whose first page shows
the formatted reference, how to cite it and the abstract. Importing again updates papers already
in the library (same DOI, or same title and year) instead of duplicating them; a different work
whose key is taken gets a suffix (`smith2020a`).

**PDFs.** **Attach PDFs from a folder** (or Choose PDFs) matches files to papers by DOI — in the
file name (`10.1038_nature14539.pdf`) or printed on the PDF's first page — then by citation key
(`lecun2015.pdf`, Better BibTeX's `lecun2015 - Deep learning.pdf`), then by Zotero's
"Author - Year - Title" names (most title words plus the year or first author). Each file goes to
at most one paper; ties are left unmatched rather than guessed. A matched PDF is appended to its
paper's note as annotatable pages.

**Citations.** Type `[@` in any text box for autocomplete by key, author, title word or year
(↑/↓, Enter or Tab, Escape). Pandoc syntax: `[@key]`, `[@a, p. 4; @b]`, `[-@key]`. Resting the
mouse on a citation on the page shows a card with the reference and a link to its note (pens and
fingers never trigger it). ••• › **Bibliography** lists what the note cites in order of first
citation, formatted in **APA 7** or **IEEE** (Settings › Ink actions remembers the choice), names
keys missing from the library, and can copy it, put it on the page, or export it as BibTeX or a
Markdown reference list. Both styles are implemented in `packages/core/src/papers/format.ts`
(author lists, 21+ authors in APA, "et al." after six in IEEE, a/b suffixes for the same author
and year, editions, chapters, proceedings, theses, reports, web pages, DOIs) and tested against
hand-checked references.

**Zotero.** Import is file-based: in Zotero, File › Export Library… as BibTeX, Better BibTeX or
CSL JSON. Zotero's local API (`http://localhost:23119/api/`) answers only other programs on the
computer: it refuses requests from web pages by design (its developers have said web pages
should not have access, and it returns 403 to browser requests), so the app does not use it.

**Limits.** Titles keep the casing they were imported with (sentence case can't be derived
reliably — proper nouns; Zotero stores sentence case already). Citations are recognized in typed
text, not in handwriting.

**Privacy.** All local. Nothing about your library is sent anywhere.

## Vault format

New optional fields and files, all documented in [VAULT_FORMAT.md](VAULT_FORMAT.md) and merged by
sync like the rest of a page (objects by id, other page fields field-wise):
`PageInk.underlay`, `TableObject.data`, `origin` on sticky notes, data files and
`data-queries.jsonl` in a note's assets, and the paper properties in `NoteMeta.properties`.

## Tests

| Layer | Command |
|---|---|
| Unit | `npx vitest run --project core packages/core/test/{papers,datasandbox,canvasdag,photoink,inkanswer}.test.ts` |
| Unit (app) | `npx vitest run --project web apps/web/src/inkactions` |
| Merge | `npx vitest run --project sync packages/sync/test/inkactions-merge.test.ts` |
| Eval | `npx vitest run --project evals packages/core/evals/canvasdag.eval.ts` |
| End-to-end | `cd apps/web && PW_PORT=4195 npx playwright test e2e/ink-actions.spec.ts e2e/a11y.spec.ts --project desktop` |
