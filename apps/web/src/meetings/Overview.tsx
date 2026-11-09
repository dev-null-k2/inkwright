/**
 * Two ways to take in a meeting without reading it: an **audio overview** (a short two-voice
 * conversation about the notes, written by the AI and read aloud on the device with two system
 * voices) and a **mind map** of the notes (no AI: the notes' own sections and points).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play, Square } from 'lucide-react';
import { audioOverviewMessages, notesToLines, parseOverview, type OverviewLine } from '@inkwright/ai';
import { mindMapLayout, mindMapSvg, type MeetingNotesVersion, type NoteDocument } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { getActiveAI } from '../lib/ai.ts';
import { listVoices, speechSupported } from '../a11y/readaloud.ts';
import { saveFile } from '../platform/files.ts';
import { Dialog, cx } from '../ui/primitives.tsx';

const css = (name: string, fallback: string) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
};

export function MindMapDialog({ doc, version, onClose }: { doc: NoteDocument; version: MeetingNotesVersion; onClose: () => void }) {
  const svg = useMemo(() => mindMapSvg(mindMapLayout(doc.meta.title, version), { paper: css('--paper', '#fffdf7'), ink: css('--ink', '#2b2330'), ai: css('--ink-3', '#6f6676'), line: css('--line-strong', '#c9c2cc'), accent: css('--moss', '#356b53') }), [doc.meta.title, version]);
  const download = () => void saveFile(`${doc.meta.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'Mind map'}.svg`, new TextEncoder().encode(mindMapSvg(mindMapLayout(doc.meta.title, version))), 'image/svg+xml');
  return (
    <Dialog open wide title="Mind map" onClose={onClose} actions={<><button type="button" className="btn btn-ghost" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" onClick={download}><Download size={15} /> Download SVG</button></>}>
      <div className="mtg-mindmap" role="img" aria-label={`Mind map of ${doc.meta.title}: ${version.sections.map((s) => s.heading).join(', ')}`} dangerouslySetInnerHTML={{ __html: svg }} />
    </Dialog>
  );
}

export function AudioOverviewDialog({ doc, version, onClose }: { doc: NoteDocument; version: MeetingNotesVersion; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [lines, setLines] = useState<OverviewLine[]>([]);
  const [writing, setWriting] = useState(true);
  const [at, setAt] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const voices = useRef<[SpeechSynthesisVoice | null, SpeechSynthesisVoice | null]>([null, null]);
  const stopped = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ai = await getActiveAI({ task: 'heavy', source: 'meetings', label: 'Audio overview', notes: [doc.meta] });
        if (!ai) throw new Error('An audio overview needs an AI. Download the on-device model or connect a provider in Settings › AI.');
        let text = '';
        const r = await ai.provider.chat({ model: ai.model, messages: audioOverviewMessages({ title: doc.meta.title, notes: notesToLines(version, { stamps: false }) }), temperature: 0.6, maxTokens: 900 }, (e) => { if (e.type === 'text' && alive) { text += e.delta; setLines(parseOverview(text)); } });
        if (alive) setLines(parseOverview(r.text || text));
      } catch (e) {
        toast({ text: (e as Error).message, tone: 'error' });
        onClose();
      } finally {
        if (alive) setWriting(false);
      }
    })();
    void listVoices().then((vs) => {
      const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2);
      const same = vs.filter((v) => v.lang.toLowerCase().startsWith(lang));
      const pool = same.length >= 2 ? same : vs;
      const a = pool.find((v) => v.default) ?? pool[0] ?? null;
      const b = pool.find((v) => v !== a && v.name.split(' ')[0] !== a?.name.split(' ')[0]) ?? pool.find((v) => v !== a) ?? a;
      voices.current = [a, b];
    });
    return () => { alive = false; stopped.current = true; if (speechSupported()) speechSynthesis.cancel(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const play = (from = Math.max(0, at)) => {
    if (!speechSupported()) return toast({ text: 'This device can’t read aloud.' });
    speechSynthesis.cancel();
    stopped.current = false;
    setPlaying(true);
    const say = (i: number) => {
      if (stopped.current || i >= lines.length) { setPlaying(false); if (i >= lines.length) setAt(-1); return; }
      const l = lines[i]!;
      const u = new SpeechSynthesisUtterance(l.text);
      const v = voices.current[l.voice === 'A' ? 0 : 1];
      if (v) u.voice = v;
      // Two different voices; when the device has only one, pitch tells them apart.
      if (voices.current[0] === voices.current[1]) u.pitch = l.voice === 'A' ? 0.9 : 1.25;
      u.rate = 1.03;
      u.onend = () => say(i + 1);
      u.onerror = () => say(i + 1);
      setAt(i);
      speechSynthesis.speak(u);
    };
    say(from);
  };
  const pause = () => { stopped.current = true; speechSynthesis.cancel(); setPlaying(false); };

  return (
    <Dialog open wide title="Audio overview" onClose={onClose} actions={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        {playing ? <button type="button" className="btn btn-primary" onClick={pause}><Pause size={15} /> Pause</button>
          : <button type="button" className="btn btn-primary" disabled={writing || !lines.length} onClick={() => play()}><Play size={15} /> {at > 0 ? 'Resume' : 'Play'}</button>}
        {at >= 0 && !playing && <button type="button" className="btn" onClick={() => { setAt(-1); }}><Square size={14} /> Restart</button>}
      </>
    }>
      <p className="mtg-hint">A short conversation about these notes, read aloud on this device. {writing ? 'Writing it…' : `${lines.length} lines.`}</p>
      <ol className="mtg-overview">
        {lines.map((l, i) => (
          <li key={i} className={cx(`is-${l.voice.toLowerCase()}`, i === at && 'is-on')}>
            <button type="button" onClick={() => play(i)}><b>{l.voice === 'A' ? 'Ana' : 'Ben'}</b> {l.text}</button>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
