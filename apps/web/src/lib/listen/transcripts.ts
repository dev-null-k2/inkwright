/**
 * Transcripts and page summaries in the vault, next to the recordings they belong to:
 * `notes/<id>/assets/<clipId>.transcript.json` and `notes/<id>/assets/page-summaries.json`
 * (docs/VAULT_FORMAT.md § Transcripts). Sync merges both structurally (packages/sync merge-listen).
 *
 * Writes go through here so listeners (the transcript panel, the Pages panel, the memory index)
 * hear about them; a sync that pulls new versions shows up as a vault reload.
 */
import {
  PAGE_SUMMARIES_ASSET,
  TRANSCRIPT_FORMAT_VERSION,
  decodePageSummaries,
  decodeTranscript,
  encodePageSummaries,
  encodeTranscript,
  transcriptAssetName,
  type NoteMeta,
  type PageSummariesFile,
  type PageSummary,
  type RecordingTranscript,
  type TranscriptFile,
} from '@inkstone/core';
import type { AppVault } from '../vault.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

type Listener = (noteId: string) => void;
const listeners = new Set<Listener>();

/** Notified after a transcript or page summary of a note was written. */
export function onListenFilesChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(noteId: string) {
  for (const l of [...listeners]) l(noteId);
}

export async function readTranscript(vault: AppVault, noteId: string, clipId: string): Promise<TranscriptFile | null> {
  const bytes = await vault.vault.readAsset(noteId, transcriptAssetName(clipId)).catch(() => null);
  if (!bytes) return null;
  try {
    return decodeTranscript(dec.decode(bytes));
  } catch {
    return null;
  }
}

export async function writeTranscript(vault: AppVault, noteId: string, t: TranscriptFile): Promise<void> {
  await vault.vault.writeAsset(noteId, transcriptAssetName(t.clipId), enc.encode(encodeTranscript({ ...t, formatVersion: TRANSCRIPT_FORMAT_VERSION })));
  changed(noteId);
}

/** Every recording of the note that has a transcript, oldest first. */
export async function loadNoteTranscripts(vault: AppVault, note: Pick<NoteMeta, 'id' | 'recordings'>): Promise<RecordingTranscript[]> {
  const out: RecordingTranscript[] = [];
  for (const clip of note.recordings ?? []) {
    const file = await readTranscript(vault, note.id, clip.id);
    if (file) out.push({ clip, file });
  }
  return out.sort((a, b) => a.clip.startedAt - b.clip.startedAt);
}

export async function readPageSummaries(vault: AppVault, noteId: string): Promise<PageSummariesFile> {
  const bytes = await vault.vault.readAsset(noteId, PAGE_SUMMARIES_ASSET).catch(() => null);
  if (bytes) {
    try {
      return decodePageSummaries(dec.decode(bytes));
    } catch {
      /* unreadable: start over */
    }
  }
  return { formatVersion: TRANSCRIPT_FORMAT_VERSION, updatedAt: 0, pages: {} };
}

/** Sets (or, with null, removes) summaries by page id. */
export async function updatePageSummaries(vault: AppVault, noteId: string, patch: Record<string, PageSummary | null>): Promise<PageSummariesFile> {
  const cur = await readPageSummaries(vault, noteId);
  for (const [id, v] of Object.entries(patch)) {
    if (v) cur.pages[id] = v;
    else delete cur.pages[id];
  }
  cur.updatedAt = Date.now();
  await vault.vault.writeAsset(noteId, PAGE_SUMMARIES_ASSET, enc.encode(encodePageSummaries(cur)));
  changed(noteId);
  return cur;
}
