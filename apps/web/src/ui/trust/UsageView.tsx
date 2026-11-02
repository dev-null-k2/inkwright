/**
 * Settings › AI › AI usage: what AI cost this month, per provider and per day, across all devices
 * (`ai/usage/…`), with what the context budgeter saved and what the privacy firewall kept back.
 * Savings are estimates (the tokens the same requests would have sent unshortened); the page
 * says so and points to the benchmark, which also lists where shortening doesn't help.
 */
import { useEffect, useMemo, useState } from 'react';
import { totalsOf, type UsageRow } from '@inkwright/ai';
import { trustServices, useTrust } from '../../lib/trust/state.ts';
import { Segmented } from '../primitives.tsx';
import { Section } from '../agent/shared.tsx';

const pad = (n: number) => String(n).padStart(2, '0');
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const usd = (v: number) => (v === 0 ? '$0' : v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function UsageView() {
  const version = useTrust((s) => s.version);
  const [which, setWhich] = useState<'this' | 'last'>('this');
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const month = useMemo(() => {
    const d = new Date();
    if (which === 'last') d.setMonth(d.getMonth() - 1, 1);
    return monthKey(d);
  }, [which]);
  useEffect(() => {
    const s = trustServices();
    if (!s) return;
    let live = true;
    void s.usage.flush().then(() => s.usage.month(month)).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [month, version]);

  const t = totalsOf(rows ?? []);
  const saved = Math.max(0, t.uncompressedInputTokens - t.inputTokens);
  const byProvider = new Map<string, UsageRow[]>();
  for (const r of rows ?? []) byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r]);
  const days = [...new Set((rows ?? []).map((r) => r.day))].sort();
  const perDay = days.map((d) => ({ day: d, ...totalsOf((rows ?? []).filter((r) => r.day === d)) }));
  const peak = Math.max(1, ...perDay.map((d) => d.inputTokens + d.outputTokens));

  return (
    <div className="ag-screen trust-usage">
      <p className="ag-lead">What AI cost, across all your devices. Work on this device is free and never leaves it.</p>
      <Segmented label="Month" value={which} options={[{ value: 'this', label: 'This month' }, { value: 'last', label: 'Last month' }]} onChange={setWhich} />
      {rows && !rows.length && <p className="ag-empty">No AI use recorded for this month yet.</p>}
      {rows && rows.length > 0 && (
        <>
          <dl className="trust-stats">
            <div><dt>Spent</dt><dd>{usd(t.costUsd)}{t.costUnknown ? '+' : ''}</dd></div>
            <div><dt>Saved by shortening</dt><dd>{usd(t.savedUsd)}<span className="muted small"> · {tokens(saved)} tokens</span></dd></div>
            <div><dt>Requests</dt><dd>{t.calls}</dd></div>
            <div><dt>Kept private</dt><dd>{t.redactions}<span className="muted small"> values</span></dd></div>
          </dl>
          {t.costUnknown && <p className="ag-note">Some models have no known price, so “Spent” leaves them out. Add their prices under Routing & privacy.</p>}
          {t.blocked > 0 && <p className="ag-note">{t.blocked} {t.blocked === 1 ? 'request was' : 'requests were'} stopped by your AI policy.</p>}
          <Section title="By provider">
            <ul className="ag-list">
              {[...byProvider.entries()].map(([key, list]) => {
                const pt = totalsOf(list);
                return (
                  <li key={key} className="ag-item">
                    <span className="ag-item-main">
                      <span className="ag-item-title">{list[list.length - 1]!.label}</span>
                      <span className="muted small">{pt.calls} requests · {tokens(pt.inputTokens)} in · {tokens(pt.outputTokens)} out{pt.uncompressedInputTokens > pt.inputTokens ? ` · ${tokens(pt.uncompressedInputTokens - pt.inputTokens)} saved` : ''}</span>
                    </span>
                    <span className="trust-cost">{list[0]!.local ? 'On this device' : `${usd(pt.costUsd)}${pt.costUnknown ? '+' : ''}`}</span>
                  </li>
                );
              })}
            </ul>
          </Section>
          <Section title="By day" note="Bars show tokens; the darker part is what was sent, the lighter part what shortening saved.">
            <div className="trust-days-chart" role="img" aria-label={`Tokens per day for ${days.length} days`}>
              {perDay.map((d) => (
                <div key={d.day} className="trust-day" title={`${d.day}: ${tokens(d.inputTokens + d.outputTokens)} tokens, ${usd(d.costUsd)}`}>
                  <span className="trust-day-saved" style={{ height: `${(100 * Math.max(0, d.uncompressedInputTokens - d.inputTokens)) / peak}%` }} />
                  <span className="trust-day-used" style={{ height: `${(100 * (d.inputTokens + d.outputTokens)) / peak}%` }} />
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
      <p className="ag-note">Costs use list prices, and savings are estimated at about four characters per token, so treat them as close, not exact. The benchmark in docs/TRUST.md shows where shortening helps and where it doesn’t.</p>
    </div>
  );
}
