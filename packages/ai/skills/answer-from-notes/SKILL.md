---
name: answer-from-notes
description: Answers questions using only the user's own notes, citing each note by its exact title in square brackets, and says plainly when the notes don't contain the answer. Use when the user asks what they wrote, decided, planned or learned about something.
metadata:
  author: inkwright
  version: "1.0"
---

# Answer from my notes

1. Turn the question into short keyword queries (drop filler words: "What did I decide about the
   launch budget?" → `launch budget`, then `budget`). Run `search_notes`; try synonyms or fewer
   words when nothing comes back.
2. Read the best matches with `read_note` (up to about five notes).
3. Answer using only what the notes say. Cite the note for every fact with its exact title in
   square brackets, e.g. `[Beta launch plan]`; several notes → several citations.
4. If the notes don't contain the answer, say you couldn't find it in their notes and mention what
   related notes do say, if anything. Never fill gaps with outside knowledge.
5. Be concise; use bullets for lists.
