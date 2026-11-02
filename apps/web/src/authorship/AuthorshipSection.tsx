import { useEffect, useState } from 'react';
import { FileUp } from 'lucide-react';
import { ZERO_COUNTS, addCounts, classifyPage, pageFromEvidence, verifyCertificate, writingRhythm, type AuthorshipCertificate, type InkStroke, type VerifyReport } from '@inkstone/core';
import { pickFiles } from '../platform/files.ts';
import { useSettings } from '../state/settings.ts';
import { Switch, cx } from '../ui/primitives.tsx';
import { certificateFromFile } from './certificate.ts';
import { deviceKey } from './keys.ts';
import { CountsList, HonestNote, RhythmList, SignedInkPreview, StatusBlock } from './AuthorshipPanel.tsx';

/**
 * Settings › Authorship: this device's signing key (fingerprint to share, optional name), the
 * PDF option, and the verify screen — drop or pick an exported PDF or a certificate JSON and it
 * is checked offline.
 */
export function AuthorshipSection() {
  const s = useSettings();
  const set = (p: Partial<typeof s.authorship>) => s.update((x) => ({ authorship: { ...x.authorship, ...p } }));
  const [fp, setFp] = useState<{ fingerprint: string; persistent: boolean; createdAt: number } | null>(null);
  useEffect(() => { void deviceKey().then((k) => setFp({ fingerprint: k.fingerprint, persistent: k.persistent, createdAt: k.createdAt })).catch(() => undefined); }, []);
  return (
    <>
      <section className="set-group">
        <h2>This device</h2>
        <div className="set-card">
          <dl className="auth-grid">
            <dt>Key fingerprint</dt>
            <dd className="auth-fp" data-testid="device-fingerprint">{fp?.fingerprint ?? '…'}</dd>
            {fp && <><dt>Created</dt><dd>{new Date(fp.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}{fp.persistent ? '' : ' (this session only)'}</dd></>}
          </dl>
          <label className="field-row">
            <span className="row-label">Name in certificates</span>
            <input type="text" value={s.authorship.deviceName} placeholder="Optional, e.g. your name" maxLength={80} onChange={(e) => set({ deviceName: e.target.value })} />
          </label>
          <Switch label="Attach a signed certificate to exported PDFs" hint="Readers can check it in Inkstone, offline" checked={s.authorship.attachToPdf} onChange={(v) => set({ attachToPdf: v })} />
        </div>
        <p className="set-note">Inkstone signs certificates with a key made on this device that can never leave it. Share the fingerprint with whoever checks your work so they know the key is yours. The name is whatever you type; nobody verifies it.</p>
      </section>
      <section className="set-group">
        <h2>Verify a certificate</h2>
        <div className="set-card"><VerifyPanel ownFingerprint={fp?.fingerprint} /></div>
        <HonestNote />
      </section>
    </>
  );
}

export function VerifyPanel({ ownFingerprint }: { ownFingerprint?: string }) {
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<{ name: string; cert: AuthorshipCertificate; report: VerifyReport } | { name: string; error: string } | null>(null);

  const check = async (f: File) => {
    try {
      const cert = await certificateFromFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      setResult({ name: f.name, cert, report: await verifyCertificate(cert) });
    } catch (e) {
      setResult({ name: f.name, error: (e as Error).message });
    }
  };

  return (
    <div className="auth-verify">
      <div className={cx('auth-drop', over && 'is-over')}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void check(f); }}>
        <FileUp size={22} />
        <span>Drop an exported PDF or a certificate (.json) here</span>
        <button type="button" className="btn btn-sm" onClick={async () => { const [f] = await pickFiles('application/pdf,application/json,.json,.pdf', false); if (f) void check(f); }}>Choose a file…</button>
        <input type="file" accept="application/pdf,application/json,.json,.pdf" aria-label="Certificate file" className="auth-file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void check(f); }} />
      </div>
      {result && 'error' in result && <p className="auth-problems" role="alert">{result.name}: {result.error}</p>}
      {result && 'report' in result && <ReportView name={result.name} cert={result.cert} report={result.report} own={ownFingerprint} />}
    </div>
  );
}

function ReportView({ name, cert, report, own }: { name: string; cert: AuthorshipCertificate; report: VerifyReport; own?: string }) {
  // Recount from the evidence (not the claim) so what is shown is what the signed data says.
  let counts = { ...ZERO_COUNTS };
  const hand: InkStroke[] = [];
  for (const ev of cert.evidence.pages) { const c = classifyPage(pageFromEvidence(ev)); counts = addCounts(counts, c.counts); hand.push(...c.handwritten); }
  const problems = [...report.problems, ...report.pages.flatMap((p) => p.problems)];
  return (
    <div className="auth-report" data-testid="verify-report" data-status={report.status}>
      <h3 className="pop-title" style={{ marginTop: 14 }}>{name}</h3>
      <StatusBlock report={report} />
      <dl className="auth-grid">
        <dt>Note</dt><dd>“{report.subject.title}” · {cert.claim.pages.length} {cert.claim.pages.length === 1 ? 'page' : 'pages'}</dd>
        <dt>Signed</dt><dd>{new Date(report.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        <dt>Signing key</dt><dd><span className="auth-fp">{report.fingerprint}</span>{own && own === report.fingerprint ? ' — this device' : ''}{report.signerName ? ` · “${report.signerName}” (self-named)` : ''}</dd>
        <CountsList c={counts} />
        <RhythmList r={writingRhythm(hand)} />
      </dl>
      {problems.length > 0 && <ul className="auth-problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      <SignedInkPreview cert={cert} />
    </div>
  );
}
