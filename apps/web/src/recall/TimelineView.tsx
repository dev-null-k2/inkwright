import { useEffect, useMemo, useRef, useState } from 'react';
import { EyeOff, NotebookPen, Pause, Play, Search, Trash2, X } from 'lucide-react';
import {
  capturesByHour,
  candidateNotes,
  dayBounds,
  dayKey,
  highlightLine,
  inkMomentsBetween,
  momentsNear,
  noteSpans,
  parseRecallQuery,
  searchCaptures,
  SKIP_REASON_TEXT,
  type Capture,
  type NoteMoment,
  type RecallHit,
} from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { IconButton, cx } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { isDesktop } from '../desktop/bridge.ts';
import type { AppVault } from '../lib/vault.ts';
import { bumpRecall, isPaused, recallStore, useRecall } from './state.ts';
import { togglePause } from './service.ts';
import { closeTimeline, useTimelineUI } from './ui.ts';
import './recall.css';

/**
 * The memory timeline: scrub by day and hour through what was on screen (and, if on, what was
 * said nearby), search it in plain words, see what you wrote at the same moment, and erase any
 * moment, day or everything. Works on every device over synced captures; capturing needs the
 * desktop app.
 */

const hhmm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const REDACTED_LABEL: Record<string, string> = { email: 'email', phone: 'phone number', card: 'card number', iban: 'bank account', gov_id: 'ID number', secret: 'secret', address: 'address', name: 'name', ip: 'IP address' };

function dayLabel(day: string, now = Date.now()): string {
  const today = dayKey(new Date(now));
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day === today) return 'Today';
  if (day === dayKey(y)) return 'Yesterday';
  const b = dayBounds(day);
  return b ? new Date(b.from).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : day;
}

function redactedText(r: Record<string, number> | undefined): string | null {
  if (!r) return null;
  const parts = Object.entries(r).map(([k, n]) => `${n} ${REDACTED_LABEL[k] ?? k}${n === 1 ? '' : 's'}`);
  return parts.length ? `Hidden before saving: ${parts.join(', ')}` : null;
}

/** Ink written in notes during [from, to) (the user's own view: every note, locked ones stay blank). */
async function momentsIn(vault: AppVault, from: number, to: number): Promise<NoteMoment[]> {
  const notes = candidateNotes(useApp.getState().notes, from, to);
  const loaded = await Promise.all(notes.map(async (meta) => ({ meta, pages: meta.lock ? [] : await vault.vault.readPages(meta).catch(() => []) })));
  return inkMomentsBetween(loaded, from, to);
}

function Lines({ lines, terms }: { lines: string[]; terms: string[] }) {
  return (
    <div className="rc-lines">
      {lines.map((l, i) => (
        <p key={i}>{highlightLine(l, terms).map((p, j) => (p.hit ? <mark key={j}>{p.text}</mark> : <span key={j}>{p.text}</span>))}</p>
      ))}
    </div>
  );
}

function Moment({ c, terms, lines, notes, focused, onErase, onOpenNote }: { c: Capture; terms: string[]; lines?: string[]; notes: NoteMoment[]; focused?: boolean; onErase: () => void; onOpenNote: (m: NoteMoment) => void }) {
  const [more, setMore] = useState(false);
  const all = c.text.split('\n').filter(Boolean);
  const shown = lines ?? (more ? all : all.slice(0, 6));
  const hidden = redactedText(c.redacted);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'center' }); }, [focused]);
  return (
    <article ref={ref} className={cx('rc-moment', focused && 'is-focused')} data-capture={c.id}>
      <header>
        <time dateTime={new Date(c.at).toISOString()}>{hhmm(c.at)}</time>
        <span className="rc-app">{c.kind === 'audio' ? 'Heard nearby' : c.app || 'Screen'}</span>
        {c.title && <span className="rc-title">{c.title}</span>}
        <IconButton label="Erase this moment" className="rc-erase" onClick={onErase}><Trash2 size={15} /></IconButton>
      </header>
      {shown.length > 0 && <Lines lines={shown} terms={terms} />}
      {!lines && all.length > 6 && <button type="button" className="rc-more" onClick={() => setMore(!more)}>{more ? 'Show less' : `Show ${all.length - 6} more lines`}</button>}
      {hidden && <p className="rc-hidden"><EyeOff size={13} aria-hidden /> {hidden}</p>}
      {notes.length > 0 && (
        <div className="rc-notes" aria-label="Written at the same time">
          <span>Written at the same time:</span>
          {notes.slice(0, 3).map((m) => (
            <button key={`${m.noteId}:${m.pageIndex}`} type="button" className="rc-note" onClick={() => onOpenNote(m)}>
              <NotebookPen size={13} aria-hidden /> {m.title || 'Untitled'}{m.pageIndex > 0 ? ` · p. ${m.pageIndex + 1}` : ''}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

export function TimelineView() {
  const { open, focusAt, query: initialQuery } = useTimelineUI();
  const vault = useApp((s) => s.vault);
  const notes = useApp((s) => s.notes);
  const version = useRecall((s) => s.version);
  const capture = useRecall((s) => s.capture);
  const status = useRecall((s) => s.status);
  const paused = useRecall((s) => isPaused(s));
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState<string | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [moments, setMoments] = useState<NoteMoment[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ q: ReturnType<typeof parseRecallQuery>; hits: RecallHit[]; moments: NoteMoment[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    if (focusAt) setDay(dayKey(new Date(focusAt)));
  }, [open, focusAt, initialQuery]);

  // Days with captures.
  useEffect(() => {
    if (!open || !vault) return;
    let alive = true;
    void recallStore(vault).days().then((d) => {
      if (!alive) return;
      setDays(d);
      setDay((cur) => (cur && (d.includes(cur) || cur === dayKey(new Date())) ? cur : d[0] ?? dayKey(new Date())));
    });
    return () => { alive = false; };
  }, [open, vault, version]);

  // The day's captures, and the ink written that day.
  useEffect(() => {
    if (!open || !vault || !day) return;
    let alive = true;
    const b = dayBounds(day);
    void Promise.all([recallStore(vault).readDay(day), b ? momentsIn(vault, b.from, b.to) : Promise.resolve([])]).then(([cs, ms]) => {
      if (!alive) return;
      setCaptures(cs);
      setMoments(ms);
    });
    return () => { alive = false; };
  }, [open, vault, day, version, notes]);

  // Search, a moment after typing stops.
  useEffect(() => {
    if (!open || !vault) return;
    const q = query.trim();
    if (!q) { setHits(null); return; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const now = Date.now();
      const store = recallStore(vault);
      const probe = parseRecallQuery(q, now);
      const from = probe.from ?? 0;
      const to = probe.to ?? now + 60_000;
      const all = await store.readRange(from, to);
      const apps = [...new Set(all.map((c) => c.app).filter((a): a is string => !!a))];
      const parsed = parseRecallQuery(q, now, apps);
      const span = all.length ? { from: Math.max(from, all[0]!.at - 3_600_000), to: Math.min(to, all[all.length - 1]!.at + 3_600_000) } : null;
      const ms = span ? await momentsIn(vault, span.from, span.to) : [];
      const found = searchCaptures(all, parsed, { notes: noteSpans(ms), limit: 40 });
      if (alive) { setHits({ q: parsed, hits: found, moments: ms }); setSearching(false); }
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [open, vault, query, version]);

  const byHour = useMemo(() => capturesByHour(captures), [captures]);
  const maxPerHour = Math.max(1, ...[...byHour.values()].map((l) => l.length));
  const focusedId = useMemo(() => {
    if (!focusAt || !captures.length) return null;
    let best = captures[0]!;
    for (const c of captures) if (Math.abs(c.at - focusAt) < Math.abs(best.at - focusAt)) best = c;
    return best.id;
  }, [focusAt, captures]);

  if (!open || !vault) return null;

  const erase = async (c: Capture) => {
    await recallStore(vault).erase(new Set([c.id]), dayKey(new Date(c.at)));
    bumpRecall();
  };
  const eraseDay = async () => {
    if (!day) return;
    const label = dayLabel(day);
    const ok = await askConfirm(`Erase ${label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : label}?`, 'Every moment captured that day is deleted from this vault, and from your other devices when they sync. Your notes are not touched.', 'Erase the day', true);
    if (!ok) return;
    await recallStore(vault).eraseDay(day);
    bumpRecall();
  };
  const openNote = (m: NoteMoment) => {
    closeTimeline();
    useApp.getState().navigate({ name: 'editor', noteId: m.noteId, page: m.pageIndex });
  };
  const scrollToHour = (h: number) => listRef.current?.querySelector(`[data-hour="${h}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  const statusText = !isDesktop
    ? 'Capturing needs the Inkwright desktop app. Moments captured on your computer show up here when they sync.'
    : !capture ? 'Capturing is off on this computer. Turn it on in Settings › Memory timeline.'
    : paused ? 'Paused'
    : status.kind === 'skipped' ? SKIP_REASON_TEXT[status.reason]
    : status.kind === 'needs-permission' ? 'Inkwright needs screen recording permission (Settings › Memory timeline).'
    : status.kind === 'unsupported' ? status.why
    : status.kind === 'error' ? `Capture stopped: ${status.message}`
    : 'Capturing';

  return (
    <div className="rc-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeTimeline(); }}>
      <section className="rc-panel" role="dialog" aria-modal="true" aria-label="Memory timeline" onKeyDown={(e) => { if (e.key === 'Escape') closeTimeline(); }}>
        <header className="rc-top">
          <h2>Memory timeline</h2>
          <p className={cx('rc-status', isDesktop && capture && !paused && status.kind === 'capturing' && 'is-live')} data-testid="recall-status">{statusText}</p>
          {isDesktop && capture && (
            <IconButton label={paused ? 'Resume capturing' : 'Pause for an hour'} onClick={() => togglePause()}>{paused ? <Play size={17} /> : <Pause size={17} />}</IconButton>
          )}
          <IconButton label="Close" onClick={closeTimeline}><X size={19} /></IconButton>
        </header>
        <label className="rc-search">
          <Search size={16} aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search what you saw: “that command in Tuesday’s lecture”" aria-label="Search the memory timeline" autoFocus />
        </label>

        {hits ? (
          <div className="rc-results" aria-live="polite">
            <p className="rc-summary">
              {searching ? 'Searching…' : `${hits.hits.length === 0 ? 'Nothing found' : `${hits.hits.length} ${hits.hits.length === 1 ? 'moment' : 'moments'}`}${hits.q.when ? ` · ${hits.q.when}` : ''}${hits.q.app ? ` · in ${hits.q.app}` : ''}`}
            </p>
            {hits.hits.map((h) => (
              <div key={h.capture.id} className="rc-hit">
                <button type="button" className="rc-hit-day" onClick={() => { setQuery(''); setDay(dayKey(new Date(h.capture.at))); useTimelineUI.setState({ focusAt: h.capture.at }); }}>{dayLabel(dayKey(new Date(h.capture.at)))}</button>
                <Moment c={h.capture} terms={h.matched.length ? h.matched : hits.q.terms} lines={h.lines} notes={momentsNear(hits.moments, h.capture.at)} onErase={() => void erase(h.capture)} onOpenNote={openNote} />
              </div>
            ))}
          </div>
        ) : (
          <>
            <nav className="rc-days" aria-label="Days">
              {(days.length ? days : [dayKey(new Date())]).map((d) => (
                <button key={d} type="button" className={cx('rc-day', d === day && 'is-on')} aria-current={d === day ? 'date' : undefined} onClick={() => { setDay(d); useTimelineUI.setState({ focusAt: null }); }}>{dayLabel(d)}</button>
              ))}
            </nav>
            <div className="rc-hours" role="group" aria-label="Hours">
              {Array.from({ length: 24 }, (_, h) => {
                const n = byHour.get(h)?.length ?? 0;
                return (
                  <button key={h} type="button" className="rc-hour" disabled={!n} onClick={() => scrollToHour(h)} aria-label={`${String(h).padStart(2, '0')}:00, ${n} ${n === 1 ? 'moment' : 'moments'}`} title={`${String(h).padStart(2, '0')}:00`}>
                    <span style={{ height: `${n ? 18 + (82 * n) / maxPerHour : 6}%` }} className={cx(n > 0 && 'has')} />
                  </button>
                );
              })}
            </div>
            <div className="rc-list" ref={listRef}>
              {captures.length === 0 && <p className="rc-empty">No moments on this day.</p>}
              {[...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([h, list]) => (
                <section key={h} data-hour={h} className="rc-hour-group">
                  <h3>{String(h).padStart(2, '0')}:00</h3>
                  {list.map((c) => (
                    <Moment key={c.id} c={c} terms={[]} notes={momentsNear(moments, c.at)} focused={c.id === focusedId} onErase={() => void erase(c)} onOpenNote={openNote} />
                  ))}
                </section>
              ))}
              {captures.length > 0 && <button type="button" className="btn btn-danger-ghost btn-sm rc-erase-day" onClick={() => void eraseDay()}><Trash2 size={14} aria-hidden /> Erase this day</button>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
