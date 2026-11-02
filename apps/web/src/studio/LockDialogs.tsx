import { useEffect, useState } from 'react';
import { ArrowLeft, LockKeyhole } from 'lucide-react';
import { MIN_PASSCODE, unlockWith } from '@inkstone/core';
import type { AppVault } from '../lib/vault.ts';
import { Dialog } from '../ui/primitives.tsx';

/**
 * Locked notes in the editor: the passcode gate shown instead of the page, and the dialog that
 * locks a note (with the warning that a forgotten passcode can't be recovered). Threat model and
 * format: docs/PRIVACY.md, docs/VAULT_FORMAT.md.
 */

export function LockGate({ vault, noteId, onUnlocked, onBack }: { vault: AppVault; noteId: string; onUnlocked: () => void; onBack: () => void }) {
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void vault.vault.readNote(noteId).then((n) => setTitle(n?.title ?? '')); }, [vault, noteId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const note = await vault.vault.readNote(noteId);
      if (!note?.lock) return onUnlocked();
      const key = await unlockWith(note.lock, code);
      if (!key) { setError('That passcode doesn’t open this note.'); setCode(''); return; }
      vault.vault.unlock(noteId, key);
      onUnlocked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-gate" role="region" aria-label="Locked note">
      <button type="button" className="icon-btn lock-gate-back" aria-label="Back to library" onClick={onBack}><ArrowLeft size={20} /></button>
      <form className="lock-card" onSubmit={(e) => void submit(e)}>
        <span className="lock-seal" aria-hidden><LockKeyhole size={22} /></span>
        <h1 className="lock-title">{title || 'Locked note'}</h1>
        <p className="lock-sub">This note is locked. Enter its passcode to open it.</p>
        <input className="lock-input" type="password" autoFocus autoComplete="off" aria-label="Passcode" placeholder="Passcode" value={code} onChange={(e) => setCode(e.target.value)} />
        {error && <p className="lock-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={!code || busy}>{busy ? 'Unlocking…' : 'Open'}</button>
      </form>
    </div>
  );
}

export function LockNoteDialog({ open, onClose, onLock }: { open: boolean; onClose: () => void; onLock: (passcode: string) => Promise<void> }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setA(''); setB(''); setOk(false); setError(null); } }, [open]);
  const problem = a.length > 0 && a.length < MIN_PASSCODE ? `Use at least ${MIN_PASSCODE} characters.` : b && a !== b ? 'The passcodes don’t match.' : null;
  const ready = a.length >= MIN_PASSCODE && a === b && ok && !busy;
  const lock = async () => {
    if (!ready) return;
    setBusy(true);
    try { await onLock(a); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} title="Lock this note" onClose={onClose} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void lock()}>{busy ? 'Locking…' : 'Lock note'}</button>
    </>}>
      <div className="lock-form">
        <p>The pages, pictures, recordings and history of this note are encrypted with your passcode, here and in every synced copy. Search and the assistant skip it. The title stays visible in your library.</p>
        <label className="field"><span className="field-label">Passcode</span><input type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} aria-label="Passcode" /></label>
        <label className="field"><span className="field-label">Repeat passcode</span><input type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} aria-label="Repeat passcode" /></label>
        {(problem || error) && <p className="lock-error" role="alert">{problem ?? error}</p>}
        <div className="lock-warning">
          <strong>There is no way to recover a forgotten passcode.</strong> Not even the developer can open the note without it.
        </div>
        <label className="lock-ack"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I understand that if I forget the passcode, this note is lost.</label>
      </div>
    </Dialog>
  );
}
