---
name: suggest-tags
description: Suggests 1–5 short topical tags for a note, reusing tags the user already has so the library stays consistent. Use when the user asks to tag, label or categorize notes, or when filing unfiled notes.
metadata:
  author: inkstone
  version: "1.0"
---

# Suggest tags

1. Read the note (`read_note`).
2. Look at the tags already in use (`list_notes` shows each note's tags) and prefer those when they
   fit, so the same topic always gets the same tag.
3. Suggest 1–5 short topical tags: lowercase, 1–3 words, hyphenated (`exam-prep`), no `#`.
4. When applying them with `update_note`, remember `tags` replaces the whole list — include the
   note's existing tags you want to keep.
