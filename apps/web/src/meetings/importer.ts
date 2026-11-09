/**
 * Recordings made elsewhere — Voice Memos, a phone's recorder, a Plaud or other AI voice recorder's
 * export, a Zoom or Teams cloud recording — brought into a note: the audio is kept like one
 * recorded here, transcribed (on the device when the speech model is downloaded, else by the
 * provider) and, in a meeting note, enhanced.
 */
import { newId, type AudioClip, type NoteDocument } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import type { AppVault } from '../lib/vault.ts';
import { decodeToPcm } from '../lib/listen/capture.ts';
import { resolveForFiles, transcribePcm } from '../lib/listen/engines.ts';
import { reindexTranscripts } from '../lib/listen/session.ts';
import { writeTranscript } from '../lib/listen/transcripts.ts';
import { afterMeetingRecording } from './auto.ts';

/** Audio and video files a recorder or call app exports. */
export const RECORDING_ACCEPT = 'audio/*,video/mp4,video/quicktime,video/webm,.m4a,.mp3,.wav,.aac,.ogg,.opus,.flac,.webm,.mp4,.mov,.amr,.3gp';

const extOf = (f: File) => (/\.([a-z0-9]{2,5})$/i.exec(f.name)?.[1] ?? f.type.split('/')[1]?.split(';')[0] ?? 'audio').toLowerCase();

let pending: { noteId: string; file: File } | null = null;
/** A file chosen on the Meetings screen, imported once its new note is open. */
export const importOnOpen = (noteId: string, file: File) => { pending = { noteId, file }; };
export const consumeImportOnOpen = (noteId: string): File | null => {
  if (pending?.noteId !== noteId) return null;
  const f = pending.file;
  pending = null;
  return f;
};

export interface ImportProgress { (text: string | null): void }

export async function importRecording(vault: AppVault, doc: NoteDocument, file: File, progress: ImportProgress = () => {}): Promise<{ clip: AudioClip; lines: number }> {
  const toast = useApp.getState().toast;
  progress('Reading the recording…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let pcm: Float32Array;
    try {
      pcm = await decodeToPcm(bytes);
    } catch {
      throw new Error(`Couldn’t read ${file.name}. Try an .m4a, .mp3 or .wav file.`);
    }
    if (pcm.length < 16_000 / 2) throw new Error(`${file.name} has no audio.`);
    const durationMs = Math.round((pcm.length / 16_000) * 1000);
    const id = newId();
    const asset = `${id}.${extOf(file)}`;
    await vault.vault.writeAsset(doc.meta.id, asset, bytes);
    // The recording's own time when the file has one (when it was made), else now.
    const end = file.lastModified && file.lastModified < Date.now() + 60_000 ? file.lastModified : Date.now();
    const clip: AudioClip = { id, asset, startedAt: end - durationMs, durationMs, mimeType: file.type || `audio/${extOf(file)}`, title: file.name.replace(/\.[^.]+$/, '') };
    doc.updateMeta((m) => ({ ...m, recordings: [...(m.recordings ?? []), clip] }));

    const r = await resolveForFiles();
    if (r.choice.kind !== 'device' && r.choice.kind !== 'provider') {
      toast({ text: 'Recording added. To transcribe it, download the speech model or connect a provider (Meeting › Transcript).' });
      return { clip, lines: 0 };
    }
    const segs = await transcribePcm(pcm, r, (done, total) => progress(`Transcribing… ${done} of ${total}`));
    await writeTranscript(vault, doc.meta.id, { formatVersion: 1, clipId: clip.id, run: newId(), engine: r.engineId, where: r.where!, complete: true, updatedAt: Date.now(), segments: segs });
    await reindexTranscripts(vault, doc.meta.id, doc.meta);
    if (!segs.length) {
      toast({ text: 'No speech found in this recording' });
      return { clip, lines: 0 };
    }
    progress('Writing your notes…');
    await afterMeetingRecording(vault, doc, clip);
    return { clip, lines: segs.length };
  } finally {
    progress(null);
  }
}
