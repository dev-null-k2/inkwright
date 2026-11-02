---
name: translate-text
description: Translates a note or passage into another language while keeping its meaning, tone and formatting (line breaks, Markdown, lists, numbers, names, URLs and wiki links) exactly. Use when the user asks to translate notes or text.
metadata:
  author: inkwright
  version: "1.0"
---

# Translate

1. Get the text: the user's message, or the note via `read_note`.
2. Translate into the language the user named (a name like "Spanish" or a code like "es").
3. Keep the meaning, tone and formatting exactly: line breaks, Markdown, lists, numbers, names,
   URLs and `[[wiki links]]` stay as they are.
4. Output only the translation — no notes, no quotes around it, no preamble.
5. Save it only when asked: `append_to_note` under a "Translation (<language>)" heading, or
   `create_note` titled "<original title> (<language>)".
