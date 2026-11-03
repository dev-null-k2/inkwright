import { useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import type { ShellRunnerInfo } from '@inkwright/core';
import { deviceKey } from '../../authorship/keys.ts';
import { useModule } from '../../modules/registry.ts';
import { useApp } from '../../state/app.ts';
import { relativeTime } from '../../ui/primitives.tsx';
import { setupCommand, shellRunners } from './run.ts';

/**
 * Settings › Code & runbooks › Shell blocks: this device's fingerprint (what a computer must
 * trust), the exact command to set a computer up, and the computers that currently offer to run
 * shell blocks. Shown only while the "Runbook shell blocks" module is on.
 */
export function ShellSettings() {
  const on = useModule('runbook-shell');
  const vault = useApp((s) => s.vault);
  const toast = useApp((s) => s.toast);
  const [fp, setFp] = useState<string | null>(null);
  const [runners, setRunners] = useState<ShellRunnerInfo[] | null>(null);
  const load = () => {
    if (vault) void shellRunners(vault.fs).then(setRunners, () => setRunners([]));
  };
  useEffect(() => {
    if (!on) return;
    void deviceKey().then((k) => setFp(k.fingerprint), () => setFp(null));
    load();
  }, [on, vault]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on) return null;
  const cmd = fp ? setupCommand(fp) : '';
  const trusts = (r: ShellRunnerInfo) => !!fp && r.trusted.some((t) => t.replace(/\s/g, '').toUpperCase() === fp.replace(/\s/g, '').toUpperCase());
  return (
    <section className="set-group" aria-label="Shell blocks">
      <h2>Shell blocks</h2>
      <div className="set-card">
        <div className="field">
          <span className="field-label">This device’s fingerprint</span>
          <code className="shell-fp" data-testid="shell-fingerprint">{fp ?? '…'}</code>
        </div>
        {fp && (
          <div className="field">
            <span className="field-label">On a computer that has this vault</span>
            <div className="shell-cmd">
              <code>{cmd}</code>
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Copy the command" onClick={() => void navigator.clipboard?.writeText(cmd).then(() => toast({ text: 'Copied' }), () => {})}><Copy size={14} /></button>
            </div>
          </div>
        )}
        <div className="field">
          <span className="field-label">Computers</span>
          {runners === null ? <span className="muted small">Looking…</span> : !runners.length ? <span className="muted small">None online. Start the runner as above; it announces itself through sync.</span> : (
            <ul className="shell-runners">
              {runners.map((r) => (
                <li key={r.id}>
                  <strong>{r.label}</strong> <span className="muted small">· seen {relativeTime(r.heartbeatAt)} · {r.shells.join(', ')} · in {r.allow.join(', ')}</span>
                  <div className="small">{trusts(r) ? 'Runs blocks you approve on this device.' : 'Doesn’t trust this device yet: add --shell-trust with the fingerprint above.'}</div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-sm" onClick={load}><RefreshCw size={14} /> Check again</button>
        </div>
      </div>
      <p className="set-note">Shell blocks never run on this device. Press Run on a ```sh block, check the command, and the computer runs it once with your account there, only inside the folders it allows, stopped after its time limit. The approval is signed by this device and works for 5 minutes. Every run is in Activity and in the computer’s signed audit trail.</p>
    </section>
  );
}
