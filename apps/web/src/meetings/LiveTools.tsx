/**
 * Meeting tools around the transcript: while recording, Mark a moment, Catch me up and live
 * translated captions; afterwards, coaching stats and sharing a short audio clip of a moment.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Languages, Scissors, Sparkles, Star } from 'lucide-react';
import { catchUpMessages, parseNumberedLines, translateLinesMessages } from '@inkwright/ai';
import { clipSpan, encodeWav, meetingStats, speakerName, type AudioClip, type NoteDocument, type TranscriptFile, type TranscriptSegment } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { getActiveAI } from '../lib/ai.ts';
import { decodeToPcm } from '../lib/listen/capture.ts';
import { markMoment, useListen } from '../lib/listen/session.ts';
import type { AppVault } from '../lib/vault.ts';
import { saveFile } from '../platform/files.ts';
import { safeStorage } from '../platform/env.ts';
import { cx } from '../ui/primitives.tsx';
import { safeMarkdown } from './render.ts';
import { linkLiveCitations } from '../lib/listen/session.ts';

// ---- While recording ----------------------------------------------------------------------------

export function LiveBar({ doc }: { doc: NoteDocument }) {
  const toast = useApp((s) => s.toast);
  const live = useListen();
  const [catchUp, setCatchUp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mark = () => {
    const ms = markMoment();
    if (ms == null) return toast({ text: 'Start recording to mark moments' });
    toast({ text: 'Marked — it will be in your notes' });
  };
  const catchMeUp = async () => {
    setBusy(true);
    setCatchUp('');
    try {
      const ai = await getActiveAI({ task: 'chat', source: 'meetings', label: 'Catch me up', notes: [doc.meta] });
      if (!ai) throw new Error('Catch me up needs an AI. Download the on-device model or connect a provider in Settings › AI.');
      const lines = live.segments.map((s) => ({ ms: s.startMs, text: s.text }));
      let text = '';
      const r = await ai.provider.chat({ model: ai.model, messages: catchUpMessages(lines, 3), temperature: 0.2, maxTokens: 300 }, (e) => { if (e.type === 'text') { text += e.delta; setCatchUp(text); } });
      setCatchUp(r.text || text);
    } catch (e) {
      setCatchUp(null);
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const html = catchUp ? safeMarkdown(linkLiveCitations(catchUp.replace(/<think>[\s\S]*?(<\/think>|$)/g, ''), doc.meta.id)) : '';
  return (
    <div className="mtg-livebar">
      <div className="mtg-livebar-row">
        <button type="button" className="btn btn-sm" onClick={mark} title="Mark this moment as important (it will be in the notes)"><Star size={14} /> Mark{live.marks.length ? ` · ${live.marks.length}` : ''}</button>
        <button type="button" className="btn btn-sm" onClick={() => void catchMeUp()} disabled={busy || !live.segments.length}><Sparkles size={14} /> Catch me up</button>
      </div>
      {catchUp != null && (
        <div className="mtg-catchup md" aria-live="polite">
          {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <p className="mtg-status"><span className="dot-pulse" /> Reading the last few minutes…</p>}
          {!busy && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCatchUp(null)}>Close</button>}
        </div>
      )}
    </div>
  );
}

// ---- Live translated captions -------------------------------------------------------------------

const LANG_KEY = 'inkwright.meetings.captions.v1';
export const CAPTION_LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Hindi', 'Telugu', 'Tamil', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Arabic', 'Russian', 'Turkish', 'Polish', 'Vietnamese', 'Indonesian'];

export function useCaptionLanguage(): [string | null, (v: string | null) => void] {
  const [lang, setLang] = useState<string | null>(() => safeStorage.get(LANG_KEY) || null);
  return [lang, (v) => { setLang(v); safeStorage.set(LANG_KEY, v ?? ''); }];
}

/** Translations of transcript lines into `lang`, a few at a time as they arrive (id → text). */
export function useTranslations(segments: readonly TranscriptSegment[], lang: string | null, notes: ReadonlyArray<{ id: string }>): Record<string, string> {
  const [out, setOut] = useState<Record<string, string>>({});
  const done = useRef(new Map<string, string>());
  const running = useRef(false);
  useEffect(() => { done.current.clear(); setOut({}); }, [lang]);
  useEffect(() => {
    if (!lang || running.current) return;
    const todo = segments.filter((s) => s.text.trim() && !done.current.has(s.id)).slice(-8);
    if (!todo.length) return;
    running.current = true;
    void (async () => {
      try {
        const ai = await getActiveAI({ task: 'background', source: 'meetings', label: 'Live captions', notes: notes as Array<{ id: string }> });
        if (!ai) return;
        const r = await ai.provider.chat({ model: ai.model, messages: translateLinesMessages(todo.map((s) => s.text), lang), temperature: 0, maxTokens: 600 });
        const lines = parseNumberedLines(r.text, todo.length);
        todo.forEach((s, i) => done.current.set(s.id, lines[i] ?? ''));
        setOut(Object.fromEntries(done.current));
      } catch { /* captions are best effort */ } finally {
        running.current = false;
      }
    })();
  }, [segments.length, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return out;
}

export function CaptionPicker({ lang, onChange }: { lang: string | null; onChange: (v: string | null) => void }) {
  return (
    <label className="mtg-captions" title="Translated captions under each line">
      <Languages size={14} aria-hidden />
      <select value={lang ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Translate captions into">
        <option value="">No translation</option>
        {CAPTION_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
    </label>
  );
}

// ---- Coaching stats ---------------------------------------------------------------------------------

export function StatsCard({ files, them }: { files: TranscriptFile[]; them?: string }) {
  const segs = useMemo(() => files.flatMap((f) => f.segments), [files]);
  const st = useMemo(() => meetingStats(segs), [segs]);
  if (!segs.some((s) => s.speaker) || st.talkMs < 30_000) return null;
  const name = (sp: string) => speakerName(files[0], sp, { them }) ?? sp;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const min = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 1000)} s`);
  return (
    <section className="mtg-stats" aria-label="Meeting stats">
      <h3>How the conversation went</h3>
      <div className="mtg-share-bar" role="img" aria-label={st.speakers.map((s) => `${name(s.speaker)} ${pct(s.share)}`).join(', ')}>
        {st.speakers.map((s) => <span key={s.speaker} className={cx('mtg-share-seg', s.speaker === 'me' && 'is-me')} style={{ flexGrow: Math.max(0.02, s.share) }}>{s.share > 0.12 ? `${name(s.speaker)} ${pct(s.share)}` : ''}</span>)}
      </div>
      <table className="mtg-stats-table">
        <thead><tr><th scope="col"></th><th scope="col">Talked</th><th scope="col">Pace</th><th scope="col">Questions</th><th scope="col">Longest</th><th scope="col">Fillers</th></tr></thead>
        <tbody>
          {st.speakers.map((s) => (
            <tr key={s.speaker}><th scope="row">{name(s.speaker)}</th><td>{pct(s.share)}</td><td>{s.wpm ? `${s.wpm}/min` : '–'}</td><td>{s.questions}</td><td>{min(s.longestMs)}</td><td>{s.fillers}</td></tr>
          ))}
        </tbody>
      </table>
      {st.topFillers.length > 0 && <p className="mtg-hint">Fillers: {st.topFillers.map((f) => `“${f.word}” ×${f.count}`).join(', ')}</p>}
    </section>
  );
}

// ---- Clips ---------------------------------------------------------------------------------------------

/** Cuts the audio around a moment and shares it (share sheet where there is one, else a download). */
export async function shareClip(vault: AppVault, doc: NoteDocument, clip: AudioClip, segments: readonly TranscriptSegment[], ms: number): Promise<'shared' | 'saved'> {
  if (clip.audioDeletedAt) throw new Error('The audio of this recording was deleted after it was transcribed.');
  const bytes = await vault.vault.readAsset(doc.meta.id, clip.asset);
  if (!bytes) throw new Error('The recording file is missing on this device.');
  const pcm = await decodeToPcm(bytes);
  const span = clipSpan(segments, ms);
  const rate = 16_000;
  const part = pcm.slice(Math.floor((span.startMs / 1000) * rate), Math.ceil((span.endMs / 1000) * rate));
  const wav = encodeWav(part, rate);
  const name = `${doc.meta.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40) || 'Clip'} ${Math.floor(span.startMs / 60000)}m${String(Math.floor((span.startMs % 60000) / 1000)).padStart(2, '0')}s.wav`;
  const file = typeof File !== 'undefined' ? new File([wav as BlobPart], name, { type: 'audio/wav' }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: doc.meta.title });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  await saveFile(name, wav, 'audio/wav');
  return 'saved';
}

export function ClipButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="lis-clip" onClick={onClick} aria-label="Share a clip of this moment" title="Share a clip of this moment"><Scissors size={13} /></button>;
}
