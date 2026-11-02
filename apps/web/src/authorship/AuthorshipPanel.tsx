import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Download, FileCheck2, ShieldAlert, ShieldX } from 'lucide-react';
import {
  ZERO_COUNTS, addCounts, classifyPage, exportPageSvg, newNote, pageFromEvidence, writingRhythm,
  type AuthorshipCertificate, type ContentCounts, type InkStroke, type NoteDocument, type VerifyReport, type WritingRhythm,
} from '@inkstone/core';
import type { AppVault } from '../lib/vault.ts';
import { saveFile } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { Dialog, cx, relativeTime } from '../ui/primitives.tsx';
import { certificateJson, signAndStore, verifyStored } from './certificate.ts';
import { deviceKey, shortDeviceId } from './keys.ts';

/** Stamps this device's short key id on the note's new authorship chain events. */
export function useAuthorshipDevice(doc: NoteDocument | null): void {
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    void deviceKey().then((k) => { if (alive) doc.authorshipDevice = shortDeviceId(k.fingerprint); }).catch(() => undefined);
    return () => { alive = false; };
  }, [doc]);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** One line per kind of content: what is handwriting and what is not. */
export function CountsList({ c }: { c: ContentCounts }) {
  const rows: [string, string][] = [];
  rows.push(['Written by hand', c.handwritten ? `${plural(c.handwritten, 'stroke')}${c.penWithPressure ? ` (${c.penWithPressure.toLocaleString()} with pen pressure)` : ''}${c.touch ? `, ${c.touch.toLocaleString()} by finger` : ''}${c.mouse ? `, ${c.mouse.toLocaleString()} by mouse` : ''}` : 'None']);
  if (c.typedText) rows.push(['Typed', plural(c.typedText, 'text box', 'text boxes')]);
  if (c.aiText || c.aiInk || c.aiImages) rows.push(['Made by AI', [c.aiText && plural(c.aiText, 'text box', 'text boxes'), c.aiInk && plural(c.aiInk, 'stroke'), c.aiImages && plural(c.aiImages, 'image')].filter(Boolean).join(', ')]);
  if (c.recognizedText || c.objects) rows.push(['Made by the app', [c.recognizedText && `${plural(c.recognizedText, 'recognized text')}`, c.objects && plural(c.objects, 'table, result or graph', 'tables, results or graphs')].filter(Boolean).join(', ')]);
  if (c.importedImages || c.importedPages || c.importedText) rows.push(['Imported', [c.importedPages && plural(c.importedPages, 'PDF/image page'), c.importedImages && plural(c.importedImages, 'image'), c.importedText && plural(c.importedText, 'text file')].filter(Boolean).join(', ')]);
  if (c.copied) rows.push(['Pasted or copied ink', plural(c.copied, 'stroke')]);
  if (c.unattested) rows.push(['Without history', `${plural(c.unattested, 'stroke')} (written before this was recorded, or edited outside Inkstone)`]);
  return <>{rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}</>;
}

export function RhythmList({ r }: { r: WritingRhythm }) {
  if (!r.firstAt) return null;
  const fmt = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      <dt>Written</dt><dd>{fmt(r.firstAt)} – {fmt(r.lastAt)}{r.sessions > 1 ? ` (${r.sessions} sessions)` : ''}</dd>
      <dt>Pen on paper</dt><dd>{duration(r.inkMs)}</dd>
      <dt>Rhythm</dt><dd>median pause {(r.pauseMedianMs / 1000).toFixed(1)} s · speed {Math.round(r.speedMean)} px/s, varies ±{Math.round(r.speedCv * 100)}%{r.pressureMean >= 0 ? ` · pressure ${r.pressureMean.toFixed(2)} ± ${r.pressureSd.toFixed(2)}` : ''}</dd>
    </>
  );
}

export function StatusBlock({ report, signedAt }: { report: VerifyReport | null; signedAt?: number }) {
  if (!report) {
    return (
      <div className="auth-status">
        <FileCheck2 size={20} />
        <div><strong>Not signed yet</strong><p>Sign a certificate to record this note’s handwriting as it is now.</p></div>
      </div>
    );
  }
  const changed = report.pages.reduce((n, p) => n + (p.since ? p.since.added + p.since.removed + p.since.changed : 0), 0);
  const appendOnly = report.pages.every((p) => !p.since || p.since.appendOnly);
  if (report.status === 'invalid') {
    return (
      <div className="auth-status is-invalid">
        <ShieldX size={20} />
        <div><strong>Certificate not valid</strong><p>{report.problems[0] ?? report.pages.flatMap((p) => p.problems)[0] ?? 'It does not match what was signed.'}</p></div>
      </div>
    );
  }
  if (report.status === 'changed') {
    return (
      <div className="auth-status is-changed">
        <ShieldAlert size={20} />
        <div>
          <strong>Changed since signing</strong>
          <p>{plural(changed, 'item')} added, removed or edited {signedAt ? relativeTime(signedAt) : ''} after the certificate. {appendOnly ? 'The earlier history is intact.' : 'Its history was merged from another device.'} Sign again to include the changes.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="auth-status is-verified">
      <BadgeCheck size={20} />
      <div><strong>Verified handwriting</strong><p>Signature, history and content all match{signedAt ? ` (signed ${relativeTime(signedAt)})` : ''}.</p></div>
    </div>
  );
}

/** A picture of the signed ink, for comparing with the document it came with. */
export function SignedInkPreview({ cert }: { cert: AuthorshipCertificate }) {
  const url = useMemo(() => {
    const ev = cert.evidence.pages[0];
    if (!ev) return null;
    const page = pageFromEvidence(ev);
    const note = newNote({ id: cert.claim.subject.noteId || 'note', title: cert.claim.subject.title, pageId: page.id, now: 0, kind: 'board' });
    const svg = exportPageSvg(note, { ...page, background: undefined, images: [] }, { includePaper: false });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [cert]);
  return url ? <img className="auth-preview" src={url} alt="The signed handwriting (first page)" /> : null;
}

export function HonestNote() {
  return (
    <details className="auth-honest">
      <summary>What this proves — and what it doesn’t</summary>
      <ul>
        <li>It proves the signed writing and its full edit history are exactly what this device’s key signed, and that nothing in them was altered afterwards.</li>
        <li>Every stroke records how it was made (stylus, finger or mouse, pressure, tilt, timing). AI answers, solved results, recognized text and imported files are labelled and never counted as handwriting.</li>
        <li>It cannot prove who held the pen, or that the writing wasn’t copied by hand from something an AI wrote. Writing time and rhythm help a reader judge that, but they are evidence, not proof.</li>
        <li>The key belongs to this device, not to a verified identity: a reader should compare the fingerprint with one you share with them.</li>
      </ul>
    </details>
  );
}

/** Editor › ••• › Authorship: the note's "Verified handwriting" panel. */
export function AuthorshipDialog({ open, onClose, doc, vault, onVerifyFile }: { open: boolean; onClose: () => void; doc: NoteDocument; vault: AppVault; onVerifyFile: () => void }) {
  const { toast } = useApp();
  const [stored, setStored] = useState<{ cert: AuthorshipCertificate; report: VerifyReport } | null | undefined>(undefined);
  const [fp, setFp] = useState<{ fingerprint: string; persistent: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const version = doc.version;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void deviceKey().then((k) => alive && setFp({ fingerprint: k.fingerprint, persistent: k.persistent })).catch(() => undefined);
    void verifyStored(vault, doc).then((r) => alive && setStored(r)).catch(() => alive && setStored(null));
    return () => { alive = false; };
  }, [open, doc, vault, version, doc.meta.certificate?.asset]);

  const now = useMemo(() => {
    let counts = { ...ZERO_COUNTS };
    const hand: InkStroke[] = [];
    for (const p of doc.pages) { const c = classifyPage(p); counts = addCounts(counts, c.counts); hand.push(...c.handwritten); }
    return { counts, rhythm: writingRhythm(hand) };
  }, [doc, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const sign = async () => {
    setBusy(true);
    try {
      await signAndStore(vault, doc);
      toast({ text: 'Signed this note’s certificate', tone: 'success' });
    } catch (e) {
      toast({ text: `Could not sign: ${(e as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    const cert = stored?.cert;
    if (!cert) return;
    const name = `${(doc.meta.title.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)} authorship.json`;
    await saveFile(name, new TextEncoder().encode(certificateJson(cert)), 'application/json');
  };

  return (
    <Dialog open={open} title="Authorship" onClose={onClose} wide actions={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <StatusBlock report={stored?.report ?? null} signedAt={doc.meta.certificate?.signedAt} />
      <dl className="auth-grid">
        <CountsList c={now.counts} />
        <RhythmList r={now.rhythm} />
        <dt>This device’s key</dt>
        <dd><span className="auth-fp">{fp?.fingerprint ?? '…'}</span>{fp && !fp.persistent ? ' (this session only: storage is unavailable)' : ''}</dd>
      </dl>
      <div className="auth-actions">
        <button type="button" className={cx('btn', 'btn-primary')} disabled={busy} onClick={() => void sign()}><BadgeCheck size={16} /> {stored ? 'Sign again' : 'Sign certificate'}</button>
        {stored && <button type="button" className="btn" onClick={() => void download()}><Download size={16} /> Download certificate</button>}
        <button type="button" className="btn btn-ghost" onClick={onVerifyFile}>Verify a file…</button>
      </div>
      <p className="set-note">Exported PDFs carry a signed certificate of the pages they contain (Settings › Authorship).</p>
      <HonestNote />
    </Dialog>
  );
}
