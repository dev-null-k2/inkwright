/**
 * Pieces shared by the assistant's screens (Activity, Routines, Connected apps, Skills, Memory):
 * the view switch used by the AI panel and Settings, pending approvals, and the dialog for
 * questions from connected apps.
 */
import { useState, type ReactNode } from 'react';
import { BookOpen, Brain, History, Plug, Repeat } from 'lucide-react';
import { useAgent, type Elicitation } from '../../lib/agent/hub.ts';
import { Dialog, cx, relativeTime } from '../primitives.tsx';
import { ActivityView } from './ActivityView.tsx';
import { AppsView } from './AppsView.tsx';
import { MemoryView } from './MemoryView.tsx';
import { RoutinesView } from './RoutinesView.tsx';
import { SkillsView } from './SkillsView.tsx';

export type AgentViewId = 'activity' | 'routines' | 'apps' | 'skills' | 'memory';

export const AGENT_VIEWS: ReadonlyArray<{ id: AgentViewId; label: string; hint: string; icon: ReactNode }> = [
  { id: 'activity', label: 'Activity', hint: 'What the assistant changed, with undo', icon: <History size={16} /> },
  { id: 'routines', label: 'Routines', hint: 'Tasks it does on a schedule or when something happens', icon: <Repeat size={16} /> },
  { id: 'apps', label: 'Connected apps', hint: 'Notion, Linear and other MCP servers', icon: <Plug size={16} /> },
  { id: 'skills', label: 'Skills', hint: 'Instructions for specific tasks', icon: <BookOpen size={16} /> },
  { id: 'memory', label: 'Memory', hint: 'Standing instructions and what it knows about you', icon: <Brain size={16} /> },
];

export function AgentView({ view }: { view: AgentViewId }) {
  return (
    <div className="agent-view">
      {view === 'activity' && <ActivityView />}
      {view === 'routines' && <RoutinesView />}
      {view === 'apps' && <AppsView />}
      {view === 'skills' && <SkillsView />}
      {view === 'memory' && <MemoryView />}
    </div>
  );
}

/** A titled block inside an agent screen. */
export function Section({ title, children, note, action }: { title: string; children: ReactNode; note?: ReactNode; action?: ReactNode }) {
  return (
    <section className="ag-section">
      <div className="ag-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
      {note && <p className="ag-note">{note}</p>}
    </section>
  );
}

/** Approvals background runs are waiting for. */
export function ApprovalList() {
  const approvals = useAgent((s) => s.approvals);
  if (!approvals.length) return null;
  return (
    <div className="ag-approvals" role="region" aria-label="Waiting for your OK">
      {approvals.map((a) => (
        <div key={a.id} className="ag-approval">
          <div className="ag-approval-text">
            <strong>{a.title}</strong>
            <span className="muted small">{a.source} · {relativeTime(a.at)}</span>
            {a.detail && a.detail !== '{}' && <pre className="ag-args">{a.detail}</pre>}
          </div>
          <div className="ag-row-acts">
            <button type="button" className="btn btn-sm" onClick={() => a.resolve(false)}>Don’t allow</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => a.resolve(true)}>Allow</button>
          </div>
        </div>
      ))}
    </div>
  );
}

type Field = { type?: string; title?: string; description?: string; enum?: unknown[]; enumNames?: string[]; oneOf?: Array<{ const: unknown; title?: string }>; default?: unknown };

/** Questions from connected apps (MCP elicitation / task input), one at a time. */
export function AgentDialogs() {
  const req = useAgent((s) => s.elicitations[0]);
  return req ? <ElicitDialog key={req.id} req={req} /> : null;
}

function ElicitDialog({ req }: { req: Elicitation }) {
  const props = Object.entries(req.schema?.properties ?? {}) as Array<[string, Field]>;
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(props.map(([k, f]) => [k, f.default ?? (f.type === 'boolean' ? false : '')])));
  const required = new Set(req.schema?.required ?? []);
  const missing = props.some(([k, f]) => required.has(k) && f.type !== 'boolean' && (values[k] === '' || values[k] == null));
  const content = () => Object.fromEntries(props.map(([k, f]) => [k, f.type === 'number' || f.type === 'integer' ? Number(values[k]) : values[k]]).filter(([, v]) => v !== ''));
  return (
    <Dialog open title={`${req.server} asks`} onClose={() => req.resolve({ action: 'cancel' })} actions={<>
      <button type="button" className="btn" onClick={() => req.resolve({ action: 'decline' })}>Decline</button>
      <button type="button" className="btn btn-primary" disabled={missing} onClick={() => req.resolve({ action: 'accept', content: content() })}>{props.length ? 'Send' : 'Allow'}</button>
    </>}>
      <p>{req.message}</p>
      <div className="ag-form">
        {props.map(([k, f]) => {
          const label = f.title ?? k;
          const options = f.oneOf?.map((o) => ({ v: o.const, l: o.title ?? String(o.const) })) ?? f.enum?.map((v, i) => ({ v, l: f.enumNames?.[i] ?? String(v) }));
          if (f.type === 'boolean') return (
            <label key={k} className="check-row"><input type="checkbox" checked={!!values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.checked })} /> {label}</label>
          );
          return (
            <label key={k} className="field">
              <span className="field-label">{label}{required.has(k) ? '' : ' (optional)'}</span>
              {options ? (
                <select value={String(values[k] ?? '')} onChange={(e) => setValues({ ...values, [k]: options.find((o) => String(o.v) === e.target.value)?.v })}>
                  <option value="">Choose…</option>
                  {options.map((o) => <option key={String(o.v)} value={String(o.v)}>{o.l}</option>)}
                </select>
              ) : (
                <input type={f.type === 'number' || f.type === 'integer' ? 'number' : 'text'} value={String(values[k] ?? '')} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
              )}
              {f.description && <span className="muted small">{f.description}</span>}
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'busy' | 'warn' | 'off' | 'error' }) {
  return <span className={cx('ag-dot', `is-${tone}`)} aria-hidden />;
}
