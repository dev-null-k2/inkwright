import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Cloud, Download, Globe, ListChecks, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { formatBytes, whereExplanation } from '@inkstone/ai';
import { formatStamp, newId, type AudioClip, type NoteDocument, type SpeechWhere, type TranscriptFile, type TranscriptSegment } from '@inkstone/core';
import { useApp } from '../state/app.ts';
import type { AppVault } from '../lib/vault.ts';
import { downloadModel, modelKey, refOf, useLocalAI } from '../lib/localai.ts';
import { decodeToPcm } from '../lib/listen/capture.ts';
import { resolveForFiles, transcribePcm, type ResolvedSpeech } from '../lib/listen/engines.ts';
import { focusSaid, reindexTranscripts, summarizeAfterRecording, useListen } from '../lib/listen/session.ts';
import { lectureMarkdown } from '../lib/listen/summaries.ts';
import { loadNoteTranscripts, writeTranscript } from '../lib/listen/transcripts.ts';
import { IconButton, cx } from './primitives.tsx';

/** Where the audio is processed, always visible while transcribing (privacy indicator). */
export function WhereBadge({ where, label, providerName }: { where: SpeechWhere | null; label: string; providerName?: string }) {
  if (!where) return null;
  const Icon = where === 'device' ? ShieldCheck : where === 'browser' ? Globe : Cloud;
  return (
    <span className={cx('lis-where', `is-${where}`)} title={whereExplanation(where, providerName)} role="note" aria-label={`Audio: ${label}. ${whereExplanation(where, providerName)}`}>
      <Icon size={13} aria-hidden /> <span>{label}</span>
    </span>
  );
}

/** Download offer for the on-device speech model ("transcribe privately"). */
export function SpeechModelOffer({ offer }: { offer: ResolvedSpeech }) {
  const st = useLocalAI();
  const asr = offer.asr;
  if (!asr) return null;
  const key = modelKey(refOf(asr));
  const dl = st.downloads[key];
  const done = !!st.installed[key];
  return (
    <div className="lis-offer">
      <p><ShieldCheck size={15} aria-hidden /> Transcribe privately on this device with {asr.spec.label}. It downloads once ({formatBytes(asr.variant.bytes)}, {asr.spec.licence}) and then works offline.</p>
      {done ? <span className="lai-ok">Ready — it will be used from the next recording.</span>
        : dl && !dl.error ? (
          <div className="lai-progress" role="status">
            <div className="lai-bar"><span style={{ width: `${Math.min(100, (dl.loaded / Math.max(1, dl.total)) * 100).toFixed(1)}%` }} /></div>
            <span className="lai-progress-text">{formatBytes(dl.loaded)} of {formatBytes(dl.total)}</span>
          </div>
        ) : <button type="button" className="btn btn-sm" onClick={() => void downloadModel(asr)}><Download size={14} /> Download · {formatBytes(asr.variant.bytes)}</button>}
      {dl?.error && <p className="lai-error" role="alert">{dl.error}</p>}
    </div>
  );
}

const whereOfEngine = (t: TranscriptFile): { where: SpeechWhere; label: string } => ({
  where: t.where,
  label: t.where === 'device' ? 'Transcribed on this device' : t.where === 'browser' ? 'Browser speech service' : 'Transcribed by your AI provider',
});

/**
 * The transcript of the note's recordings, lined up with the ink: the live one while recording
 * (text appears as it is transcribed), saved ones afterwards. Tap a sentence to highlight the ink
 * written then and hear it; tap ink to find the sentence (the editor routes that here).
 */
export function TranscriptPanel({ doc, vault, recording, playing, onClose }: { doc: NoteDocument; vault: AppVault; recording: boolean; playing: { clipId: string; position: number } | null; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const live = useListen();
  const isLive = live.noteId === doc.meta.id && (recording || live.status !== 'idle');
  const clips = doc.meta.recordings ?? [];
  const [files, setFiles] = useState<Record<string, TranscriptFile>>({});
  const [clipId, setClipId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [offer, setOffer] = useState<ResolvedSpeech | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);

  // Saved transcripts (re-read when one is written).
  useEffect(() => {
    let alive = true;
    void loadNoteTranscripts(vault, doc.meta).then((rs) => {
      if (!alive) return;
      setFiles(Object.fromEntries(rs.map((r) => [r.clip.id, r.file])));
    });
    return () => { alive = false; };
  }, [vault, doc.meta.id, clips.length, live.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownClip: AudioClip | null = clips.find((c) => c.id === clipId) ?? clips[clips.length - 1] ?? null;
  const file = shownClip ? files[shownClip.id] : undefined;
  const segments: TranscriptSegment[] = isLive ? live.segments : file?.segments ?? [];
  const activeClip = isLive ? live.clipId : shownClip?.id ?? null;
  const focusMs = live.focus && live.focus.noteId === doc.meta.id && live.focus.clipId === activeClip ? live.focus.ms : null;
  const playMs = playing && playing.clipId === activeClip ? playing.position : null;
  const current = useMemo(() => {
    const t = playMs ?? focusMs;
    if (t == null) return null;
    return segments.find((s) => t >= s.startMs && t < s.endMs + 400)?.id ?? [...segments].reverse().find((s) => s.startMs <= t)?.id ?? null;
  }, [segments, playMs, focusMs]);

  // Live: keep the newest line in view unless the person scrolled up to read.
  useEffect(() => {
    const el = list.current;
    if (isLive && el && follow.current) el.scrollTop = el.scrollHeight;
  }, [isLive, segments.length, live.partial]);
  // A tap on ink or a citation: bring that sentence into view.
  useEffect(() => {
    if (!current || !live.focus || (isLive && live.focus.from !== 'ink')) return;
    list.current?.querySelector(`[data-seg="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [live.focus?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const where = isLive ? (live.where ? { where: live.where, label: live.label } : null) : file ? whereOfEngine(file) : null;

  const transcribeClip = async (clip: AudioClip) => {
    const r = await resolveForFiles();
    if (r.choice.kind === 'offer-download') { setOffer(r); return; }
    if (r.choice.kind !== 'device' && r.choice.kind !== 'provider') { toast({ text: r.label, tone: 'error' }); return; }
    setBusy('Reading the recording…');
    try {
      const bytes = await vault.vault.readAsset(doc.meta.id, clip.asset);
      if (!bytes) throw new Error('The recording file is missing on this device.');
      const pcm = await decodeToPcm(bytes);
      const segs = await transcribePcm(pcm, r, (done, total) => setBusy(`Transcribing… ${done} of ${total}`));
      await writeTranscript(vault, doc.meta.id, { formatVersion: 1, clipId: clip.id, run: newId(), engine: r.engineId, where: r.where!, complete: true, updatedAt: Date.now(), segments: segs, ...(files[clip.id]?.lecture ? { lecture: files[clip.id]!.lecture } : {}) });
      await reindexTranscripts(vault, doc.meta.id);
      toast({ text: segs.length ? `Transcribed ${formatStamp(clip.durationMs)} of audio` : 'No speech found in this recording', tone: segs.length ? 'success' : undefined });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const summarize = async (clip: AudioClip) => {
    setBusy('Summarizing…');
    try {
      await summarizeAfterRecording(vault, doc, clip.id);
      await reindexTranscripts(vault, doc.meta.id);
      toast({ text: 'Summaries ready — see each page in Pages', tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const lecture = !isLive ? file?.lecture : undefined;
  const statusLine = isLive
    ? live.status === 'finishing' ? 'Finishing the transcript…' : live.working ? 'Transcribing…' : live.where ? 'Listening' : ''
    : live.summarizing ? 'Writing summaries…' : busy ?? '';

  return (
    <aside className="side-panel lis-panel" aria-label="Transcript">
      <header className="side-head">
        <h2><AudioLines size={16} /> Transcript</h2>
        <IconButton label="Close transcript" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="lis-meta">
        {where && <WhereBadge where={where.where} label={where.label} />}
        {!isLive && clips.length > 1 && (
          <select className="lis-pick" aria-label="Recording" value={shownClip?.id ?? ''} onChange={(e) => setClipId(e.target.value)}>
            {clips.map((c) => <option key={c.id} value={c.id}>{c.title ?? formatStamp(c.durationMs)}</option>)}
          </select>
        )}
        {statusLine && <span className="lis-status" aria-live="polite">{(live.working || busy || live.status === 'finishing' || live.summarizing) && <span className="dot-pulse" />}{statusLine}</span>}
      </div>
      {isLive && live.offer && <SpeechModelOffer offer={live.offer} />}
      {offer && !isLive && <SpeechModelOffer offer={offer} />}
      {live.error && (live.noteId === doc.meta.id || live.noteId === null) && <p className="lis-error" role="alert">{live.error}</p>}
      {lecture && (
        <section className="lis-lecture" aria-label="Recording summary">
          <h3>Summary</h3>
          <p>{lecture.summary}</p>
          {lecture.keyTerms.length > 0 && <ul className="lis-terms" aria-label="Key terms">{lecture.keyTerms.map((t) => <li key={t}>{t}</li>)}</ul>}
          {lecture.todos.length > 0 && <ul className="lis-todos" aria-label="To-dos">{lecture.todos.map((t) => <li key={t}><ListChecks size={13} aria-hidden /> {t}</li>)}</ul>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
            const i = doc.pageCount - 1;
            const page = doc.page(i);
            const ys = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 60)];
            doc.upsertText(i, { id: newId(), x: 64, y: ys.length ? Math.max(...ys) + 32 : 96, width: (doc.meta.pageSize.width || 794) - 128, text: `## Lecture summary\n${lectureMarkdown(lecture)}`, fontSize: 15, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() }, 'Add lecture summary');
            toast({ text: `Added to page ${i + 1}` });
          }}>Add to the last page</button>
        </section>
      )}
      <ol className="lis-list" ref={list} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {segments.map((s) => (
          <li key={s.id} data-seg={s.id}>
            <button type="button" className={cx('lis-seg', s.id === current && 'is-on')} onClick={() => activeClip && focusSaid(doc.meta.id, activeClip, s.startMs, 'transcript')}>
              <time>{formatStamp(s.startMs)}</time><span>{s.text}</span>
            </button>
          </li>
        ))}
        {isLive && live.partial && <li className="lis-partial" aria-live="polite">{live.partial}</li>}
      </ol>
      {!segments.length && !live.partial && (
        <div className="lis-empty">
          {isLive ? <p>{live.where ? 'Text appears here as it is said, lined up with your writing.' : live.offer ? '' : live.label}</p>
            : !clips.length ? <p>Record while you write to get a transcript lined up with your ink. Tap a sentence to see what you wrote then.</p>
              : !file ? <p>This recording has no transcript yet.</p> : <p>No speech was found in this recording.</p>}
        </div>
      )}
      {!isLive && shownClip && (
        <div className="lis-actions">
          <button type="button" className="btn btn-sm" disabled={!!busy || live.summarizing} onClick={() => void transcribeClip(shownClip)}><RefreshCw size={14} /> {file ? 'Transcribe again' : 'Transcribe recording'}</button>
          {file && file.segments.length > 0 && <button type="button" className="btn btn-sm" disabled={!!busy || live.summarizing} onClick={() => void summarize(shownClip)}><Sparkles size={14} /> Summarize pages</button>}
        </div>
      )}
      {segments.length > 0 && <p className="lis-hint">{isLive ? 'Tap a sentence to see what you were writing.' : 'Tap a sentence to hear it and see what you wrote. Tap ink to find what was said.'}</p>}
    </aside>
  );
}
