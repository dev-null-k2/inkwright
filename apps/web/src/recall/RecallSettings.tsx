import { useEffect, useState, type ReactNode } from 'react';
import { History, Trash2 } from 'lucide-react';
import { RETENTION_CHOICES, SKIP_REASON_TEXT } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { Switch } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { invoke, isDesktop } from '../desktop/bridge.ts';
import { bumpRecall, isPaused, loadRecallConfig, recallStore, saveRecallConfig, useRecall } from './state.ts';
import { togglePause } from './service.ts';
import { openTimeline } from './ui.ts';
import './recall.css';

/** Settings › Memory timeline. */

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

function ListEditor({ label, values, placeholder, onChange }: { label: string; values: string[]; placeholder: string; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="rc-set-list">
      <span className="row-label">{label}</span>
      {values.length > 0 && (
        <ul>
          {values.map((v) => (
            <li key={v}>{v}<button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>Remove</button></li>
          ))}
        </ul>
      )}
      <form className="rc-set-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} aria-label={label} />
        <button type="submit" className="btn btn-sm" disabled={!draft.trim()}>Add</button>
      </form>
    </div>
  );
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export function RecallSettings() {
  const vault = useApp((s) => s.vault);
  const r = useRecall();
  const [usage, setUsage] = useState<{ days: number; captures: number; bytes: number } | null>(null);
  const [probe, setProbe] = useState<{ permitted: boolean; canDetectSecureInput: boolean; wayland: boolean; platform: string } | null>(null);

  useEffect(() => { if (vault) void loadRecallConfig(vault); }, [vault]);
  useEffect(() => { if (vault) void recallStore(vault).usage().then(setUsage); }, [vault, r.version]);
  useEffect(() => { if (isDesktop) void invoke<typeof probe>('recall_probe').then(setProbe).catch(() => {}); }, [r.capture]);

  if (!vault) return null;
  const c = r.config;
  const save = (patch: Parameters<typeof saveRecallConfig>[1]) => void saveRecallConfig(vault, patch);
  const paused = isPaused(r);

  const turnOn = async (on: boolean) => {
    if (on) {
      const ok = await askConfirm(
        'Capture this computer’s screen?',
        'Every few seconds Inkwright reads the text of the window in front, on this computer, hides personal data in it and keeps only that text in your vault for the days you choose. Password managers, private windows, password fields and the apps you exclude are never captured. You can pause, erase a moment or erase everything at any time.',
        'Start capturing',
      );
      if (!ok) return;
      if (probe && !probe.permitted) await invoke('recall_request_permission').catch(() => {});
    }
    r.setLocal({ capture: on, pausedUntil: null });
  };

  const eraseAll = async () => {
    const ok = await askConfirm('Erase the whole memory timeline?', 'Every captured moment is deleted from this vault, on every device once they sync. Your notes, recordings and settings are not touched. This cannot be undone.', 'Erase everything', true);
    if (!ok) return;
    await recallStore(vault).eraseAll();
    bumpRecall();
    useApp.getState().toast({ text: 'The memory timeline is erased.' });
  };

  const status = r.status;
  const statusText = status.kind === 'skipped' ? SKIP_REASON_TEXT[status.reason] : status.kind === 'capturing' ? (status.at ? `Capturing · last saved ${new Date(status.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Capturing') : status.kind === 'error' ? `Stopped: ${status.message}` : status.kind === 'unsupported' ? status.why : status.kind === 'needs-permission' ? 'Waiting for screen recording permission' : null;

  return (
    <>
      <Group
        title="Capture on this computer"
        note={isDesktop
          ? <>Only text is kept, never screenshots. It is recognised on this computer and redacted before it is saved: emails, phone numbers, card and bank numbers, ID numbers, addresses, names, keys and passwords become “[email]”, “[secret]” and so on. {probe && !probe.canDetectSecureInput && 'This system can’t tell Inkwright when a password field has focus, so exclude apps where you type secrets.'}</>
          : 'Capturing needs the Inkwright desktop app for macOS, Windows or Linux. Here you can browse and search moments captured on your computer, once they sync.'}
      >
        {isDesktop ? (
          <>
            <Switch label="Capture my screen" hint={probe?.wayland ? 'Not available in Wayland sessions: Wayland does not let apps see other windows.' : 'The window in front, every few seconds while you use the computer.'} checked={r.capture} onChange={(v) => void turnOn(v)} />
            {r.capture && statusText && <p className="rc-set-status" data-testid="recall-settings-status">{paused ? 'Paused' : statusText}</p>}
            {r.capture && probe && !probe.permitted && (
              <div className="field-row">
                <span className="row-label">macOS needs your permission to read the screen.</span>
                <button type="button" className="btn btn-sm" onClick={() => void invoke('recall_request_permission')}>Allow screen recording</button>
              </div>
            )}
            {r.capture && (
              <div className="row-buttons">
                <button type="button" className="btn btn-sm" onClick={() => togglePause()}>{paused ? 'Resume' : 'Pause for an hour'}</button>
              </div>
            )}
            <Switch label="Also transcribe the microphone" hint="Speech near this computer, transcribed on this device only (needs an on-device speech model). No audio is kept." checked={c.microphone} onChange={(v) => save({ microphone: v })} />
          </>
        ) : (
          <p className="rc-set-status">Capture is off on this device.</p>
        )}
      </Group>

      <Group title="Never capture" note="Password managers (1Password, Bitwarden, KeePass, Keychain and others), private and incognito windows, and Inkwright itself are always skipped. Matching ignores case and works on part of a name.">
        <ListEditor label="Apps" values={c.excludedApps} placeholder="e.g. Slack, Signal, Banking" onChange={(v) => save({ excludedApps: v })} />
        <ListEditor label="Windows whose title contains" values={c.excludedTitles} placeholder="e.g. Payroll, Medical" onChange={(v) => save({ excludedTitles: v })} />
      </Group>

      <Group title="Keep" note={usage ? `${usage.captures} ${usage.captures === 1 ? 'moment' : 'moments'} over ${usage.days} ${usage.days === 1 ? 'day' : 'days'} (${fmtBytes(usage.bytes)}) in recall/ in your vault.` : undefined}>
        <div className="field-row">
          <span className="row-label">Delete moments older than</span>
          <select aria-label="Delete moments older than" value={String(c.retentionDays)} onChange={(e) => save({ retentionDays: Number(e.target.value) })}>
            {[...new Set([...RETENTION_CHOICES, c.retentionDays])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d === 1 ? '1 day' : `${d} days`}</option>)}
          </select>
        </div>
        <div className="row-buttons">
          <button type="button" className="btn btn-sm" onClick={() => openTimeline()}><History size={15} aria-hidden /> Open the timeline</button>
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => void eraseAll()}><Trash2 size={15} aria-hidden /> Erase everything</button>
        </div>
      </Group>
    </>
  );
}
