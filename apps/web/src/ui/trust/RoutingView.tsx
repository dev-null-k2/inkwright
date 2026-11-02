/**
 * Settings › Privacy & trust › Routing & privacy: a form over the AI policy file (`ai/policy.json`). Every
 * control writes the file straight away (it is small, and syncs like a note), so what the form
 * shows is always what the gateway enforces. Fields an administrator's managed policy decides
 * are shown with the stricter value and a note; users can tighten them but not loosen them.
 */
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  PII_KINDS,
  PII_LABELS,
  TASK_KINDS,
  TASK_LABELS,
  describeRetention,
  getProviderInfo,
  isLoopbackUrl,
  type AIPolicy,
  type NotebookAccess,
  type PrivacyAction,
  type RouteTarget,
  type ScopeRule,
  type WriteMode,
} from '@inkwright/ai';
import { useApp } from '../../state/app.ts';
import { useSettings } from '../../state/settings.ts';
import { CLAUDE_BUILTIN_ID, hasBuiltinClaude } from '../../lib/ai.ts';
import { savePolicy, useTrust } from '../../lib/trust/state.ts';
import { IconButton, Segmented, Switch } from '../primitives.tsx';
import { Section } from '../agent/shared.tsx';

const ACCESS_OPTIONS: { value: NotebookAccess; label: string }[] = [
  { value: 'read-write', label: 'Read & change' },
  { value: 'read', label: 'Read only' },
  { value: 'none', label: 'Hidden' },
];

const ACTION_LABEL: Record<PrivacyAction, string> = { redact: 'Hide from cloud AI', block: 'Don’t send at all', allow: 'Send as written' };

/** Changes are applied one after another to the latest saved file, so quick edits never overwrite each other. */
let saving: Promise<void> = Promise.resolve();

function usePolicyEditor() {
  const policy = useTrust((s) => s.userPolicy);
  const toast = useApp((s) => s.toast);
  const update = (summary: string, change: (p: AIPolicy) => void) => {
    saving = saving.then(async () => {
      const next = structuredClone(useTrust.getState().userPolicy) as AIPolicy;
      change(next);
      await savePolicy(next, summary);
    }).catch((e) => toast({ text: (e as Error).message, tone: 'error' }));
  };
  return { policy, update };
}

export function RoutingView() {
  const { policy, update } = usePolicyEditor();
  const errors = useTrust((s) => s.errors);
  const managed = useTrust((s) => s.managed);
  const effective = useTrust((s) => s.policy);
  return (
    <div className="ag-screen trust-routing">
      <p className="ag-lead">Decide where each kind of AI work runs, what the assistant may see and change, what never leaves this device, and how much each provider may cost. These rules live in <code>ai/policy.json</code> in your notes, so they apply on every device and to every agent.</p>
      {managed && <p className="trust-managed">Your organisation manages some of these rules. You can make them stricter; where theirs is stricter, theirs applies.</p>}
      {errors.length > 0 && (
        <div className="trust-errors" role="alert">
          <strong>Some lines in ai/policy.json couldn’t be used</strong>
          <ul>{errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>
          <span className="muted small">Those settings use their safe defaults until the file is fixed.</span>
        </div>
      )}
      <RoutesSection policy={policy} effective={effective} update={update} />
      <ScopesSection policy={policy} update={update} />
      <PrivacySection policy={policy} update={update} />
      <BudgetsSection policy={policy} update={update} />
      <AgentSection policy={policy} update={update} />
      <RetentionSection policy={policy} effective={effective} update={update} />
      <PricesSection policy={policy} update={update} />
    </div>
  );
}

type Editor = ReturnType<typeof usePolicyEditor>;
type Props = Pick<Editor, 'policy' | 'update'> & { effective?: AIPolicy };

function providerOptions(): { value: RouteTarget; label: string }[] {
  const s = useSettings.getState().ai;
  const out: { value: RouteTarget; label: string }[] = [
    { value: 'auto', label: 'My usual AI' },
    { value: 'device', label: 'This device only' },
  ];
  if (hasBuiltinClaude()) out.push({ value: `provider:${CLAUDE_BUILTIN_ID}`, label: 'Claude (built in)' });
  for (const p of s.providers) out.push({ value: `provider:${p.id}`, label: `${getProviderInfo(p.providerId)?.label ?? p.label} · ${p.model}` });
  out.push({ value: 'off', label: 'No AI' });
  return out;
}

function RoutesSection({ policy, effective, update }: Props) {
  const options = useMemo(providerOptions, []);
  return (
    <Section title="Where AI runs" note="“This device only” uses a model on this device (Settings › AI › On this device) or a server on this computer such as Ollama. Notes marked “stays on this device” below override these choices.">
      <div className="set-card">
        {TASK_KINDS.map((k) => {
          const v = policy.routes[k];
          const known = options.some((o) => o.value === v);
          return (
            <label key={k} className="field-row">
              <span className="row-text"><span className="row-label">{TASK_LABELS[k].label}</span><span className="row-hint">{TASK_LABELS[k].hint}</span></span>
              <select aria-label={`Where ${TASK_LABELS[k].label.toLowerCase()} runs`} value={v} onChange={(e) => update(`${TASK_LABELS[k].label} → ${e.target.selectedOptions[0]?.text}`, (p) => { p.routes[k] = e.target.value as RouteTarget; })}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                {!known && <option value={v}>{v} (not set up here)</option>}
              </select>
              {effective && effective.routes[k] !== v && <span className="row-hint trust-forced">Your organisation’s rule applies: {options.find((o) => o.value === effective.routes[k])?.label ?? effective.routes[k]}</span>}
            </label>
          );
        })}
      </div>
    </Section>
  );
}

function RuleControls({ rule, onChange, name }: { rule: ScopeRule; onChange: (r: ScopeRule) => void; name: string }) {
  return (
    <div className="trust-rule-controls">
      <Segmented label={`What the assistant may do with ${name}`} value={rule.access ?? 'read-write'} options={ACCESS_OPTIONS} onChange={(access) => onChange({ ...rule, access })} />
      <label className="check-row"><input type="checkbox" checked={!!rule.localOnly} onChange={(e) => onChange({ ...rule, localOnly: e.target.checked })} /> Stays on this device</label>
    </div>
  );
}

function ScopesSection({ policy, update }: Props) {
  const notebooks = useApp((s) => s.notebooks);
  const [tag, setTag] = useState('');
  const unused = notebooks.filter((b) => !policy.notebooks[b.id]);
  const nbName = (id: string) => notebooks.find((b) => b.id === id)?.name ?? 'A notebook that no longer exists';
  return (
    <Section title="Notebooks and tags" note="Hidden notes don’t exist for the assistant, routines, connected agents or the MCP server. Read-only notes can be read but not changed. “Stays on this device” sends their content only to a model on this device; listed elsewhere they appear without title or text.">
      <ul className="ag-list">
        {Object.entries(policy.notebooks).map(([id, rule]) => (
          <li key={id} className="ag-item trust-rule">
            <div className="ag-item-main"><span className="ag-item-title">{nbName(id)}</span><span className="muted small">Notebook, and the notebooks inside it</span></div>
            <RuleControls name={nbName(id)} rule={rule} onChange={(r) => update(`Notebook “${nbName(id)}”: ${r.access ?? 'read-write'}${r.localOnly ? ', stays on this device' : ''}`, (p) => { p.notebooks[id] = r; })} />
            <IconButton label={`Remove the rule for ${nbName(id)}`} onClick={() => update(`Removed the rule for notebook “${nbName(id)}”`, (p) => { delete p.notebooks[id]; })}><Trash2 size={15} /></IconButton>
          </li>
        ))}
        {Object.entries(policy.tags).map(([t, rule]) => (
          <li key={`#${t}`} className="ag-item trust-rule">
            <div className="ag-item-main"><span className="ag-item-title">#{t}</span><span className="muted small">Notes with this tag</span></div>
            <RuleControls name={`#${t}`} rule={rule} onChange={(r) => update(`Tag #${t}: ${r.access ?? 'read-write'}${r.localOnly ? ', stays on this device' : ''}`, (p) => { p.tags[t] = r; })} />
            <IconButton label={`Remove the rule for #${t}`} onClick={() => update(`Removed the rule for #${t}`, (p) => { delete p.tags[t]; })}><Trash2 size={15} /></IconButton>
          </li>
        ))}
      </ul>
      <div className="trust-add-row">
        <select aria-label="Add a rule for a notebook" value="" onChange={(e) => { const id = e.target.value; if (id) update(`Notebook “${nbName(id)}” stays on this device`, (p) => { p.notebooks[id] = { localOnly: true }; }); }}>
          <option value="">Add a notebook…</option>
          {unused.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <form className="trust-tag-form" onSubmit={(e) => { e.preventDefault(); const t = tag.trim().replace(/^#/, '').toLowerCase(); if (t) { update(`Tag #${t} stays on this device`, (p) => { p.tags[t] = { localOnly: true }; }); setTag(''); } }}>
          <input aria-label="Tag" placeholder="#tag" value={tag} onChange={(e) => setTag(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={!tag.trim()}><Plus size={14} /> Add tag</button>
        </form>
      </div>
    </Section>
  );
}

function PrivacySection({ policy, update }: Props) {
  const on = policy.privacy.mode === 'redact';
  return (
    <Section title="Personal data" note="Hidden values are replaced by placeholders such as ⟦EMAIL_1⟧ before a request leaves this device and put back in the answer here, so replies still read normally. Text inside images can’t be checked; route handwriting reading to this device if that matters.">
      <div className="set-card">
        <Switch label="Check what goes to cloud AI" hint="Models on this device always see everything" checked={on} onChange={(v) => update(v ? 'Personal-data checks on' : 'Personal-data checks off', (p) => { p.privacy.mode = v ? 'redact' : 'off'; })} />
        {on && PII_KINDS.map((k) => (
          <label key={k} className="field-row">
            <span className="row-label">{PII_LABELS[k]}</span>
            <select aria-label={PII_LABELS[k]} value={policy.privacy.kinds[k] ?? 'allow'} onChange={(e) => update(`${PII_LABELS[k]}: ${ACTION_LABEL[e.target.value as PrivacyAction].toLowerCase()}`, (p) => { p.privacy.kinds[k] = e.target.value as PrivacyAction; })}>
              {(Object.keys(ACTION_LABEL) as PrivacyAction[]).map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
            </select>
          </label>
        ))}
      </div>
    </Section>
  );
}

function BudgetsSection({ policy, update }: Props) {
  const providers = useSettings((s) => s.ai.providers).filter((p) => p.id !== CLAUDE_BUILTIN_ID && !isLoopbackUrl(p.baseUrl?.trim() || getProviderInfo(p.providerId)?.defaultBaseUrl));
  if (!providers.length) return null;
  return (
    <Section title="Monthly budgets" note="Spending is counted from list prices (below) across all your devices. When a provider reaches its budget, its calls stop or move to this device.">
      <div className="set-card">
        {providers.map((p) => {
          const b = policy.budgets[p.id];
          const name = `${getProviderInfo(p.providerId)?.label ?? p.label} · ${p.model}`;
          return (
            <div key={p.id} className="field-row trust-budget">
              <span className="row-label">{name}</span>
              <span className="trust-budget-controls">
                <span className="trust-usd">$<input type="number" min={0} step={1} inputMode="decimal" aria-label={`Monthly budget for ${name} in US dollars`} placeholder="No limit" value={b ? String(b.monthlyUsd) : ''} onChange={(e) => {
                  const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
                  update(v == null ? `No budget for ${name}` : `Budget for ${name}: $${v}/month`, (x) => { if (v == null || !Number.isFinite(v)) delete x.budgets[p.id]; else x.budgets[p.id] = { monthlyUsd: v, onExceed: b?.onExceed ?? 'block' }; });
                }} /></span>
                {b && (
                  <select aria-label={`When ${name} reaches its budget`} value={b.onExceed} onChange={(e) => update(`${name} over budget → ${e.target.value}`, (x) => { x.budgets[p.id] = { ...b, onExceed: e.target.value as 'device' | 'block' }; })}>
                    <option value="block">then stop</option>
                    <option value="device">then use this device</option>
                  </select>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const WRITE_SOURCES = [
  { key: 'assistant', label: 'The assistant' },
  { key: 'routine', label: 'Routines' },
  { key: 'external', label: 'Outside agents (MCP, A2A)' },
] as const;

function AgentSection({ policy, update }: Props) {
  const [deny, setDeny] = useState(policy.tools.deny.join(', '));
  return (
    <Section title="Changes and safety" note="With “Propose”, changes wait in Activity with a before-and-after view until you approve them.">
      <div className="set-card">
        {WRITE_SOURCES.map((s) => (
          <div key={s.key} className="field-row">
            <span className="row-label">{s.label}</span>
            <Segmented<WriteMode> label={`How ${s.label.toLowerCase()} change notes`} value={policy.agentWrites[s.key]} options={[{ value: 'apply', label: 'Change notes' }, { value: 'propose', label: 'Propose' }]} onChange={(v) => update(`${s.label}: ${v === 'apply' ? 'change notes directly' : 'propose changes'}`, (p) => { p.agentWrites[s.key] = v; })} />
          </div>
        ))}
        <Switch label="Mark notes and web content as untrusted" hint="The model is told that text from notes, pages and apps is data, never instructions" checked={policy.injection.spotlight} onChange={(v) => update(v ? 'Spotlighting on' : 'Spotlighting off', (p) => { p.injection.spotlight = v; })} />
        <Switch label="Ask before changes after suspicious content" hint="If something the assistant read looks like planted instructions, every change waits for your OK" checked={policy.injection.confirmWritesAfterSuspicious} onChange={(v) => update(v ? 'Confirm after suspicious content on' : 'Confirm after suspicious content off', (p) => { p.injection.confirmWritesAfterSuspicious = v; })} />
        <Switch label="Ask before every change after reading" hint="Stricter: once the assistant has read a note, page or app result, each change waits for your OK" checked={!!policy.injection.confirmWritesAfterAnyRead} onChange={(v) => update(v ? 'Confirm every change after reading on' : 'Confirm every change after reading off', (p) => { p.injection.confirmWritesAfterAnyRead = v; })} />
        <Switch label="Shorten long context" hint="Long tool results and passages are trimmed; the model can ask for the full text" checked={policy.compression.enabled} onChange={(v) => update(v ? 'Context shortening on' : 'Context shortening off', (p) => { p.compression.enabled = v; })} />
        <label className="field">
          <span className="field-label">Tools agents may never use</span>
          <input value={deny} placeholder="e.g. notion__delete_page, *__send_email" onChange={(e) => setDeny(e.target.value)} onBlur={() => update('Changed the blocked tools', (p) => { p.tools.deny = deny.split(',').map((x) => x.trim()).filter(Boolean); })} />
          <span className="muted small">Names as shown in Connected apps; * matches anything.</span>
        </label>
      </div>
    </Section>
  );
}

function RetentionSection({ policy, effective, update }: Props) {
  const r = policy.retention;
  const field = (key: 'activityDays' | 'auditDays' | 'historyDays', label: string) => (
    <label className="field-row">
      <span className="row-label">{label}</span>
      <span className="trust-days"><input type="number" min={0} step={1} aria-label={`${label}, days (0 keeps the default)`} value={r[key]} onChange={(e) => { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); update(`${label}: ${v ? `${v} days` : 'default'}`, (p) => { p.retention[key] = v; }); }} /> days</span>
    </label>
  );
  return (
    <Section title="Keeping records" note={describeRetention(effective ?? policy)}>
      <div className="set-card">
        {field('activityDays', 'AI activity')}
        {field('auditDays', 'Audit trail')}
        {field('historyDays', 'Version history')}
        <Switch label="Legal hold" hint="Nothing is deleted automatically while this is on" checked={r.legalHold} onChange={(v) => update(v ? 'Legal hold on' : 'Legal hold off', (p) => { p.retention.legalHold = v; })} />
      </div>
    </Section>
  );
}

function PricesSection({ policy, update }: Props) {
  const [row, setRow] = useState({ model: '', input: '', output: '' });
  const entries = Object.entries(policy.prices);
  return (
    <Section title="Prices" note="Built-in list prices cover the common models. Add a line for any model you pay differently for (USD per million tokens; * matches anything).">
      {entries.length > 0 && (
        <ul className="ag-list">
          {entries.map(([m, p]) => (
            <li key={m} className="ag-item">
              <span className="ag-item-main"><span className="ag-item-title">{m}</span><span className="muted small">${p.input} in · ${p.output} out</span></span>
              <IconButton label={`Remove the price for ${m}`} onClick={() => update(`Removed the price for ${m}`, (x) => { delete x.prices[m]; })}><Trash2 size={15} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <form className="trust-price-form" onSubmit={(e) => {
        e.preventDefault();
        const input = Number(row.input);
        const output = Number(row.output);
        if (!row.model.trim() || !(input >= 0) || !(output >= 0)) return;
        update(`Price for ${row.model.trim()}`, (x) => { x.prices[row.model.trim()] = { input, output }; });
        setRow({ model: '', input: '', output: '' });
      }}>
        <input aria-label="Model" placeholder="model, e.g. my-model-*" value={row.model} onChange={(e) => setRow({ ...row, model: e.target.value })} />
        <input aria-label="Input price" type="number" min={0} step="any" placeholder="in $" value={row.input} onChange={(e) => setRow({ ...row, input: e.target.value })} />
        <input aria-label="Output price" type="number" min={0} step="any" placeholder="out $" value={row.output} onChange={(e) => setRow({ ...row, output: e.target.value })} />
        <button type="submit" className="btn btn-sm" disabled={!row.model.trim() || row.input === '' || row.output === ''}><Plus size={14} /> Add</button>
      </form>
    </Section>
  );
}
