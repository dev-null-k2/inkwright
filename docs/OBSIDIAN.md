# Inkwright ⇄ Obsidian

Inkwright notes can leave as an Obsidian vault and Obsidian vaults can come in as Inkwright notes.
Settings › Knowledge has the buttons (also in the search palette: "Export for
Obsidian", "Import an Obsidian vault"). A `.zip` of Markdown files dropped on the library or opened
with "Open file" is imported the same way (an Inkwright backup zip is still restored as a backup).

The mapping lives in `packages/core/src/obsidian.ts` (pure, tested in Node:
`packages/core/test/obsidian.test.ts`); the app renders page pictures and reads/writes zips and
folders (`apps/web/src/lib/obsidian.ts`).

## Export

```
Inkwright/                          (zip root; "Export into a folder" writes this folder into the folder you pick)
  <Notebook>/<Sub-notebook>/<Note title>.md
  <Note title>.md                  unfiled notes
  attachments/<Note title> - page 2.png
  attachments/<Note title>.pdf     imported PDFs
  attachments/<Note title> - recording ….webm
```

| Inkwright | Obsidian |
|---|---|
| Notebook (nested) | Folder (nested) |
| Note title | File name. Characters Obsidian refuses (`\ / : * ? " < > \| # ^ [ ]`) are replaced; when the name differs from the title, the title is kept in `aliases`. Names are unique across the vault (" 2", " 3"…) so `[[name]]` is never ambiguous. |
| Tags (set by hand and `#tags` written in the note) | `tags:` property |
| Created / edited | `created:` / `updated:` (ISO 8601, UTC) |
| AI summary | `summary:` |
| Note id | `inkwright-id:` |
| Properties imported from Markdown earlier (`status`, `aliases`, …) | Written back as they were |
| Pages | `## Page N` headings when a note has more than one page |
| Typed text (Markdown) | The text, as written |
| Recognized handwriting | Plain text under the page's typed text |
| `[[links]]` in text and handwriting | Kept. Links to notes whose file name differs from the title become `[[file name\|Title]]`; `[[Note#Page 2]]` works in Obsidian because pages are headings. |
| Links on handwriting (ink links) | A line `Linked in handwriting: [[A]] · [[B]]`, so Obsidian's graph and backlinks see them |
| Ink, images, PDF pages, paper | One PNG per page that has any of them (rendered as on screen, ~1600 px wide), embedded with `![[…]]` |
| Imported PDFs, audio recordings | Copied to `attachments/` and embedded |

Typed-only pages get no picture (their text is already the Markdown). Empty notebooks are not
exported (a zip has no empty folders).

## Import

Pick a vault folder (desktop browsers) or a `.zip`. Everything under `.obsidian/`, `.trash/`, dot
files and `__MACOSX/` is ignored; a zip with a single top folder is treated as that folder.

| Markdown | Inkwright |
|---|---|
| `Folder/Sub/Note.md` | Note "Note" in notebook "Sub" inside "Folder" (existing notebooks with the same name in the same place are reused) |
| Files at the top level | Unfiled notes |
| `tags:` (list, flow list or text) and `#tags` in the text | Tags (inline ones are remembered as inline, see `inlineTags`) |
| `created` / `date` / `date created` | Created (else the file's modified time) |
| `updated` / `modified` / `date modified` | Edited |
| `summary` | AI summary field |
| Any other property (`aliases`, `status`, nested values…) | `properties` on the note, kept for the next export |
| Body | Typed text flowed over pages (A4/Letter as in your defaults), long notes continue on new pages |
| `[[links]]`, `[[Note#Heading\|alias]]` | Kept as written; they resolve by title, as in Obsidian |
| `[label](Other%20note.md#h)` | `[[Other note#h\|label]]` |
| `![[image.png]]`, `![[image.png\|300]]`, `![alt](path/image.png)` | The image placed on the page (width from `\|300`, else its own size up to the page width) |
| `![[file.pdf]]` | The PDF's pages appended as annotatable pages |
| `![[Other note]]` (note embed) | `[[Other note]]` |
| Images and files nothing embeds | Not imported (listed in the import report) |

Round trip: exporting and importing again keeps titles, notebooks, tags, dates, summaries, links
and properties; handwriting comes back as the page pictures (Markdown has no ink).
