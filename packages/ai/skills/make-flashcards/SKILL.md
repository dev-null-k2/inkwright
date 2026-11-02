---
name: make-flashcards
description: Turns notes into question-and-answer study flashcards covering the most important facts, definitions and relationships. Use when the user wants flashcards, study cards, revision questions or to quiz themselves before an exam.
metadata:
  author: inkwright
  version: "1.0"
---

# Make flashcards

1. Read the source notes with `read_note` (search by subject or exam name first).
2. Make up to 10 cards per note (fewer if the note is short), covering the most important facts,
   definitions and relationships.
3. Each question is specific and answerable from the notes alone; each answer is short (a phrase or
   one sentence). No duplicates. Use the notes' language.
4. Never add facts that are not in the notes.
5. Format each card as:

   ```
   **Q:** What does Ohm's law relate?
   **A:** Voltage, current and resistance (V = I·R).
   ```

6. To save them, create one note titled "Flashcards — <subject>" (`create_note`) and tag it
   `flashcards`. If such a note exists already, append only new cards to it.
