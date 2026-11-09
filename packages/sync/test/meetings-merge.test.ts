import { describe, expect, it } from 'vitest';
import {
  MEETINGS_LIBRARY_PATH,
  addMeetingNotesVersion,
  decodeMeetingNotes,
  decodeMeetingsLibrary,
  decodeNote,
  emptyLibrary,
  encodeMeetingNotes,
  encodeMeetingsLibrary,
  encodeNote,
  removeFromLibrary,
  upsertInLibrary,
  type MeetingNotesVersion,
  type NoteMeta,
} from '@inkwright/core';
import { mergeFileBytes, mergeKindOf, mergeNote } from '../src/merge.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => new TextDecoder().decode(b!);
const v = (id: string, at: number): MeetingNotesVersion => ({ id, at, by: 't', template: 'general', clipIds: [], sections: [{ heading: 'H', items: [{ id: 'i', text: id }] }] });

describe('meetings in sync', () => {
  it('knows the files', () => {
    expect(mergeKindOf('notes/n1/assets/meeting-notes.json')).toBe('meeting-notes');
    expect(mergeKindOf(MEETINGS_LIBRARY_PATH)).toBe('meetings-library');
  });

  it('unions enhanced-notes versions from two devices and shows the newest choice', () => {
    const base = addMeetingNotesVersion(null, v('v1', 1));
    const local = { ...addMeetingNotesVersion(base, v('v2', 2)), updatedAt: 10 };
    const remote = { ...addMeetingNotesVersion(base, v('v3', 3)), updatedAt: 20 };
    const out = decodeMeetingNotes(dec(mergeFileBytes('notes/n1/assets/meeting-notes.json', enc(encodeMeetingNotes(base)), enc(encodeMeetingNotes(local)), enc(encodeMeetingNotes(remote)))));
    expect(out.versions.map((x) => x.id)).toEqual(['v1', 'v2', 'v3']);
    expect(out.current).toBe('v3');
    const back = decodeMeetingNotes(dec(mergeFileBytes('notes/n1/assets/meeting-notes.json', null, enc(encodeMeetingNotes({ ...local, updatedAt: 30 })), enc(encodeMeetingNotes(remote)))));
    expect(back.current).toBe('v2');
  });

  it('merges your templates and recipes, a deletion on one device included', () => {
    const base = upsertInLibrary(upsertInLibrary(emptyLibrary(), 'recipes', { id: 'r', name: 'R', description: '', prompt: 'p', scope: 'meeting' }, 1), 'recipes', { id: 'q', name: 'Q', description: '', prompt: 'q', scope: 'many' }, 2);
    const local = upsertInLibrary(base, 'recipes', { ...base.recipes[0]!, prompt: 'p2' }, Date.now() - 1000);
    const remote = removeFromLibrary(base, 'q', Date.now() - 500);
    const out = decodeMeetingsLibrary(dec(mergeFileBytes(MEETINGS_LIBRARY_PATH, enc(encodeMeetingsLibrary(base)), enc(encodeMeetingsLibrary(local)), enc(encodeMeetingsLibrary(remote)))));
    expect(out.recipes.map((r) => [r.id, r.prompt])).toEqual([['r', 'p2']]);
  });

  it('merges a note’s meeting info like its other fields (newest change wins)', () => {
    const base = decodeNote(encodeNote({ id: 'n', title: 'T', kind: 'paged', pageIds: [], tags: [], createdAt: 1, updatedAt: 1, pinned: false, formatVersion: 1 } as unknown as NoteMeta));
    const local = { ...base, updatedAt: 5, meeting: { template: 'standup' } };
    const remote = { ...base, updatedAt: 3, title: 'T2' };
    const m = mergeNote(base, local, remote);
    expect(m.meeting).toEqual({ template: 'standup' });
    expect(m.title).toBe('T2');
  });
});
