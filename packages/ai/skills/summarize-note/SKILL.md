---
name: summarize-note
description: Summarizes a note faithfully as one or two sentences, a few bullets, or a structured overview, and can save it as the note's library summary. Use when the user asks to summarize, recap, give the gist or TL;DR of a note or set of notes.
metadata:
  author: inkstone
  version: "1.0"
---

# Summarize a note

1. Read the note with `read_note` (find it first with `search_notes` if needed). If a page has
   unrecognized handwriting, read it with `get_page_image` or tell the user it isn't transcribed.
2. Be faithful: use only what the note says and never invent details, names or numbers.
3. Pick the style the user asked for (default: bullets):
   - **Short** — 1–2 sentences, at most 40 words, saying what the note is about and its key point.
   - **Bullets** — 3–7 concise `- ` bullets covering key points, decisions and action items.
   - **Detailed** — a one-sentence overview, then key points, decisions and open questions.
4. Write in the note's language unless the user asks for another one. No preamble ("Here is…").
5. To save it as the summary shown in the library, call `update_note` with `summary` (keep it to
   the short style). Only do this when the user asks to save it.
