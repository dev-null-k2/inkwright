/**
 * Memory: standing instructions you write and facts the assistant proposed and you approved.
 * Everything here goes into every conversation and routine; proposals do nothing until accepted.
 */
import { useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import type { MemoryItem, MemoryKind } from '@inkstone/ai';
import { requireHub, useAgent } from '../../lib/agent/hub.ts';
import { IconButton, Segmented } from '../primitives.tsx';
import { Section } from './shared.tsx';

export function MemoryView() {
  const items = useAgent((s) => s.memory);
  const [kind, setKind] = useState<MemoryKind>('instruction');
  const [text, setText] = useState('');
  const proposed = items.filter((i) => i.status === 'proposed');
  const instructions = items.filter((i) => i.status === 'active' && i.kind === 'instruction');
  const facts = items.filter((i) => i.status === 'active' && i.kind === 'fact');
  const add = async () => {
    if (!text.trim()) return;
    await requireHub().memory.add(kind, text);
    setText('');
  };
  return (
    <div className="ag-screen">
      <p className="ag-lead">What the assistant keeps in mind in every conversation and routine. It can suggest things to remember; nothing is kept until you accept it. Memory syncs with your notes.</p>
      {proposed.length > 0 && (
        <Section title="Suggested by the assistant">
          <ul className="ag-list">{proposed.map((i) => <MemoryRow key={i.id} item={i} />)}</ul>
        </Section>
      )}
      <form className="ag-memory-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: 'instruction', label: 'Instruction' }, { value: 'fact', label: 'About me' }]} />
        <div className="ag-url-form">
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} aria-label="Something to remember" placeholder={kind === 'instruction' ? 'Always answer in bullet points' : 'I’m studying electrical engineering'} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim()}>Add</button>
        </div>
      </form>
      <Section title="Instructions">
        {!instructions.length && <p className="ag-empty">How you want the assistant to answer, e.g. “Reply in German”.</p>}
        <ul className="ag-list">{instructions.map((i) => <MemoryRow key={i.id} item={i} />)}</ul>
      </Section>
      <Section title="About you">
        {!facts.length && <p className="ag-empty">Things that help it help you, e.g. what you study or work on.</p>}
        <ul className="ag-list">{facts.map((i) => <MemoryRow key={i.id} item={i} />)}</ul>
      </Section>
    </div>
  );
}

export function MemoryRow({ item, compact }: { item: MemoryItem; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const m = () => requireHub().memory;
  if (editing) {
    return (
      <li className="ag-item">
        <form className="ag-url-form" onSubmit={(e) => { e.preventDefault(); void (item.status === 'proposed' ? m().accept(item.id, text) : m().update(item.id, { text })).then(() => setEditing(false)); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} aria-label="Edit memory" autoFocus />
          <button type="submit" className="btn btn-sm btn-primary">Save</button>
          <button type="button" className="btn btn-sm" onClick={() => { setText(item.text); setEditing(false); }}>Cancel</button>
        </form>
      </li>
    );
  }
  return (
    <li className="ag-item ag-memory">
      <div className="ag-item-main">
        <span>{item.text}</span>
        {item.status === 'proposed' && !compact && item.reason && <span className="muted small">{item.reason}</span>}
      </div>
      <div className="ag-row-acts">
        {item.status === 'proposed' ? (
          <>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void m().accept(item.id)}><Check size={14} /> Remember</button>
            <IconButton label="Edit before remembering" onClick={() => setEditing(true)}><Pencil size={14} /></IconButton>
            <IconButton label="Don’t remember" onClick={() => void m().remove(item.id)}><X size={15} /></IconButton>
          </>
        ) : (
          <>
            <IconButton label="Edit" onClick={() => setEditing(true)}><Pencil size={14} /></IconButton>
            <IconButton label="Forget" onClick={() => void m().remove(item.id)}><Trash2 size={14} /></IconButton>
          </>
        )}
      </div>
    </li>
  );
}
