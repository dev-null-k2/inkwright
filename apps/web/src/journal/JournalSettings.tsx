import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CalendarPlus, FileUp, PenLine, RefreshCw } from 'lucide-react';
import { ROUTINE_TEMPLATES, describeTrigger } from '@inkwright/ai';
import { useApp } from '../state/app.ts';
import { Segmented, Switch } from '../ui/primitives.tsx';
import { useModule } from '../modules/registry.ts';
import { agentHub, useAgent } from '../lib/agent/hub.ts';
import '../recall/recall.css';
import { addCalendarUrl, importCalendarFile, loadJournalConfig, refreshCalendars, removeCalendar, saveJournalConfig, useJournal } from './config.ts';

/** Settings › Journal: the evening routine, how the draft is written, and imported calendars. */

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

const TEMPLATE = 'daily-journal';

export function JournalSettings() {
  const vault = useApp((s) => s.vault);
  const { config, loaded } = useJournal();
  const routines = useAgent((s) => s.routines);
  const timelineOn = useModule('memory-timeline');
  const routine = routines.find((r) => r.template === TEMPLATE) ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [calName, setCalName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (vault) void loadJournalConfig(vault); }, [vault]);
  if (!vault || !loaded) return null;
  const fail = (e: unknown) => useApp.getState().fail((e as Error)?.message ?? String(e));
  const save = (patch: Parameters<typeof saveJournalConfig>[1]) => void saveJournalConfig(vault, patch).catch(fail);

  const setUp = async () => {
    const hub = agentHub();
    if (!hub) return fail(new Error('Turn on Assistant & routines in Settings › Modules first.'));
    const t = ROUTINE_TEMPLATES.find((x) => x.id === TEMPLATE)!;
    await hub.routines.save(t.build());
    useApp.getState().toast({ text: 'Your journal will be drafted every evening at 21:30.' });
  };
  const setTime = async (time: string) => {
    const hub = agentHub();
    if (!hub || !routine || !/^\d{2}:\d{2}$/.test(time)) return;
    await hub.routines.save({ ...routine, triggers: [{ kind: 'daily', time }], updatedAt: Date.now() });
  };
  const draftNow = async () => {
    setBusy('draft');
    try {
      const hub = agentHub();
      if (!hub) throw new Error('Turn on Assistant & routines in Settings › Modules first.');
      let r = routine;
      if (!r) { r = ROUTINE_TEMPLATES.find((x) => x.id === TEMPLATE)!.build(); r = { ...r, enabled: false }; await hub.routines.save(r); }
      const { runRoutineNow } = await import('../lib/agent/routines.ts');
      await runRoutineNow(r.id);
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const importFile = async (f: File) => {
    setBusy('file');
    try {
      const ref = await importCalendarFile(vault, f.name, await f.text());
      useApp.getState().toast({ text: `Imported “${ref.name}” (${ref.events} ${ref.events === 1 ? 'event' : 'events'}).` });
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const addUrl = async () => {
    setBusy('url');
    try {
      const ref = await addCalendarUrl(vault, calName, url);
      setUrl('');
      setCalName('');
      useApp.getState().toast({ text: `Subscribed to “${ref.name}” (${ref.events} ${ref.events === 1 ? 'event' : 'events'}).` });
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const trigger = routine?.triggers.find((t) => t.kind === 'daily') as { kind: 'daily'; time: string } | undefined;

  return (
    <>
      <Group
        title="Every evening"
        note="The draft uses only what your day holds: what you wrote that day, what was said in your recordings, your calendar and — if you allow it — the memory timeline. Every sentence cites its sources; anything the sources don’t back is left out. Notes in local-only or hidden notebooks are not used, because the AI that writes the draft may be a cloud model."
      >
        {routine ? (
          <>
            <div className="field-row">
              <span className="row-label">{routine.enabled && trigger ? describeTrigger(trigger) : 'The evening routine is switched off (Assistant › Routines)'}</span>
              {trigger && <input type="time" aria-label="Draft time" value={trigger.time} onChange={(e) => void setTime(e.target.value)} />}
            </div>
          </>
        ) : (
          <div className="field-row">
            <span className="row-label">Draft my journal each evening</span>
            <button type="button" className="btn btn-sm" onClick={() => void setUp().catch(fail)}>Set up</button>
          </div>
        )}
        <div className="row-buttons">
          <button type="button" className="btn btn-sm" disabled={busy === 'draft'} onClick={() => void draftNow()}><PenLine size={15} aria-hidden /> {busy === 'draft' ? 'Drafting…' : 'Draft today now'}</button>
        </div>
      </Group>

      <Group title="How it is written" note="AI handwriting is marked as AI ink: authorship certificates never count it as yours. Correct it with your pen, or erase what isn’t right.">
        <div className="field-row">
          <span className="row-label">Write the draft</span>
          <Segmented label="Write the draft" value={config.style} onChange={(v) => save({ style: v })} options={[{ value: 'ink', label: 'In handwriting' }, { value: 'typed', label: 'As typed text' }]} />
        </div>
        {config.style === 'ink' && (
          <div className="field-row">
            <span className="row-label">Handwriting style</span>
            <Segmented label="Handwriting style" value={config.hand} onChange={(v) => save({ hand: v })} options={[{ value: 'script', label: 'Joined' }, { value: 'print', label: 'Print' }]} />
          </div>
        )}
        {timelineOn && <Switch label="Use the memory timeline" hint="Redacted screen text from that day goes to the AI that writes the draft." checked={config.includeTimeline} onChange={(v) => save({ includeTimeline: v })} />}
      </Group>

      <Group title="Calendars" note="Import a calendar’s .ics file, or add its address (Google Calendar: Settings › your calendar › Secret address in iCal format). The address is kept encrypted on this device only; the events are kept in ai/journal/ in your vault.">
        {config.calendars.length > 0 && (
          <ul className="jr-cals">
            {config.calendars.map((c) => (
              <li key={c.id}>
                <span className="row-text"><span className="row-label">{c.name}</span><span className="row-hint">{c.events} {c.events === 1 ? 'event' : 'events'} · {c.source === 'url' ? `subscribed (${c.host})` : 'imported file'} · {new Date(c.updatedAt).toLocaleDateString()}</span></span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeCalendar(vault, c.id).catch(fail)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <div className="row-buttons">
          <button type="button" className="btn btn-sm" disabled={busy === 'file'} onClick={() => fileRef.current?.click()}><FileUp size={15} aria-hidden /> Import .ics file</button>
          {config.calendars.some((c) => c.source === 'url') && <button type="button" className="btn btn-sm" onClick={() => void refreshCalendars(vault).then((r) => useApp.getState().toast({ text: r.failed.length ? `Couldn’t refresh ${r.failed.join(', ')}.` : `Refreshed ${r.refreshed} ${r.refreshed === 1 ? 'calendar' : 'calendars'}.`, tone: r.failed.length ? 'error' : 'info' })).catch(fail)}><RefreshCw size={15} aria-hidden /> Refresh</button>}
          <input ref={fileRef} type="file" accept=".ics,text/calendar" hidden aria-label="Calendar file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        </div>
        <form className="rc-set-add" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void addUrl(); }}>
          <input value={calName} onChange={(e) => setCalName(e.target.value)} placeholder="Name" aria-label="Calendar name" className="jr-cal-name" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or webcal://…" aria-label="Calendar address" inputMode="url" />
          <button type="submit" className="btn btn-sm" disabled={!url.trim() || busy === 'url'}><CalendarPlus size={15} aria-hidden /> Add</button>
        </form>
      </Group>
    </>
  );
}
