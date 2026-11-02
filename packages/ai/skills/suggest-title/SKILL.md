---
name: suggest-title
description: Names notes with one short, specific title (2–7 words) in the note's language. Use when the user asks for a title, wants untitled notes named, or when filing notes that are still called "Untitled".
metadata:
  author: inkstone
  version: "1.0"
---

# Suggest a title

1. Read the note (`read_note`); if it is only handwriting, look at the first page with
   `get_page_image` when available.
2. Write one short, specific title of 2–7 words in the note's language: no quotes, no trailing
   period, no "Notes on…" filler. Prefer the concrete subject ("Thermodynamics lecture 4",
   "Lisbon trip packing").
3. Rename with `update_note` (`title`) only when the user asked you to rename or file notes;
   otherwise just suggest it.
