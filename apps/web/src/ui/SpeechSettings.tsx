import { useEffect, useState } from 'react';
import { recommendAsr, whereExplanation, type SpeechPreference } from '@inkstone/ai';
import { asrChoice, initLocalAI, localAISupported, useLocalAI } from '../lib/localai.ts';
import { resolveSpeech, speechLanguage, useSpeechPrefs, type ResolvedSpeech } from '../lib/listen/engines.ts';
import { ModelPicker } from './LocalAISettings.tsx';
import { Segmented, Switch } from './primitives.tsx';
import { WhereBadge } from './TranscriptPanel.tsx';

/**
 * Settings › AI › Speech to text: who transcribes recordings and dictation (with where the audio
 * goes, in plain words), the on-device speech model and its download, the speech language, and
 * what happens around recordings (open the transcript, summarize pages, add page notes).
 */
export function SpeechSettings() {
  const p = useSpeechPrefs();
  const st = useLocalAI();
  const [now, setNow] = useState<ResolvedSpeech | null>(null);
  useEffect(() => { void initLocalAI(); }, []);
  useEffect(() => { void resolveSpeech().then(setNow); }, [p.engine, p.language, st.installed, st.asrModel, st.ready]);
  const supported = localAISupported() && !!st.hardware;
  const lang = speechLanguage();
  const current = supported ? asrChoice(lang) : null;
  return (
    <section className="set-group" aria-label="Speech to text">
      <h2>Speech to text</h2>
      <div className="set-card">
        <div className="lai-who">
          <span className="field-label">Who transcribes</span>
          <Segmented<SpeechPreference> label="Who transcribes" value={p.engine} onChange={(v) => p.set({ engine: v })} options={[
            { value: 'auto', label: 'Automatic' },
            { value: 'device', label: 'This device' },
            { value: 'browser', label: 'Browser' },
            { value: 'provider', label: 'Your provider' },
            { value: 'off', label: 'Off' },
          ]} />
        </div>
        {now && (
          <div className="lis-set-now">
            {now.where ? <WhereBadge where={now.where} label={now.label} providerName={now.providerName} /> : <span className="muted">{now.label}</span>}
            {now.where && <p className="muted">{whereExplanation(now.where, now.providerName)}</p>}
          </div>
        )}
        {supported && (
          <ModelPicker role="asr" title="Speech model" current={current} recommendedId={st.hardware ? recommendAsr(st.hardware, lang)?.spec.id : undefined} onChange={(id) => st.setPrefs({ asrModel: id })} />
        )}
        <label className="field-row">
          <span className="field-label">Language</span>
          <select value={p.language} aria-label="Speech language" onChange={(e) => p.set({ language: e.target.value })}>
            <option value="">Same as this device ({typeof navigator !== 'undefined' ? navigator.language : 'en'})</option>
            {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <Switch label="Open the transcript while recording" checked={p.autoOpen} onChange={(v) => p.set({ autoOpen: v })} />
        <Switch label="Summarize each page when a recording ends" hint="Uses the assistant’s AI (on this device unless you chose a provider)" checked={p.autoSummary} onChange={(v) => p.set({ autoSummary: v })} />
        <Switch label="Also add page summaries to the pages" checked={p.pageNotes} onChange={(v) => p.set({ pageNotes: v })} />
      </div>
      <p className="set-note">Automatic uses the speech model on this device once it is downloaded, then your browser’s live captions, then your AI provider. Choose “This device” to make sure audio never leaves it. Moonshine is English only; for other languages pick a Whisper model.</p>
    </section>
  );
}

const LANGS: [string, string][] = [
  ['en-US', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'],
  ['pl', 'Polish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['vi', 'Vietnamese'], ['id', 'Indonesian'], ['sv', 'Swedish'],
];
