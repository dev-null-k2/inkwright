# Bringing notes in from other apps

**Settings › Import & clip** has one card per importer. Each importer is its own module
(Settings › Modules), on by default; switching one off removes its card and never touches notes
already imported. Everything runs in the page: files are read and converted on your device and
nothing is uploaded.

| Source | What you give it | Module |
| --- | --- | --- |
| Notion | the workspace or page export, Markdown & CSV, as a zip | Import from Notion |
| Evernote | `.enex` files, one per notebook | Import from Evernote |
| OneNote | pages exported as Word (`.docx`), single-file web page (`.mht`), web page (`.html`) or PDF | Import from OneNote |
| GoodNotes, Notability | notebooks exported as PDF | Import GoodNotes and Notability |
| Any web page | the **Clip to Inkwright** bookmarklet | Web clipper |
| Obsidian or any Markdown folder | the vault folder or its zip | Links & daily notes (Settings › Notes, links & Obsidian; docs/OBSIDIAN.md) |

## How it works

Every importer converts its source into one intermediate form — a Markdown vault: notes as `.md`
files with front matter (tags, created and updated dates, source URL, author), folders for
notebooks, attachments beside them — and hands it to the Markdown importer the Obsidian import
uses (`importObsidianVault`). That importer lays text, pictures and PDFs out on pages, turns
folders into notebooks, keeps tags and dates, and turns links between notes into `[[links]]`. One
layout path for every source means an Evernote note and a Notion page look the same as a
Markdown file, and fixes to the layout reach every importer.

Imported text and pictures carry the origin `import` (docs/AUTHORSHIP.md): they are neither your
handwriting nor AI. Each source lands in a notebook named after it (Notion, Evernote, OneNote,
PDF notebooks) with its own structure beneath.

Code: the converters are pure functions in `packages/core/src/importers/` (tested in
`packages/core/test/importers.test.ts`); the app side — unzipping, PDF outlines and splitting,
the settings cards, the clipper — is `apps/web/src/importers/` (end to end in
`apps/web/e2e/importers.spec.ts`).

## Notion

In Notion: **Settings › Export all workspace content**, or **••• › Export** on a page; format
**Markdown & CSV**, include subpages and files. Large workspaces come as a zip of zips; both are
read.

- Notion names every file `Title <32-hex id>.md`; the ids go from every path and every link, so
  `[Launch](Roadmap%20…/Launch%20….md)` becomes a link to the note "Launch".
- A page with subpages becomes a notebook; the repeated `# Title` line at the top goes (the
  note's title says it).
- Page properties (`Key: value` lines at the top) stay as text, except `Tags:`, which become tags.
- Each database becomes a note with a table, from `<name>_all.csv` (every row) when the export
  has it, otherwise the default view. The first column links to each row's page when rows have
  pages.
- Not imported: comments, page icons and covers, synced blocks beyond their text, formulas
  (their values come through in the CSV), and anything Notion leaves out of the export.

## Evernote

In Evernote: right-click a notebook › **Export notebook…** › ENEX (or select notes › Export).
Each `.enex` file becomes a notebook named after the file.

- Titles, tags, created and updated dates, source URL and author; formatting (headings, bold,
  italics, lists, tables, links, code), checkboxes (`en-todo`) and Evernote 10 tasks (as a to-do
  list at the end).
- Attachments are matched to where the note shows them by their MD5 hash (`en-media`); pictures
  and PDFs appear in place, as page images and annotatable PDF pages. Attachments the note never
  shows are added at the end (pictures, PDFs) or named (other files).
- **Encrypted text** (`en-crypt`) can't be read without its passphrase; it is replaced by
  "[Encrypted text left out]" and reported. Decrypt it in Evernote before exporting.

## OneNote

OneNote keeps notebooks in its own binary format (`.one`, `.onepkg`), which has no complete public
specification or reader; Inkwright reads what OneNote itself exports instead, and explains this
if you pick a `.one` file:

- **OneNote for Windows:** File › Export › Page or Section › **Word Document (.docx)** or
  **Single File Web Page (.mht)**. A section exports as one file, which becomes one note.
- **OneNote for Mac and the web:** export or print to **PDF**; it is imported like a PDF notebook
  (below).
- **Web pages** saved with their `_files` folder: pick the `.html` file and its folder's pictures
  together.

Word documents keep their headings (`Heading 1…6`; OneNote's page title, in the `Title` style,
becomes the note's title), lists with their depth, bold and italics, tables and pictures. Web
archives keep their formatting and pictures (base64 and quoted-printable parts). Ink drawn in
OneNote reaches Word exports as pictures, so it comes in as a picture, not as ink. OneNote's
free-form page layout is already linear in its exports.

## GoodNotes and Notability (PDF)

Export the notebook as PDF — GoodNotes: **Share › Export › PDF**; Notability: **Share › PDF** —
and pick the files.

- The PDF's **outline** (bookmarks) splits it into notes: each top-level entry starts a note that
  runs until the next one; pages before the first entry form a lead note. An outline with one
  entry per page is an index, not sections, and is ignored; so is an outline with fewer than two
  usable entries. Every page lands in exactly one note.
- Pages stay as they look and are annotatable PDF pages: you can write on them. Handwriting
  stays a picture of handwriting (PDF exports flatten ink to vector paths), and any text layer
  the app added (GoodNotes' OCR) is what search and the assistant read.
- Notes are tagged with the app (`goodnotes`, `notability`) when the PDF's metadata says which
  made it.

## The web clipper

Settings › Import & clip › **Clip to Inkwright**: drag it to the bookmarks bar (on a phone, copy
it and save it as a bookmark's address). On any page, press it:

1. In that page, in your browser, it takes your **selection** if you made one, or the page's main
   content — `article`, `main`, or the block with the most paragraph text and fewest links — as
   readable text: headings as `#` lines, lists, quotes, code and tables; navigation, sidebars,
   forms and scripts left out. Title, author and site name come from the page's metadata.
2. It opens Inkwright with the clip in the address's **fragment** (`#clip=…`). Browsers never send
   fragments to a server, so the page's text goes from the tab you clipped to the Inkwright tab
   and nowhere else — no clipping service is involved.
3. Inkwright takes the clip out of the address at once, checks it (it is untrusted: at most
   200,000 characters of plain text, web addresses only), and **shows it to you**: title, site and
   the start of the text. Only **Save note** saves it: typed text with origin `import`, tagged
   `#clipped`, starting with where it came from and when.

Pages that load their content after a click, pages behind a login and PDFs in the browser's
viewer clip what the page shows at that moment. Sites with a strict Content Security Policy can
block bookmarklets; select the text and use the browser's share menu instead. On Android,
**Share › Inkwright** from Chrome saves the link as a note through the app's share target.

## Limits

- Sizes are bounded by the device's memory: a multi-gigabyte Notion export is better split.
- Importing twice imports twice; there is no merge with notes imported earlier.
- Notion and OneNote layouts (columns, side-by-side blocks) come in as one column.
