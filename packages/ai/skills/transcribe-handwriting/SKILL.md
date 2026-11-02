---
name: transcribe-handwriting
description: Reads handwriting on a note page and turns it into text, keeping the writer's line breaks or restoring structure as Markdown (headings, lists, checkboxes). Use when the user asks to transcribe, convert, type up or read their handwriting, or when a page has ink that is not recognized yet.
metadata:
  author: inkstone
  version: "1.0"
---

# Transcribe handwriting

1. Find the note (`search_notes` or `list_notes`) and call `read_note`. Pages with
   `has_handwriting: true` and `handwriting_recognized: false` still need transcribing.
2. Look at each such page with `get_page_image` (only vision models have it; if it is missing,
   tell the user to use **Transcribe page** in the assistant panel or choose a vision model).
3. Transcribe exactly what is written, in reading order:
   - Do not translate, summarize or fix grammar. Keep the writer's abbreviations.
   - Mark words you cannot read as `[?]`.
   - Ignore ruled lines, grids, page decorations and crossed-out text.
   - Plain mode: one output line per written line, bullets and numbers as plain characters,
     skip drawings.
   - Markdown mode (when the user wants structure): `#` for titles, `- ` for bullets, `1.` for
     numbered items, `- [ ] ` / `- [x] ` for checkboxes, `$…$` for math, and drawings described
     briefly as `_[sketch: …]_`.
4. Show the transcription. Only add it to the note (`append_to_note`) or create a new note when
   the user asks for that.

If a page has no handwriting, say so instead of inventing text.
