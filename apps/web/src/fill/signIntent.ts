/**
 * Notes the editor should open with the Fill & sign layer already on, because they were opened
 * through "Sign a document" (signFlow.ts). Separate from the flow so the editor can read it
 * without loading the flow.
 */
const pending = new Set<string>();

/** Asks the editor to open `noteId` ready to fill in and sign. */
export function requestFillOnOpen(noteId: string): void {
  pending.add(noteId);
}

/** True (once) when `noteId` was opened through "Sign a document". */
export function takeFillRequest(noteId: string): boolean {
  return pending.delete(noteId);
}
