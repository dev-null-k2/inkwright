/**
 * The Meetings module while it is on: loads your templates and recipes, adds palette actions,
 * keeps the coming-up list fresh and, shortly before a meeting starts, offers to take notes for
 * it (an in-app toast, and a system notification when the person allowed them).
 */
import { useApp } from '../state/app.ts';
import { registerPaletteActions } from '../lib/palette.ts';

declare const __E2E__: boolean;
const reminded = new Set<string>();
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

export function openMeetings(): void {
  useApp.getState().navigate({ name: 'meetings' });
}

export async function activateMeetings(): Promise<() => void> {
  let stopped = false;
  const vault = () => useApp.getState().vault;
  const stopActions = registerPaletteActions('meetings', () => [
    { id: 'meetings.open', label: 'Meetings', keywords: 'meetings calendar coming up people companies recipes ask across', run: openMeetings },
    { id: 'meetings.new', label: 'New meeting note', keywords: 'meeting notes record call zoom meet teams', run: () => { const v = vault(); if (v) void import('./calendar.ts').then((c) => c.startMeetingNote(v, null, { record: true })); } },
  ]);

  const tick = async () => {
    const v = vault();
    if (stopped || !v) return;
    const { loadUpcoming, startMeetingNote, useUpcoming } = await import('./calendar.ts');
    const { useMeetingPrefs } = await import('./store.ts');
    const now = Date.now();
    const stale = now - useUpcoming.getState().loadedAt > 10 * 60_000;
    const meetings = stale ? await loadUpcoming(v, { refresh: true }).catch(() => useUpcoming.getState().meetings) : useUpcoming.getState().meetings;
    const minutes = useMeetingPrefs.getState().remindMinutes;
    if (!minutes) return;
    for (const m of meetings) {
      const lead = m.start - now;
      if (lead > minutes * 60_000 || lead < -60_000 || reminded.has(m.key)) continue;
      reminded.add(m.key);
      const when = lead > 30_000 ? `in ${Math.round(lead / 60_000)} min` : 'now';
      useApp.getState().toast({ text: `${m.title} starts ${when}`, action: { label: 'Take notes', run: () => void startMeetingNote(v, m, { record: true }) } });
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
          const n = new Notification(m.title, { body: `Starts ${when}. Click to take notes.`, tag: m.key });
          n.onclick = () => { window.focus(); void startMeetingNote(v, m, { record: true }); n.close(); };
        }
      } catch { /* notifications unavailable */ }
    }
  };

  const ready = async () => {
    const v = vault();
    if (!v || stopped) return;
    const { loadMeetingsLibrary } = await import('./store.ts');
    await loadMeetingsLibrary(v).catch(() => null);
    await tick();
  };
  // Calendars are read a little after start-up, so opening the app stays quick.
  const first = setTimeout(() => void ready(), 6000);
  if (E2E_BUILD) {
    // Tests: put a recording's transcript on a note without a microphone (every engine).
    (window as any).__inkwrightMeetings = {
      async seedRecording(noteId: string, segments: Array<{ startMs: number; endMs: number; text: string; speaker?: string }>, durationMs: number, marks: number[] = []) {
        const v = vault()!;
        const { writeTranscript } = await import('../lib/listen/transcripts.ts');
        const { reindexTranscripts } = await import('../lib/listen/session.ts');
        const clip = { id: `clip${Date.now().toString(36)}`, asset: 'none.webm', startedAt: Date.now() - durationMs, durationMs, mimeType: 'audio/webm' };
        const doc = (window as any).__inkwright?.doc;
        if (doc?.meta.id === noteId) doc.updateMeta((m: any) => ({ ...m, recordings: [...(m.recordings ?? []), clip] }));
        else await v.vault.updateNote(noteId, (m) => ({ ...m, recordings: [...(m.recordings ?? []), clip] }));
        await writeTranscript(v, noteId, { formatVersion: 1, clipId: clip.id, run: 'e2e', engine: 'e2e', where: 'device', complete: true, updatedAt: Date.now(), segments: segments.map((x, i) => ({ id: `s${i}`, ...x })), ...(marks.length ? { marks: marks.map((ms, i) => ({ id: `m${i}`, ms })) } : {}) });
        await reindexTranscripts(v, noteId, doc?.meta.id === noteId ? doc.meta : undefined);
        return clip.id;
      },
    };
  }
  const unsub = useApp.subscribe((s, prev) => { if (s.vault && s.vault !== prev.vault) void ready(); });
  const timer = setInterval(() => void tick(), 30_000);
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); unsub(); stopActions(); };
}
