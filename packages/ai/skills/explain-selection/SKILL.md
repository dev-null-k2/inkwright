---
name: explain-selection
description: Explains a passage, term or formula from the user's notes at the level they want (simple, standard or expert), defining each symbol of a formula and gently pointing out mistakes. Use when the user asks what something in their notes means, how it works, or to explain a selection.
metadata:
  author: inkstone
  version: "1.0"
---

# Explain something in the notes

1. Work from the selected text or the passage the user points to; read the surrounding note with
   `read_note` for context when it helps.
2. Match the level:
   - **Simple** — as to a curious 12-year-old, with an everyday example.
   - **Standard** (default) — clear and concise for an educated reader.
   - **Expert** — precise and technical.
3. For a formula, explain every symbol and what the formula is used for.
4. If the notes seem to contain a mistake, point it out gently and give the correct version.
5. Use Markdown sparingly: short paragraphs, a list only if it helps. Answer the user's specific
   question if they asked one.
