/**
 * Dictation: speak instead of writing. The same engines as live transcripts (on this device by
 * default), with shorter windows so text arrives a few seconds after a pause. The text goes where
 * the person asked: at the caret of the text box being edited, or into a new text box on the page.
 * Nothing is recorded or kept: the audio is dropped once transcribed.
 */
import { create } from 'zustand';
import { newId, type NoteDocument, type SpeechWhere, type TextBox } from '@inkstone/core';
import { resolveSpeech, startLiveTranscription, type LiveTranscription, type ResolvedSpeech } from './engines.ts';

export interface DictationState {
  /** Which surface started it (only that one shows controls). */
  owner: string | null;
  status: 'idle' | 'starting' | 'listening' | 'finishing';
  text: string;
  partial: string;
  where: SpeechWhere | null;
  label: string;
  error: string | null;
  offer: ResolvedSpeech | null;
}

const idle: DictationState = { owner: null, status: 'idle', text: '', partial: '', where: null, label: '', error: null, offer: null };
export const useDictation = create<DictationState>(() => idle);

let session: { live: LiveTranscription; stream: MediaStream } | null = null;

const join = (a: string, b: string) => (!a ? b : !b ? a : /[\s([{"'“]$/.test(a) ? a + b : `${a} ${b}`);

/** Starts listening for `owner`. Resolves false (with the reason in the store) when it can't. */
export async function startDictation(owner: string): Promise<boolean> {
  if (session) return false;
  useDictation.setState({ ...idle, owner, status: 'starting' });
  const r = await resolveSpeech();
  if (r.choice.kind === 'offer-download') { useDictation.setState({ status: 'idle', offer: r, label: r.label }); return false; }
  if (r.choice.kind === 'off' || r.choice.kind === 'none') { useDictation.setState({ status: 'idle', error: r.choice.kind === 'off' ? 'Speech to text is off in Settings › AI.' : r.label }); return false; }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    useDictation.setState({ status: 'idle', error: `Microphone unavailable: ${(e as Error).message}` });
    return false;
  }
  try {
    const live = await startLiveTranscription(stream, Date.now(), r, {
      onSegments: (segs) => useDictation.setState((s) => ({ text: segs.reduce((t, x) => join(t, x.text), s.text) })),
      onPartial: (partial) => useDictation.setState({ partial }),
      onWorking: () => {},
      onError: (error) => useDictation.setState({ error }),
    }, 'dictation');
    session = { live, stream };
    useDictation.setState({ status: 'listening', where: live.where, label: live.label });
    return true;
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    useDictation.setState({ status: 'idle', error: (e as Error).message });
    return false;
  }
}

/** Stops and returns everything heard (after the last words are transcribed). */
export async function stopDictation(): Promise<string> {
  const s = session;
  session = null;
  if (!s) { useDictation.setState(idle); return ''; }
  useDictation.setState({ status: 'finishing' });
  try {
    await s.live.stop();
  } finally {
    s.stream.getTracks().forEach((t) => t.stop());
  }
  const st = useDictation.getState();
  const text = join(st.text, st.partial).trim();
  useDictation.setState(idle);
  return text;
}

export function cancelDictation(): void {
  const s = session;
  session = null;
  s?.live.cancel();
  s?.stream.getTracks().forEach((t) => t.stop());
  useDictation.setState(idle);
}

/** Inserts `text` at `caret` of `value` with sensible spacing. Returns the new value and caret. */
export function insertAtCaret(value: string, caret: number, text: string): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, at), after = value.slice(at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
  const ins = lead + text + trail;
  return { value: before + ins + after, caret: at + ins.length };
}

/** Puts dictated text on a page as a new text box, below what is already there. */
export function placeDictatedText(doc: NoteDocument, pageIndex: number, text: string): TextBox {
  const page = doc.page(pageIndex);
  const ys = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 60)];
  const y = ys.length ? Math.max(...ys) + 32 : 96;
  const width = (doc.meta.pageSize.width || 794) - 128;
  const box: TextBox = { id: newId(), x: 64, y, width, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() };
  doc.upsertText(pageIndex, box, 'Dictate');
  return box;
}
