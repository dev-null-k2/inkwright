/**
 * People: who your notes and meeting transcripts mention, what you owe them and what they owe
 * you — a light personal CRM built from your own notes. Off until you allow it, because it makes
 * pages about real people; turning it off stops new person pages (existing ones stay as notes).
 */
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { anchorLink, extractActions, extractEntities, type SourceDoc } from '@inkwright/core';
import { useApp } from '../../state/app.ts';
import { Switch } from '../../ui/primitives.tsx';
import { Section } from '../../ui/agent/shared.tsx';
import { allDocs, setCompilerConfig, useCompiler } from '../service.ts';

interface Person {
  key: string;
  name: string;
  notes: Set<string>;
  actions: Array<{ text: string; due?: string; done: boolean; followUp: boolean; link: string; note: string }>;
}

function people(docs: SourceDoc[]): Person[] {
  const map = new Map<string, Person>();
  for (const d of docs) {
    if (d.tags.includes('compiled')) continue;
    for (const m of extractEntities(d)) {
      if (m.kind !== 'person') continue;
      const p = map.get(m.key) ?? { key: m.key, name: m.name, notes: new Set(), actions: [] };
      p.notes.add(d.noteId);
      map.set(m.key, p);
    }
  }
  for (const d of docs) {
    for (const a of extractActions(d)) {
      const who = a.followUp ? a.person : a.owner !== 'me' ? a.owner : undefined;
      if (!who) continue;
      const p = [...map.values()].find((x) => x.name === who || x.name.split(' ')[0] === who);
      const u = d.units.find((x) => x.id === a.unitId)!;
      p?.actions.push({ text: a.text, ...(a.due ? { due: a.due } : {}), done: a.done, followUp: a.followUp, note: d.title, link: anchorLink({ noteId: d.noteId, page: u.pageIndex, ...(u.rect ? { rect: u.rect } : {}), h: u.hash }) });
    }
  }
  return [...map.values()].sort((a, b) => b.notes.size - a.notes.size || a.name.localeCompare(b.name));
}

export function PeopleView() {
  const consent = useCompiler((s) => s.config.people);
  const version = useCompiler((s) => s.version);
  const pages = useCompiler((s) => s.pages);
  const navigate = useApp((s) => s.navigate);
  const [docs, setDocs] = useState<SourceDoc[] | null>(null);
  useEffect(() => { if (consent) void allDocs().then(setDocs); }, [consent, version]);
  const list = useMemo(() => (docs ? people(docs) : []), [docs]);
  return (
    <div className="ag-screen cp-people">
      <p className="ag-lead">People named in your notes and meeting transcripts, with the action items and follow-ups that mention them. Found on this device by simple rules (“call Priya”, “Sam to send…”, attendee lists).</p>
      <Switch label="Find people in my notes" hint="Also lets the compiled wiki make a page for each person. Nothing leaves this device." checked={consent} onChange={(v) => void setCompilerConfig({ people: v })} />
      {consent && (
        <Section title="People">
          {docs && !list.length && <p className="ag-empty">No people found yet.</p>}
          <ul className="ag-list">
            {list.map((p) => {
              const page = pages.find((x) => x.key === p.key);
              const open = p.actions.filter((a) => !a.done);
              return (
                <li key={p.key} className="ag-item cp-person">
                  <div className="ag-item-main">
                    <span className="ag-item-title">{p.name}</span>
                    <span className="muted small">{p.notes.size} {p.notes.size === 1 ? 'note' : 'notes'}{open.length ? ` · ${open.length} open` : ''}</span>
                    {open.length > 0 && (
                      <ul className="cp-actions">
                        {open.map((a, i) => <li key={i}><a href={a.link}>{a.followUp ? 'Follow up: ' : ''}{a.text}</a>{a.due ? <span className="muted small"> · by {a.due}</span> : null} <span className="muted small">({a.note})</span></li>)}
                      </ul>
                    )}
                  </div>
                  {page && <button type="button" className="btn btn-sm" onClick={() => navigate({ name: 'editor', noteId: page.noteId })}><ExternalLink size={13} /> Page</button>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}
