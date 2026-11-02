---
name: extract-todos
description: Finds action items in notes (checkboxes, "need to", "TODO", things someone must do) and turns them into a clean checklist with due dates. Use when the user asks for their to-dos, tasks, action items or next steps, or wants them collected into one list.
metadata:
  author: inkstone
  version: "1.0"
---

# Extract to-dos

1. Read the relevant notes (`read_note`). For "all my to-dos", search for checkbox and task words
   (`search_notes` with "todo", "to do", "need to", "[ ]") and read the hits.
2. An action item is something someone needs to do. Ignore facts, ideas and finished history,
   unless written as a checked task.
3. Write each item as a short imperative phrase in the note's language ("Email Sam the budget").
4. Resolve relative dates ("tomorrow", "next Friday", "by the 3rd") against today's date to
   `YYYY-MM-DD`; leave the date out when none is given.
5. Mark checked boxes (☑, `[x]`, crossed out) as done.
6. Format as a Markdown checklist:

   ```
   - [ ] Email Sam the budget (due 2026-11-07)
   - [x] Book the room
   ```

7. Remove duplicates. If there are no tasks, say so.
8. To collect them into a note, `append_to_note` an existing "Tasks" note when there is one
   (search first), otherwise `create_note` titled "Tasks". Don't add items that are already in it.
