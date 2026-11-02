/**
 * The assistant's part of Settings › AI: entry points to Activity, Routines, Connected apps,
 * Skills and Memory (each opens in place), and voice options.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { hostAgentViews, useAgent } from '../../lib/agent/hub.ts';
import { useMcp } from '../../lib/agent/mcp.ts';
import { browserSpeechSupported, providerTranscriber, speechOutputSupported, useVoicePrefs } from '../../lib/agent/voice.ts';
import { Switch } from '../primitives.tsx';
import { AGENT_VIEWS, AgentView, type AgentViewId } from './shared.tsx';

export function AgentSettings() {
  const [open, setOpen] = useState<AgentViewId | null>(null);
  const counts = useCounts();
  useEffect(() => hostAgentViews((v) => setOpen(v as AgentViewId)), []);
  if (open) {
    const v = AGENT_VIEWS.find((x) => x.id === open)!;
    return (
      <section className="set-group ag-settings-view">
        <button type="button" className="ag-back" onClick={() => setOpen(null)}><ArrowLeft size={16} /> Assistant</button>
        <h2 className="ag-view-title">{v.label}</h2>
        <AgentView view={open} />
      </section>
    );
  }
  return (
    <>
      <section className="set-group">
        <h2>Assistant</h2>
        <div className="set-card ag-nav">
          {AGENT_VIEWS.map((v) => (
            <button key={v.id} type="button" className="ag-nav-row" onClick={() => setOpen(v.id)}>
              <span className="nav-icon">{v.icon}</span>
              <span className="ag-nav-text"><span className="row-label">{v.label}</span><span className="row-hint">{v.hint}</span></span>
              {counts[v.id] ? <span className="ag-count">{counts[v.id]}</span> : null}
              <ChevronRight size={16} className="muted" />
            </button>
          ))}
        </div>
      </section>
      <VoiceSettings />
    </>
  );
}

function useCounts(): Partial<Record<AgentViewId, number>> {
  const memory = useAgent((s) => s.memory.filter((m) => m.status === 'proposed').length);
  const approvals = useAgent((s) => s.approvals.length);
  const routines = useAgent((s) => s.routines.filter((r) => r.enabled).length);
  const apps = useMcp((s) => s.servers.filter((x) => x.enabled).length);
  const skills = useAgent((s) => s.skills.filter((x) => !x.builtin).length);
  return { memory, activity: approvals, routines, apps, skills };
}

function VoiceSettings() {
  const prefs = useVoicePrefs();
  const [transcriber, setTranscriber] = useState<string | null | undefined>(undefined);
  useEffect(() => { void providerTranscriber().then((t) => setTranscriber(t?.label ?? null)).catch(() => setTranscriber(null)); }, []);
  const browser = browserSpeechSupported();
  return (
    <section className="set-group">
      <h2>Voice</h2>
      <div className="set-card">
        <label className="field-row">
          <span className="row-label">Talk to the assistant with</span>
          <select value={prefs.input} onChange={(e) => prefs.set({ input: e.target.value as typeof prefs.input })}>
            <option value="auto">Automatic</option>
            <option value="browser" disabled={!browser}>This browser’s speech recognition{browser ? '' : ' (not available)'}</option>
            <option value="provider" disabled={!transcriber}>My AI provider{transcriber ? ` (${transcriber})` : ' (not available)'}</option>
          </select>
        </label>
        {speechOutputSupported() && <Switch label="Read replies aloud" hint="Uses this device’s voices" checked={prefs.speakReplies} onChange={(v) => prefs.set({ speakReplies: v })} />}
      </div>
      <p className="set-note">Hold the microphone in the assistant to talk. {browser ? 'Browser speech recognition may send audio to the browser maker’s servers.' : ''} {transcriber ? `Without it, audio goes to ${transcriber}.` : 'Choose OpenAI, Groq or Gemini as your AI to transcribe in browsers without speech recognition.'}</p>
    </section>
  );
}
