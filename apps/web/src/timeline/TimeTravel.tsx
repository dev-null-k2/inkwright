/**
 * Time travel UI: the "Show notes as of…" dialog with a scrubber over the vault's history, and
 * the bar that stays on screen while the past is shown (with the scrubber and "Back to today").
 */
import { useEffect, useMemo, useState } from 'react';
import { History } from 'lucide-react';
import type { NoteDocument } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { Dialog } from '../ui/primitives.tsx';
import { backToToday, travelTo, useTimeTravel, vaultMoments } from './timetravel.ts';

const fmt = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** `<input type="datetime-local">` value for a time, in local time. */
function localInput(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export const useTimeTravelDialog = (() => {
  let set: ((v: boolean) => void) | null = null;
  return { open: () => set?.(true), bind: (f: (v: boolean) => void) => { set = f; } };
})();

/** Scrubber over the moments the vault has a record of; snaps to them. */
function Scrubber({ moments, value, onChange, label }: { moments: number[]; value: number; onChange: (t: number) => void; label: string }) {
  const now = useMemo(() => Date.now(), []);
  const min = moments[0] ?? now - 86_400_000;
  const nearest = (t: number) => moments.reduce((best, m) => (Math.abs(m - t) < Math.abs(best - t) ? m : best), now);
  return (
    <div className="tt-scrub">
      <input type="range" min={min} max={now} step={60_000} value={Math.min(now, Math.max(min, value))} aria-label={label} aria-valuetext={fmt(value)}
        onChange={(e) => onChange(nearest(Number(e.target.value)))} />
      <div className="tt-ticks" aria-hidden>
        {moments.map((m) => <span key={m} style={{ left: `${((m - min) / Math.max(1, now - min)) * 100}%` }} />)}
      </div>
    </div>
  );
}

export function TimeTravelDialog() {
  const [open, setOpen] = useState(false);
  useTimeTravelDialog.bind(setOpen);
  const vault = useApp((s) => s.vault);
  const toast = useApp((s) => s.toast);
  const present = useTimeTravel((s) => s.present);
  const [moments, setMoments] = useState<number[]>([]);
  const [t, setT] = useState(() => Date.now() - 86_400_000);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const fs = (present ?? vault)?.fs;
    if (!open || !fs) return;
    let live = true;
    void vaultMoments(fs).then((m) => { if (live) setMoments(m); });
    return () => { live = false; };
  }, [open, vault, present]);
  const go = async () => {
    setBusy(true);
    try {
      await travelTo(t);
      setOpen(false);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
    setBusy(false);
  };
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Show notes as of…" actions={
      <>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || t > Date.now()} onClick={() => void go()}>Show</button>
      </>
    }>
      <p className="muted">The library, search and graph show your notes as they were, from each note’s version history. Nothing changes until you come back to today.</p>
      <label className="field">
        <span className="field-label">Date and time</span>
        <input type="datetime-local" value={localInput(t)} max={localInput(Date.now())} onChange={(e) => { const v = new Date(e.target.value).getTime(); if (Number.isFinite(v)) setT(v); }} />
      </label>
      {moments.length > 1 && <Scrubber moments={moments} value={t} onChange={setT} label="Moments with saved versions" />}
    </Dialog>
  );
}

/** Shown while looking at the past, on every screen. */
export function TimeTravelBar() {
  const { asOf, loading, unknown, present } = useTimeTravel();
  const toast = useApp((s) => s.toast);
  const [moments, setMoments] = useState<number[]>([]);
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => {
    if (!present) return;
    void vaultMoments(present.fs).then(setMoments);
  }, [present]);
  // Scrubbing settles before the vault is re-read.
  useEffect(() => {
    if (draft == null || draft === asOf) return;
    const id = setTimeout(() => void travelTo(draft).catch((e) => toast({ text: (e as Error).message, tone: 'error' })), 350);
    return () => clearTimeout(id);
  }, [draft, asOf, toast]);
  if (asOf == null) return null;
  return (
    <div className="tt-bar" role="region" aria-label="Time travel">
      <History size={16} />
      <span className="tt-when">Your notes as of <b>{fmt(draft ?? asOf)}</b> · read-only{loading ? '…' : ''}</span>
      {moments.length > 1 && <Scrubber moments={moments} value={draft ?? asOf} onChange={setDraft} label="Move through time" />}
      {unknown.length > 0 && <span className="tt-unknown muted small" title={unknown.map((u) => u.title).join(', ')}>{unknown.length} {unknown.length === 1 ? 'note has' : 'notes have'} no record from then</span>}
      <button type="button" className="btn btn-sm" onClick={() => { setDraft(null); void backToToday(); }}>Back to today</button>
    </div>
  );
}

/**
 * While looking at the past, an open note can be read but not changed: any edit is put back at
 * once (and nothing would be saved anyway — the past is read-only).
 */
export function useTimeTravelGuard(doc: NoteDocument | null): void {
  const asOf = useTimeTravel((s) => s.asOf);
  useEffect(() => {
    if (!doc || asOf == null) return;
    let original = new Map(doc.committedPages.map((p) => [p.id, p]));
    let reverting = false;
    return doc.subscribe(() => {
      if (reverting) return;
      reverting = true;
      try {
        for (let i = doc.pageCount - 1; i >= 0; i--) if (!original.has(doc.committedPages[i]!.id)) doc.deletePage(i);
        doc.committedPages.forEach((p, i) => {
          const o = original.get(p.id);
          if (o && o !== p) doc.replacePage(i, o);
        });
        original = new Map(doc.committedPages.map((p) => [p.id, p]));
      } finally {
        reverting = false;
      }
    });
  }, [doc, asOf]);
}
