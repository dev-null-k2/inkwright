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

/**
 * True when `noteId` was opened through "Sign a document". Safe to call while rendering: React
 * may throw a first render away (a lazily loaded part suspending) and run it again, so the request
 * stays until the editor has mounted and calls {@link clearFillRequest}.
 */
export function wantsFill(noteId: string): boolean {
  return pending.has(noteId);
}

/** Called once the editor has mounted with the request applied. */
export function clearFillRequest(noteId: string): void {
  pending.delete(noteId);
}

/** True (once) when `noteId` was opened through "Sign a document". Not for use while rendering. */
export function takeFillRequest(noteId: string): boolean {
  return pending.delete(noteId);
}
