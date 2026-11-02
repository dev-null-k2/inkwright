import { create } from 'zustand';
import { readingSegments, unreadHandwriting, type NoteDocument, type ReadingSegment, type SegmentFilter } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import { recognizeLocally } from '../lib/recognition.ts';
import { useInkPrefs } from '../inkactions/prefs.ts';

/**
 * Read aloud: the page (or the lasso selection) is spoken piece by piece with the Web Speech API
 * (`speechSynthesis`; on Android that is the system's text-to-speech through the WebView), and the
 * ink being read is picked out with the same highlight search results use (`focusStrokes`), typed
 * text with the search flash. Handwriting nobody has recognized yet is read on the device first
 * when an on-device recognizer exists.
 */

interface ReadAloudState {
  playing: boolean;
  paused: boolean;
  index: number;
  segments: ReadingSegment[];
}

export const useReadAloud = create<ReadAloudState>(() => ({ playing: false, paused: false, index: 0, segments: [] }));

export const speechSupported = () => typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance !== 'undefined';

let session = 0;

/** The voices this device offers (they load asynchronously in some browsers). */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1200);
  });
}

/** What would be read (pure; also used by tests through the e2e hook). */
export function segmentsToRead(doc: NoteDocument, pageIndex: number, filter?: SegmentFilter): ReadingSegment[] {
  return readingSegments(doc.page(pageIndex), filter);
}

export async function startReadAloud(o: { doc: NoteDocument; engine: InkEngine | null; pageIndex: number; filter?: SegmentFilter }): Promise<'started' | 'empty' | 'unsupported'> {
  if (!speechSupported()) return 'unsupported';
  stopReadAloud();
  const page = o.doc.page(o.pageIndex);
  if (unreadHandwriting(page)) {
    // On-device recognition only: reading aloud never sends handwriting anywhere by itself.
    const local = await recognizeLocally(page.strokes.filter((s) => !s.origin)).catch(() => null);
    if (local?.text.trim()) o.doc.setRecognizedText(page.id, local.text, local.engine, local.lines);
  }
  const segments = segmentsToRead(o.doc, o.pageIndex, o.filter);
  if (!segments.length) return 'empty';
  const my = ++session;
  useReadAloud.setState({ playing: true, paused: false, index: 0, segments });
  const { rate, voice } = useInkPrefs.getState().readAloud;
  const voices = await listVoices();
  const v = voices.find((x) => x.voiceURI === voice) ?? null;
  const speakAt = (i: number) => {
    if (my !== session) return;
    const seg = segments[i];
    if (!seg) { stopReadAloud(); return; }
    useReadAloud.setState({ index: i });
    const u = new SpeechSynthesisUtterance(seg.text);
    u.rate = rate;
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onstart = () => highlight(o.engine, o.pageIndex, seg);
    u.onend = () => speakAt(i + 1);
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') speakAt(i + 1); };
    speechSynthesis.speak(u);
  };
  speakAt(0);
  return 'started';
}

function highlight(engine: InkEngine | null, pageIndex: number, seg: ReadingSegment) {
  if (!engine) return;
  const ms = Math.max(2500, seg.text.length * 90);
  if (seg.strokeIds?.length) engine.focusStrokes(pageIndex, seg.strokeIds, ms);
  else engine.flashRegion(pageIndex, seg.rect, ms);
}

export function pauseReadAloud() {
  if (!speechSupported()) return;
  const s = useReadAloud.getState();
  if (!s.playing) return;
  if (s.paused) speechSynthesis.resume(); else speechSynthesis.pause();
  useReadAloud.setState({ paused: !s.paused });
}

export function stopReadAloud() {
  session++;
  if (speechSupported()) speechSynthesis.cancel();
  useReadAloud.setState({ playing: false, paused: false, index: 0, segments: [] });
}
