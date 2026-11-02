/**
 * Routines: background agents with a prompt, the AI to use, the tools allowed and triggers.
 * The copy is explicit that routines only run while Inkwright is open (and catch up once on open).
 */
import { useEffect, useState } from 'react';
import { Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react';
import {
  DAY_NAMES,
  ROUTINE_TEMPLATES,
  describeTrigger,
  newRoutine,
  nextSlot,
  routineLeaseHeldByOther,
  validateRoutine,
  type Routine,
  type RoutineTrigger,
} from '@inkwright/ai';
import { requireHub, useAgent } from '../../lib/agent/hub.ts';
import { useMcp } from '../../lib/agent/mcp.ts';
import { cancelRoutine, runRoutineNow } from '../../lib/agent/routines.ts';
import { useApp } from '../../state/app.ts';
import { useSettings } from '../../state/settings.ts';
import { IconButton, Segmented, Switch, relativeTime } from '../primitives.tsx';
import { askConfirm } from '../prompts.tsx';
import { Section, StatusDot } from './shared.tsx';

export function RoutinesView() {
  const routines = useAgent((s) => s.routines);
  const running = useAgent((s) => s.runningRoutine);
  const queued = useAgent((s) => s.queuedRoutines);
  const runner = useAgent((s) => s.routinesRunner);
  const [editing, setEditing] = useState<Routine | null>(null);
  // Check now (the scheduler only looks once a minute) so the screen says who runs routines.
  useEffect(() => {
    void routineLeaseHeldByOther(requireHub().vault.fs, Date.now()).then((l) => useAgent.setState({ routinesRunner: l ? l.label : null }), () => {});
  }, []);
  if (editing) return <RoutineEditor initial={editing} onDone={() => setEditing(null)} />;
  return (
    <div className="ag-screen">
      <p className="ag-lead">Routines are tasks the assistant does for you on a schedule or when something happens. They run while Inkwright is open; if it was closed at the scheduled time, the routine runs once the next time you open Inkwright.</p>
      {runner && <p className="ag-lead" data-testid="routines-runner">{runner} is running your routines, even when Inkwright is closed. Its changes show up in Activity.</p>}
      <Section title="Your routines" action={<button type="button" className="btn btn-sm" onClick={() => setEditing(newRoutine({ name: '', prompt: '', triggers: [{ kind: 'daily', time: '18:00' }] }))}><Plus size={14} /> New routine</button>}>
        {!routines.length && <p className="ag-empty">No routines yet. Start from one below or write your own.</p>}
        <ul className="ag-list">
          {routines.map((r) => <RoutineRow key={r.id} r={r} running={running === r.id} queued={queued.includes(r.id)} onEdit={() => setEditing(r)} />)}
        </ul>
      </Section>
      <Section title="Start from a template">
        <ul className="ag-list">
          {ROUTINE_TEMPLATES.map((t) => (
            <li key={t.id} className="ag-item">
              <div className="ag-item-main">
                <span className="ag-item-title">{t.name}</span>
                <span className="muted small">{t.blurb}</span>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(t.build())}>Use</button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function RoutineRow({ r, running, queued, onEdit }: { r: Routine; running: boolean; queued: boolean; onEdit: () => void }) {
  const toast = useApp((s) => s.toast);
  const save = (patch: Partial<Routine>) => void requireHub().routines.save({ ...r, ...patch, updatedAt: Date.now() });
  const next = r.enabled ? r.triggers.map((t) => nextSlot(t, Date.now())).filter((x): x is number => x != null).sort()[0] : undefined;
  const status = running ? 'Running now…' : queued ? 'Waiting to run' : r.state.lastRunAt ? `${r.state.lastStatus === 'error' ? 'Failed' : r.state.lastStatus === 'cancelled' ? 'Stopped' : 'Ran'} ${relativeTime(r.state.lastRunAt)}` : 'Hasn’t run yet';
  return (
    <li className="ag-item ag-routine">
      <div className="ag-item-main">
        <span className="ag-item-title"><StatusDot tone={running ? 'busy' : r.state.lastStatus === 'error' ? 'error' : r.enabled ? 'ok' : 'off'} /> {r.name}</span>
        <span className="muted small">{r.triggers.length ? r.triggers.map(describeTrigger).join(' · ') : 'Only when you run it'}</span>
        <span className="muted small">{status}{next ? ` · next ${new Date(next).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</span>
        {r.state.lastStatus === 'error' && r.state.lastError && <span className="ag-run-error small">{r.state.lastError}</span>}
      </div>
      <div className="ag-row-acts">
        {running ? (
          <IconButton label={`Stop ${r.name}`} onClick={() => cancelRoutine(r.id)}><Square size={15} /></IconButton>
        ) : (
          <IconButton label={`Run ${r.name} now`} onClick={() => void runRoutineNow(r.id).catch((e) => toast({ text: (e as Error).message, tone: 'error' }))}><Play size={16} /></IconButton>
        )}
        <IconButton label={`Edit ${r.name}`} onClick={onEdit}><Pencil size={15} /></IconButton>
        <label className="ag-switch" title={r.enabled ? 'On' : 'Off'}>
          <input type="checkbox" role="switch" aria-label={`${r.name} on`} checked={r.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          <span className="switch" aria-hidden />
        </label>
      </div>
    </li>
  );
}

const TRIGGER_KINDS: Array<{ kind: RoutineTrigger['kind']; label: string; make: () => RoutineTrigger }> = [
  { kind: 'daily', label: 'Every day', make: () => ({ kind: 'daily', time: '18:00' }) },
  { kind: 'weekly', label: 'Every week', make: () => ({ kind: 'weekly', day: 1, time: '08:00' }) },
  { kind: 'note-saved', label: 'When a tagged note is saved', make: () => ({ kind: 'note-saved', tag: '' }) },
  { kind: 'recording-ended', label: 'When a recording ends', make: () => ({ kind: 'recording-ended' }) },
  { kind: 'before-date', label: 'Days before a date in a note', make: () => ({ kind: 'before-date', days: 3, keyword: 'exam' }) },
];

function RoutineEditor({ initial, onDone }: { initial: Routine; onDone: () => void }) {
  const [r, setR] = useState<Routine>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const providers = useSettings((s) => s.ai.providers);
  const servers = useMcp((s) => s.servers);
  const toast = useApp((s) => s.toast);
  const isNew = !useAgent.getState().routines.some((x) => x.id === r.id);
  const set = (p: Partial<Routine>) => setR((x) => ({ ...x, ...p }));
  const setTrigger = (i: number, t: RoutineTrigger) => set({ triggers: r.triggers.map((x, k) => (k === i ? t : x)) });
  const save = async () => {
    const errs = validateRoutine(r);
    setErrors(errs);
    if (errs.length) return;
    await requireHub().routines.save({ ...r, name: r.name.trim(), prompt: r.prompt.trim(), updatedAt: Date.now() });
    toast({ text: isNew ? `Added “${r.name.trim()}”` : 'Routine saved', tone: 'success' });
    onDone();
  };
  const remove = async () => {
    if (!(await askConfirm(`Delete “${r.name}”?`, 'Its past runs stay in Activity.', 'Delete', true))) return;
    await requireHub().routines.remove(r.id);
    onDone();
  };
  return (
    <div className="ag-screen ag-editor">
      <label className="field">
        <span className="field-label">Name</span>
        <input value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="File my notes" />
      </label>
      <label className="field">
        <span className="field-label">What should it do?</span>
        <textarea className="ag-textarea" rows={7} value={r.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="Every evening, look at notes I edited today and…" />
      </label>
      <Section title="When it runs" note="It also runs whenever you press Run.">
        {r.triggers.map((t, i) => (
          <div key={i} className="ag-trigger">
            <TriggerFields t={t} onChange={(nt) => setTrigger(i, nt)} />
            <IconButton label="Remove this trigger" onClick={() => set({ triggers: r.triggers.filter((_, k) => k !== i) })}><X size={15} /></IconButton>
          </div>
        ))}
        <select className="ag-add-trigger" value="" aria-label="Add a trigger" onChange={(e) => { const k = TRIGGER_KINDS.find((x) => x.kind === e.target.value); if (k) set({ triggers: [...r.triggers, k.make()] }); }}>
          <option value="">Add a trigger…</option>
          {TRIGGER_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      </Section>
      <Section title="What it can use">
        <label className="field-row">
          <span className="row-label">AI</span>
          <select value={r.ai ?? ''} onChange={(e) => set({ ai: e.target.value || null })}>
            <option value="">The AI chosen in Settings</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.model}</option>)}
          </select>
        </label>
        <div className="field-row">
          <span className="row-label">Notes</span>
          <Segmented label="Notes access" value={r.tools.notes} onChange={(v) => set({ tools: { ...r.tools, notes: v } })} options={[{ value: 'read', label: 'Read only' }, { value: 'write', label: 'Read and change' }]} />
        </div>
        <Switch label="Skills" hint="Built-in and imported skills" checked={r.tools.skills} onChange={(v) => set({ tools: { ...r.tools, skills: v } })} />
        {servers.length > 0 && (
          <div className="ag-apps-pick">
            <span className="row-label">Connected apps</span>
            {servers.map((s) => (
              <label key={s.id} className="check-row">
                <input type="checkbox" checked={r.tools.mcpServers.includes(s.id)} onChange={(e) => set({ tools: { ...r.tools, mcpServers: e.target.checked ? [...r.tools.mcpServers, s.id] : r.tools.mcpServers.filter((x) => x !== s.id) } })} />
                {s.name}
              </label>
            ))}
            <span className="muted small">A routine always asks you before it changes anything in a connected app.</span>
          </div>
        )}
      </Section>
      {errors.length > 0 && <ul className="ag-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="row-end">
        {!isNew && <button type="button" className="btn btn-danger-ghost" onClick={() => void remove()}><Trash2 size={15} /> Delete</button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => void save()}>{isNew ? 'Add routine' : 'Save'}</button>
      </div>
    </div>
  );
}

function TriggerFields({ t, onChange }: { t: RoutineTrigger; onChange: (t: RoutineTrigger) => void }) {
  switch (t.kind) {
    case 'daily':
      return <span className="ag-trigger-fields">Every day at <input type="time" aria-label="Time" value={t.time} onChange={(e) => onChange({ ...t, time: e.target.value })} /></span>;
    case 'weekly':
      return (
        <span className="ag-trigger-fields">Every{' '}
          <select aria-label="Day" value={t.day} onChange={(e) => onChange({ ...t, day: Number(e.target.value) })}>{DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
          {' '}at <input type="time" aria-label="Time" value={t.time} onChange={(e) => onChange({ ...t, time: e.target.value })} />
        </span>
      );
    case 'note-saved':
      return <span className="ag-trigger-fields">When a note tagged # <input aria-label="Tag" value={t.tag} placeholder="email" onChange={(e) => onChange({ ...t, tag: e.target.value.replace(/^#/, '').trim().toLowerCase() })} /> is saved</span>;
    case 'recording-ended':
      return <span className="ag-trigger-fields">When a recording ends</span>;
    case 'before-date':
      return (
        <span className="ag-trigger-fields">
          <input type="number" aria-label="Days before" min={0} max={60} value={t.days} onChange={(e) => onChange({ ...t, days: Number(e.target.value) })} className="ag-num" /> days before a date written next to “<input aria-label="Word to look for" value={t.keyword} onChange={(e) => onChange({ ...t, keyword: e.target.value })} className="ag-kw" />” in a note
        </span>
      );
  }
}
