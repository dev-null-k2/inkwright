import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Building2, FileAudio, CalendarPlus, ChevronRight, Mic, NotebookPen, RefreshCw, Sparkles, Users, Video } from 'lucide-react';
import {
  callService,
  companyName,
  currentMeetingNotes,
  peopleAndCompanies,
  type NoteMeta,
  type Recipe,
  type UpcomingMeeting,
} from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { IconButton, Segmented, cx, relativeTime } from '../ui/primitives.tsx';
import { addCalendarUrl, importCalendarFile } from '../journal/config.ts';
import { pickFiles } from '../platform/files.ts';
import { loadUpcoming, noteForEvent, startMeetingNote, useUpcoming } from './calendar.ts';
import { RECORDING_ACCEPT, importOnOpen } from './importer.ts';
import { runRecipe, writeBrief } from './enhance.ts';
import { meetingReplyHtml } from './render.ts';
import { allRecipes, loadMeetingsLibrary, readMeetingNotes, useMeetingPrefs, useMeetingsLibrary } from './store.ts';
import './meetings.css';
import './meetings-view.css';

type Tab = 'upcoming' | 'ask' | 'people' | 'companies';

/** A note taken in a meeting: it has meeting info, the meeting tag, or recordings. */
export const isMeetingNote = (n: NoteMeta) => !n.trashedAt && (!!n.meeting || n.tags.includes('meeting') || (n.recordings?.length ?? 0) > 0);

const timeOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayOf = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

export default function MeetingsView({ initialTab }: { initialTab?: Tab }) {
  const navigate = useApp((s) => s.navigate);
  const vault = useApp((s) => s.vault);
  const notes = useApp((s) => s.notes);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'upcoming');
  const [scope, setScope] = useState<{ label: string; ids: string[] } | null>(null);
  useEffect(() => { if (vault) { void loadMeetingsLibrary(vault); void loadUpcoming(vault); } }, [vault]);
  const meetings = useMemo(() => notes.filter(isMeetingNote).sort((a, b) => (b.meeting?.event?.start ?? b.createdAt) - (a.meeting?.event?.start ?? a.createdAt)), [notes]);
  const self = useMeetingPrefs((s) => s.selfEmails);
  const pc = useMemo(() => peopleAndCompanies(notes, self), [notes, self]);
  const askAbout = (label: string, ids: string[]) => { setScope({ label, ids }); setTab('ask'); };
  const importFromScreen = async () => {
    const [f] = await pickFiles(RECORDING_ACCEPT, false);
    if (!f || !vault) return;
    const title = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Recording';
    await startMeetingNote(vault, null, { title, beforeOpen: (id) => importOnOpen(id, f) });
  };
  if (!vault) return null;
  return (
    <div className="mtv-screen">
      <header className="mtv-top">
        <IconButton label="Back to library" onClick={() => navigate({ name: 'library' })}><ArrowLeft size={20} /></IconButton>
        <h1 className="mtv-title">Meetings</h1>
        <button type="button" className="btn btn-sm" onClick={() => void importFromScreen()}><FileAudio size={15} /> Import a recording</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void startMeetingNote(vault, null, { record: true })}><Mic size={15} /> New meeting</button>
      </header>
      <div className="mtv-tabs">
        <Segmented label="Meetings view" value={tab} onChange={(v) => setTab(v)} options={[
          { value: 'upcoming', label: 'Meetings' },
          { value: 'ask', label: 'Ask' },
          { value: 'people', label: `People${pc.people.length ? ` ${pc.people.length}` : ''}` },
          { value: 'companies', label: `Companies${pc.companies.length ? ` ${pc.companies.length}` : ''}` },
        ]} />
      </div>
      <main className="mtv-main">
        {tab === 'upcoming' && <UpcomingTab meetings={meetings} />}
        {tab === 'ask' && <AskTab meetings={meetings} scope={scope} onScope={setScope} />}
        {tab === 'people' && (
          <ul className="mtv-list" aria-label="People">
            {!pc.people.length && <li className="mtv-empty">People appear here from the attendees of your meeting notes (from your calendar, or added in a note’s Meeting panel).</li>}
            {pc.people.map((p) => (
              <li key={p.key} className="mtv-row">
                <span className="mtv-avatar" aria-hidden>{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="mtv-row-main"><strong>{p.name}</strong><small>{[p.email, p.company ? companyName(p.company) : ''].filter(Boolean).join(' · ')}</small></span>
                <span className="mtv-row-meta">{p.meetings.length} {p.meetings.length === 1 ? 'meeting' : 'meetings'} · {relativeTime(p.last)}</span>
                <button type="button" className="btn btn-sm" onClick={() => askAbout(p.name, p.meetings)}><Sparkles size={14} /> Ask</button>
              </li>
            ))}
          </ul>
        )}
        {tab === 'companies' && (
          <ul className="mtv-list" aria-label="Companies">
            {!pc.companies.length && <li className="mtv-empty">Companies appear here from attendees’ work email addresses.</li>}
            {pc.companies.map((c) => (
              <li key={c.domain} className="mtv-row">
                <span className="mtv-avatar is-co" aria-hidden><Building2 size={16} /></span>
                <span className="mtv-row-main"><strong>{c.name}</strong><small>{c.domain} · {c.people.length} {c.people.length === 1 ? 'person' : 'people'}</small></span>
                <span className="mtv-row-meta">{c.meetings.length} {c.meetings.length === 1 ? 'meeting' : 'meetings'} · {relativeTime(c.last)}</span>
                <button type="button" className="btn btn-sm" onClick={() => askAbout(c.name, c.meetings)}><Sparkles size={14} /> Ask</button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

// ---- Coming up, and recent meetings -------------------------------------------------------------------

function UpcomingTab({ meetings }: { meetings: NoteMeta[] }) {
  const vault = useApp((s) => s.vault)!;
  const notes = useApp((s) => s.notes);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const up = useUpcoming();
  const [refreshing, setRefreshing] = useState(false);
  const [connect, setConnect] = useState(false);
  const groups = useMemo(() => {
    const g = new Map<string, UpcomingMeeting[]>();
    for (const m of up.meetings) { const d = dayOf(m.start); g.set(d, [...(g.get(d) ?? []), m]); }
    return [...g.entries()];
  }, [up.meetings]);
  const refresh = async () => { setRefreshing(true); await loadUpcoming(vault, { refresh: true }).catch(() => null); setRefreshing(false); };
  return (
    <>
      <section className="mtv-section" aria-labelledby="mtv-coming">
        <div className="mtv-section-head">
          <h2 id="mtv-coming">Coming up</h2>
          {up.calendars > 0 && <IconButton label="Refresh calendars" onClick={() => void refresh()}><RefreshCw size={16} className={cx(refreshing && 'spin')} /></IconButton>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConnect((v) => !v)}><CalendarPlus size={15} /> {up.calendars ? 'Add calendar' : 'Connect calendar'}</button>
        </div>
        {connect && <ConnectCalendar onDone={() => { setConnect(false); void loadUpcoming(vault); }} />}
        {!up.calendars && !connect && <p className="mtv-empty">Connect your calendar to see meetings here, start notes for one in a tap with its attendees filled in, and get a brief before it starts.</p>}
        {up.calendars > 0 && !up.meetings.length && <p className="mtv-empty">No meetings in the next day and a half.</p>}
        {groups.map(([day, list]) => (
          <div key={day} className="mtv-day">
            <h3>{day}</h3>
            <ul className="mtv-list">
              {list.map((m) => <UpcomingRow key={m.key} m={m} note={noteForEvent(notes, m.key)} onStart={(record) => void startMeetingNote(vault, m, { record }).catch((e) => toast({ text: (e as Error).message, tone: 'error' }))} />)}
            </ul>
          </div>
        ))}
      </section>
      <section className="mtv-section" aria-labelledby="mtv-recent">
        <div className="mtv-section-head"><h2 id="mtv-recent">Recent meetings</h2></div>
        {!meetings.length && <p className="mtv-empty">Notes you record in, or start from a meeting, collect here.</p>}
        <ul className="mtv-list">
          {meetings.slice(0, 60).map((n) => <RecentRow key={n.id} n={n} onOpen={() => navigate({ name: 'editor', noteId: n.id })} />)}
        </ul>
      </section>
    </>
  );
}

function UpcomingRow({ m, note, onStart }: { m: UpcomingMeeting; note?: NoteMeta; onStart: (record: boolean) => void }) {
  const vault = useApp((s) => s.vault)!;
  const notes = useApp((s) => s.notes);
  const toast = useApp((s) => s.toast);
  const [brief, setBrief] = useState<{ html: string; done: boolean } | null>(null);
  const others = (m.attendees ?? []).filter((a) => !a.email || !useMeetingPrefs.getState().selfEmails.includes(a.email));
  const service = callService(m.link);
  const showBrief = async () => {
    if (brief) { setBrief(null); return; }
    setBrief({ html: '', done: false });
    try {
      const r = await writeBrief({ vault, title: m.title, at: m.start, attendees: others.map((a) => ({ name: a.name ?? a.email ?? 'Someone', ...(a.email ? { email: a.email } : {}) })), notes, onText: (t) => setBrief({ html: meetingReplyHtml(t, []), done: false }) });
      setBrief(r ? { html: meetingReplyHtml(r.text, r.meetings), done: true } : { html: '<p>No earlier meetings with these people yet.</p>', done: true });
    } catch (e) {
      setBrief(null);
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };
  return (
    <li className={cx('mtv-up', m.now && 'is-now')}>
      <div className="mtv-up-row">
        <span className="mtv-when"><strong>{timeOf(m.start)}</strong><small>{Math.round((m.end - m.start) / 60_000)} min</small></span>
        <span className="mtv-row-main">
          <strong>{m.title}</strong>
          <small>{[others.slice(0, 3).map((a) => a.name ?? a.email).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : ''), m.calendar].filter(Boolean).join(' · ')}</small>
        </span>
        <span className="mtv-up-actions">
          {m.link && <a className="btn btn-sm btn-ghost" href={m.link} target="_blank" rel="noopener noreferrer" aria-label={`Join${service ? ` on ${service}` : ''}`}><Video size={15} /></a>}
          {others.length > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => void showBrief()} aria-expanded={!!brief}><Sparkles size={14} /> Brief</button>}
          <button type="button" className={cx('btn btn-sm', m.now ? 'btn-primary' : '')} onClick={() => onStart(m.now)}>{note ? <><NotebookPen size={14} /> Open notes</> : m.now ? <><Mic size={14} /> Take notes</> : <><NotebookPen size={14} /> Prepare notes</>}</button>
        </span>
      </div>
      {brief && <div className="mtv-brief md" aria-live="polite">{brief.html ? <div dangerouslySetInnerHTML={{ __html: brief.html }} /> : <p className="mtg-status"><span className="dot-pulse" /> Reading your earlier meetings…</p>}</div>}
    </li>
  );
}

function RecentRow({ n, onOpen }: { n: NoteMeta; onOpen: () => void }) {
  const vault = useApp((s) => s.vault)!;
  const [tldr, setTldr] = useState<string | null>(null);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    let alive = true;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { void readMeetingNotes(vault, n.id).then((f) => alive && setTldr(currentMeetingNotes(f)?.tldr ?? '')); return () => { alive = false; }; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); void readMeetingNotes(vault, n.id).then((f) => alive && setTldr(currentMeetingNotes(f)?.tldr ?? '')); } });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [vault, n.id, n.updatedAt]);
  const at = n.meeting?.event?.start ?? n.createdAt;
  const who = (n.meeting?.attendees ?? []).map((a) => a.name);
  return (
    <li ref={ref} className="mtv-row is-link">
      <button type="button" className="mtv-row-btn" onClick={onOpen}>
        <span className="mtv-when"><strong>{new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</strong><small>{timeOf(at)}</small></span>
        <span className="mtv-row-main">
          <strong>{n.title}</strong>
          <small>{tldr || n.summary || (who.length ? `With ${who.slice(0, 3).join(', ')}${who.length > 3 ? '…' : ''}` : n.recordings?.length ? `${n.recordings.length} recording${n.recordings.length > 1 ? 's' : ''}` : '')}</small>
        </span>
        <ChevronRight size={16} aria-hidden />
      </button>
    </li>
  );
}

function ConnectCalendar({ onDone }: { onDone: () => void }) {
  const vault = useApp((s) => s.vault)!;
  const toast = useApp((s) => s.toast);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const addUrl = async () => {
    setBusy(true);
    try { await addCalendarUrl(vault, new URL(url.replace(/^webcals?:/i, 'https:')).host, url); toast({ text: 'Calendar added', tone: 'success' }); onDone(); }
    catch (e) { toast({ text: (e as Error).message, tone: 'error' }); }
    finally { setBusy(false); }
  };
  const addFile = async () => {
    const files = await pickFiles('.ics,text/calendar', false).catch(() => []);
    const f = files[0];
    if (!f) return;
    try { await importCalendarFile(vault, f.name, await f.text()); toast({ text: 'Calendar imported', tone: 'success' }); onDone(); }
    catch (e) { toast({ text: (e as Error).message, tone: 'error' }); }
  };
  return (
    <div className="mtv-connect">
      <p>Paste your calendar’s private address in iCal format (Google Calendar: Settings › your calendar › <em>Secret address in iCal format</em>; Outlook: Settings › Calendar › Shared calendars › <em>Publish a calendar</em>; iCloud: share as a public calendar). It stays on this device and is refreshed every few minutes.</p>
      <form onSubmit={(e) => { e.preventDefault(); void addUrl(); }} className="mtv-connect-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="Calendar address" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !/^(https|webcals?):\/\//i.test(url.trim())}>Add</button>
      </form>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void addFile()}>Or import an .ics file</button>
    </div>
  );
}

// ---- Ask across meetings --------------------------------------------------------------------------------

const RANGES: Array<{ id: string; label: string; days: number | null }> = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'All meetings', days: null },
];

function AskTab({ meetings, scope, onScope }: { meetings: NoteMeta[]; scope: { label: string; ids: string[] } | null; onScope: (s: { label: string; ids: string[] } | null) => void }) {
  const vault = useApp((s) => s.vault)!;
  const toast = useApp((s) => s.toast);
  const lib = useMeetingsLibrary((s) => s.library);
  const [range, setRange] = useState('30');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<{ title: string; text: string; used: NoteMeta[]; done: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const chosen = useMemo(() => {
    if (scope) return meetings.filter((m) => scope.ids.includes(m.id));
    const days = RANGES.find((r) => r.id === range)?.days;
    return days == null ? meetings : meetings.filter((m) => (m.meeting?.event?.start ?? m.createdAt) >= Date.now() - days * 86_400_000);
  }, [meetings, scope, range]);

  const go = async (recipe: Recipe) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const used = chosen.slice(0, 40);
    setResult({ title: recipe.name, text: '', used, done: false });
    try {
      const r = await runRecipe({ vault, recipe, notes: used, signal: ctrl.signal, onText: (t) => setResult({ title: recipe.name, text: t, used, done: false }) });
      setResult({ title: recipe.name, text: r.text, used, done: true });
    } catch (e) {
      if (!ctrl.signal.aborted) { toast({ text: (e as Error).message, tone: 'error' }); setResult(null); }
    }
  };
  const ask = () => {
    const q = question.trim();
    if (!q) return;
    void go({ id: 'question', name: q.length > 60 ? `${q.slice(0, 57)}…` : q, description: '', prompt: `Answer this question from the meetings: ${q}`, scope: 'many' });
  };
  const recipes = allRecipes(lib);
  return (
    <section className="mtv-section">
      <div className="mtv-scope">
        <span>Across</span>
        {scope ? (
          <button type="button" className="mtg-chip" onClick={() => onScope(null)} title="Use a time range instead">{scope.label} ✕</button>
        ) : (
          <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Which meetings">{RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
        )}
        <span className="mtv-count">{chosen.length} {chosen.length === 1 ? 'meeting' : 'meetings'}{chosen.length > 40 ? ' (newest 40 used)' : ''}</span>
      </div>
      <form className="mtg-ask mtv-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask anything: what did customers say about pricing?" aria-label="Ask across meetings" />
        <button type="submit" className="mtg-ask-send" disabled={!question.trim() || !chosen.length} aria-label="Ask"><Sparkles size={16} /></button>
      </form>
      {!result && (
        <ul className="mtg-recipes mtv-recipes">
          {recipes.map((r) => (
            <li key={r.id}>
              <button type="button" className="mtg-recipe" disabled={!chosen.length} onClick={() => void go(r)}>
                <span className="mtg-recipe-name">{r.name}{r.scope === 'meeting' && <em> · each meeting</em>}</span>
                <span className="mtg-recipe-desc">{r.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {result && (
        <article className="mtg-result mtv-result">
          <header>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { abort.current?.abort(); setResult(null); }}>← Recipes</button>
            <h3>{result.title}</h3>
          </header>
          {result.text ? <div className="md" dangerouslySetInnerHTML={{ __html: meetingReplyHtml(result.text.replace(/<think>[\s\S]*?(<\/think>|$)/g, ''), result.used) }} /> : <p className="mtg-status"><span className="dot-pulse" /> Reading {result.used.length} meetings…</p>}
          {result.done && <div className="mtg-bar"><button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(result.text).then(() => toast({ text: 'Copied' }))}>Copy</button></div>}
        </article>
      )}
      {!chosen.length && <p className="mtv-empty"><Users size={14} aria-hidden /> No meetings in this range yet.</p>}
    </section>
  );
}
