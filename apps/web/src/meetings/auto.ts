/**
 * What happens when a recording in a note ends, with Meetings on: the notes are enhanced (when
 * that is switched on and there is a transcript), and the audio is deleted once the transcript
 * is saved, when the person chose not to keep audio. Runs after `finishListening` has saved and
 * indexed the transcript.
 */
import type { AudioClip, NoteDocument } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { loadNoteTranscripts } from '../lib/listen/transcripts.ts';
import type { AppVault } from '../lib/vault.ts';
import { enhanceMeetingNotes } from './enhance.ts';
import { useMeetingPrefs } from './store.ts';

/** Deletes a recording's audio, keeping its transcript and the clip's timing (no undo: asked first in Settings). */
export async function deleteClipAudio(vault: AppVault, doc: NoteDocument, clip: AudioClip): Promise<void> {
  await vault.vault.deleteAsset(doc.meta.id, clip.asset).catch(() => {});
  doc.updateMeta((m) => ({ ...m, recordings: (m.recordings ?? []).map((c) => (c.id === clip.id ? { ...c, audioDeletedAt: Date.now() } : c)) }));
}

export async function afterMeetingRecording(vault: AppVault, doc: NoteDocument, clip: AudioClip): Promise<void> {
  const prefs = useMeetingPrefs.getState();
  const toast = useApp.getState().toast;
  const has = (await loadNoteTranscripts(vault, doc.meta)).some((r) => r.clip.id === clip.id && r.file.segments.length > 0);
  if (!has) return; // no transcript: keep the audio (it can still be transcribed later)
  if (!prefs.keepAudio) await deleteClipAudio(vault, doc, clip);
  // Enhanced automatically in meeting notes (from the calendar, "New meeting", or tagged #meeting);
  // other recordings (a lecture) keep their summaries and can be enhanced from the panel.
  const isMeeting = !!doc.meta.meeting || doc.meta.tags.includes('meeting');
  if (prefs.autoEnhance && isMeeting) {
    try {
      await enhanceMeetingNotes({ vault, note: doc.meta, pages: doc.pages, reason: 'enhance' });
      toast({ text: 'Your notes are enhanced — see Meeting', tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  }
}
