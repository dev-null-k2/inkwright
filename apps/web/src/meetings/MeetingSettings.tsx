import { useEffect, useState, type ReactNode } from 'react';
import { Bell, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { newId, type MeetingTemplate, type Recipe } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { Dialog, Switch } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { isDesktop } from '../desktop/bridge.ts';
import { isNative } from '../platform/env.ts';
import { INTEGRATIONS, connectedIntegrations, loadIntegration, saveIntegration, type IntegrationId } from './integrations.ts';
import { allRecipes, allTemplates, deleteFromLibrary, loadMeetingsLibrary, saveRecipe, saveTemplate, useMeetingPrefs, useMeetingsLibrary } from './store.ts';
import './meetings.css';

/** Settings › Knowledge › Meetings: how notes are enhanced, privacy, your templates and recipes, connections. */

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

export function MeetingSettings() {
  const vault = useApp((s) => s.vault);
  const prefs = useMeetingPrefs();
  const lib = useMeetingsLibrary((s) => s.library);
  const [emails, setEmails] = useState(prefs.selfEmails.join(', '));
  const [editTpl, setEditTpl] = useState<MeetingTemplate | null>(null);
  const [editRecipe, setEditRecipe] = useState<Recipe | null>(null);
  const [connected, setConnected] = useState<IntegrationId[]>([]);
  const [connect, setConnect] = useState<IntegrationId | null>(null);
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  useEffect(() => { if (vault) void loadMeetingsLibrary(vault); void connectedIntegrations().then(setConnected); }, [vault]);
  if (!vault) return null;
  const fail = (e: unknown) => useApp.getState().fail((e as Error)?.message ?? String(e));

  return (
    <div className="set-section">
      <Group title="Enhanced notes" note="Enhancing uses the AI chosen in Settings › AI. With the on-device model, nothing leaves this device.">
        <Switch label="Enhance notes when a recording ends" hint="Your notes plus what was said, shaped by the meeting’s template." checked={prefs.autoEnhance} onChange={(v) => prefs.set({ autoEnhance: v })} />
        <Switch label="Record the other side of calls" hint="When you record during a call, also capture the call’s sound (you choose the window or tab). No bot joins." checked={prefs.callAudio} onChange={(v) => prefs.set({ callAudio: v })} />
        <div className="field-row">
          <label className="row-text" htmlFor="mtg-self"><span className="row-label">Your email addresses</span><span className="row-hint">Left out of attendee lists; your company isn’t listed under Companies.</span></label>
          <input id="mtg-self" className="mtg-set-input" value={emails} placeholder="you@company.com" onChange={(e) => setEmails(e.target.value)} onBlur={() => prefs.set({ selfEmails: emails.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x)) })} />
        </div>
      </Group>

      <Group title="Privacy" note="Deleting audio can’t be undone. The transcript, your notes and the link between ink and what was said stay.">
        <Switch label="Keep audio after transcribing" hint="Off: each recording’s audio is deleted once its transcript is saved, like Granola." checked={prefs.keepAudio} onChange={(v) => void (async () => { if (!v && !(await askConfirm('Delete audio after transcribing?', 'From now on, a recording’s audio is deleted from this vault as soon as its transcript is saved. Recordings without a transcript keep their audio.', 'Delete after transcribing', true))) return; prefs.set({ keepAudio: v }); })()} />
      </Group>

      <Group title="Reminders" note="Meetings come from the calendars you add in Meetings › Connect calendar.">
        <div className="field-row">
          <span className="row-label">Remind before meetings</span>
          <select value={prefs.remindMinutes} onChange={(e) => prefs.set({ remindMinutes: Number(e.target.value) })} aria-label="Remind before meetings">
            <option value={0}>Off</option><option value={1}>1 minute before</option><option value={2}>2 minutes before</option><option value={5}>5 minutes before</option><option value={10}>10 minutes before</option>
          </select>
        </div>
        {notif !== 'granted' && typeof Notification !== 'undefined' && notif !== 'denied' && (
          <div className="row-buttons"><button type="button" className="btn btn-sm" onClick={() => void Notification.requestPermission().then(setNotif)}><Bell size={15} /> Allow notifications</button></div>
        )}
      </Group>

      <Group title="Templates" note="A template is the shape of enhanced notes: its sections and what goes in each. Words in a meeting’s title can pick it automatically.">
        <ul className="mtg-set-list">
          {allTemplates(lib).map((t) => (
            <li key={t.id}>
              <span className="row-text"><span className="row-label">{t.name}</span><span className="row-hint">{t.sections.map((s) => s.heading).join(' · ')}</span></span>
              {t.builtIn ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditTpl({ ...t, id: newId(), name: `${t.name} (mine)`, builtIn: undefined })}>Copy</button> : (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Edit ${t.name}`} onClick={() => setEditTpl(t)}><Pencil size={14} /></button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Delete ${t.name}`} onClick={() => void deleteFromLibrary(vault, t.id).catch(fail)}><Trash2 size={14} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="row-buttons"><button type="button" className="btn btn-sm" onClick={() => setEditTpl({ id: newId(), name: '', description: '', sections: [{ heading: 'Discussion', guide: '' }, { heading: 'Action items', guide: 'Next steps with owners', actions: true }] })}><Plus size={15} /> New template</button></div>
      </Group>

      <Group title="Recipes" note="A recipe is a saved prompt you run on a meeting (in its Meeting panel) or across meetings (Meetings › Ask).">
        <ul className="mtg-set-list">
          {allRecipes(lib).map((r) => (
            <li key={r.id}>
              <span className="row-text"><span className="row-label">{r.name}</span><span className="row-hint">{r.scope === 'many' ? 'Across meetings · ' : ''}{r.description}</span></span>
              {r.builtIn ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditRecipe({ ...r, id: newId(), name: `${r.name} (mine)`, builtIn: undefined })}>Copy</button> : (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Edit ${r.name}`} onClick={() => setEditRecipe(r)}><Pencil size={14} /></button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Delete ${r.name}`} onClick={() => void deleteFromLibrary(vault, r.id).catch(fail)}><Trash2 size={14} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="row-buttons"><button type="button" className="btn btn-sm" onClick={() => setEditRecipe({ id: newId(), name: '', description: '', prompt: '', scope: 'meeting' })}><Plus size={15} /> New recipe</button></div>
      </Group>

      <Group title="Connections" note={<>Tokens and webhook addresses stay in this device’s encrypted secret store; they are never synced. Nothing is sent until you press Send in Share.{!isNative && !isDesktop ? ' In a browser, some services only work from the desktop and mobile apps (marked).' : ''}</>}>
        <ul className="mtg-set-list">
          {INTEGRATIONS.map((i) => (
            <li key={i.id}>
              <span className="row-text"><span className="row-label">{i.name}</span><span className="row-hint">{i.does}{!i.web && !isNative && !isDesktop ? ' Desktop and mobile apps.' : ''}</span></span>
              {connected.includes(i.id) ? (
                <>
                  <span className="mtg-set-ok">Connected</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void saveIntegration(i.id, null).then(() => connectedIntegrations().then(setConnected))}>Disconnect</button>
                </>
              ) : <button type="button" className="btn btn-sm" onClick={() => setConnect(i.id)}><Plug size={14} /> Connect</button>}
            </li>
          ))}
        </ul>
      </Group>

      {editTpl && <TemplateEditor t={editTpl} onClose={() => setEditTpl(null)} onSave={(t) => void saveTemplate(vault, t).then(() => setEditTpl(null)).catch(fail)} />}
      {editRecipe && <RecipeEditor r={editRecipe} onClose={() => setEditRecipe(null)} onSave={(r) => void saveRecipe(vault, r).then(() => setEditRecipe(null)).catch(fail)} />}
      {connect && <ConnectDialog id={connect} onClose={() => setConnect(null)} onSaved={() => { setConnect(null); void connectedIntegrations().then(setConnected); }} />}
    </div>
  );
}

function TemplateEditor({ t, onClose, onSave }: { t: MeetingTemplate; onClose: () => void; onSave: (t: MeetingTemplate) => void }) {
  const [v, setV] = useState(t);
  const ok = v.name.trim() && v.sections.some((s) => s.heading.trim());
  return (
    <Dialog open wide title={t.name ? `Template: ${t.name}` : 'New template'} onClose={onClose} actions={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!ok} onClick={() => onSave({ ...v, sections: v.sections.filter((s) => s.heading.trim()) })}>Save</button></>}>
      <div className="mtg-edit">
        <label>Name<input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Pipeline review" /></label>
        <label>What it’s for<input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="Weekly deal review with the sales team" /></label>
        <label>Pick it for meetings whose title has<input value={v.match ?? ''} onChange={(e) => setV({ ...v, match: e.target.value || undefined })} placeholder="pipeline|forecast" /></label>
        <fieldset>
          <legend>Sections</legend>
          {v.sections.map((s, i) => (
            <div key={i} className="mtg-edit-sec">
              <input aria-label="Section heading" value={s.heading} onChange={(e) => setV({ ...v, sections: v.sections.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)) })} placeholder="Heading" />
              <input aria-label="What goes in it" value={s.guide} onChange={(e) => setV({ ...v, sections: v.sections.map((x, j) => (j === i ? { ...x, guide: e.target.value } : x)) })} placeholder="What goes in it" />
              <label className="mtg-edit-check"><input type="checkbox" checked={!!s.actions} onChange={(e) => setV({ ...v, sections: v.sections.map((x, j) => (j === i ? { ...x, actions: e.target.checked || undefined } : x)) })} /> Action items</label>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove section" onClick={() => setV({ ...v, sections: v.sections.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setV({ ...v, sections: [...v.sections, { heading: '', guide: '' }] })}><Plus size={14} /> Add section</button>
        </fieldset>
        <label>Anything else the AI should know<textarea rows={3} value={v.context ?? ''} onChange={(e) => setV({ ...v, context: e.target.value || undefined })} placeholder="Use MEDDIC terms. Always note the next meeting date." /></label>
      </div>
    </Dialog>
  );
}

function RecipeEditor({ r, onClose, onSave }: { r: Recipe; onClose: () => void; onSave: (r: Recipe) => void }) {
  const [v, setV] = useState(r);
  const ok = v.name.trim() && v.prompt.trim();
  return (
    <Dialog open wide title={r.name ? `Recipe: ${r.name}` : 'New recipe'} onClose={onClose} actions={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!ok} onClick={() => onSave(v)}>Save</button></>}>
      <div className="mtg-edit">
        <label>Name<input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Board update" /></label>
        <label>What it does<input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="A short update for the board from this week’s meetings" /></label>
        <label>Runs on
          <select value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value === 'many' ? 'many' : 'meeting' })}><option value="meeting">One meeting</option><option value="many">Several meetings</option></select>
        </label>
        <label>Instructions<textarea rows={6} value={v.prompt} onChange={(e) => setV({ ...v, prompt: e.target.value })} placeholder="Write a five-bullet board update: progress, numbers, risks, asks. Plain language." /></label>
      </div>
    </Dialog>
  );
}

function ConnectDialog({ id, onClose, onSaved }: { id: IntegrationId; onClose: () => void; onSaved: () => void }) {
  const spec = INTEGRATIONS.find((i) => i.id === id)!;
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => { void loadIntegration(id).then((v) => v && setValues(v)); }, [id]);
  const ok = spec.fields.every((f) => (values[f.key] ?? '').trim());
  return (
    <Dialog open title={`Connect ${spec.name}`} onClose={onClose} actions={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!ok} onClick={() => void saveIntegration(id, values).then(onSaved)}>Connect</button></>}>
      <div className="mtg-edit">
        <p className="mtg-hint">{spec.help}</p>
        {spec.fields.map((f) => (
          <label key={f.key}>{f.label}
            <input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          </label>
        ))}
      </div>
    </Dialog>
  );
}
