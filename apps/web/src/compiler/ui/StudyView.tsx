/**
 * Study: flashcard decks made from your notes (each card linked to the place it came from),
 * what is due, and the way into Review and "Teach me back".
 */
import { useEffect, useState } from 'react';
import { BookOpenCheck, GraduationCap, Trash2 } from 'lucide-react';
import { retrievability } from '@inkstone/core';
import { useApp } from '../../state/app.ts';
import { IconButton } from '../../ui/primitives.tsx';
import { Section } from '../../ui/agent/shared.tsx';
import { askConfirm } from '../../ui/prompts.tsx';
import { deckFromNote, deckStats, deleteDeck, dueNow, refreshDecks, useStudy } from '../study.ts';
import { openReview, openTutor } from './dialogs.tsx';

export function StudyView() {
  const decks = useStudy((s) => s.decks);
  const notes = useApp((s) => s.notes);
  const notebooks = useApp((s) => s.notebooks);
  const toast = useApp((s) => s.toast);
  const [pick, setPick] = useState('');
  const [nb, setNb] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void refreshDecks().catch(() => {}); }, []);
  const now = Date.now();
  const due = dueNow(decks, now).length;
  const make = async () => {
    setBusy(true);
    try {
      const r = await deckFromNote(pick);
      toast({ text: `${r.added} new ${r.added === 1 ? 'card' : 'cards'}${r.byModel ? '' : ' (made by the rules: no AI)'}` });
      setPick('');
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };
  return (
    <div className="ag-screen cp-study">
      <p className="ag-lead">Flashcards from your own notes, scheduled with FSRS so you see each card just before you would forget it. Answer by typing or by writing; every card links back to where it came from.</p>
      <div className="cp-compile">
        <button type="button" className="btn btn-primary" onClick={() => openReview()}><BookOpenCheck size={15} /> Review{due ? ` (${due} due)` : ''}</button>
      </div>
      <Section title="Teach me back" note="A tutor asks you to explain a notebook, then points out gaps and where you (or your notes) disagree with the sources.">
        <div className="cp-add-sources">
          <select aria-label="Notebook to be quizzed on" value={nb} onChange={(e) => setNb(e.target.value)}>
            <option value="">Choose a notebook…</option>
            {notebooks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
          <button type="button" className="btn btn-sm" disabled={!nb} onClick={() => openTutor({ noteIds: notes.filter((n) => n.notebookId === nb).map((n) => n.id), title: notebooks.find((n) => n.id === nb)?.name ?? '' })}><GraduationCap size={14} /> Start</button>
        </div>
      </Section>
      <Section title="Decks">
        {!decks.length && <p className="ag-empty">No decks yet. Make one from a note below, from a selection (lasso, then Study in the ••• menu) or from a compiled page.</p>}
        <ul className="ag-list">
          {decks.map((d) => {
            const st = deckStats(d, now);
            const learned = d.cards.filter((c) => c.mem.state === 2);
            const recall = learned.length ? learned.reduce((s, c) => s + retrievability(c, now), 0) / learned.length : null;
            return (
              <li key={d.id} className="ag-item">
                <div className="ag-item-main">
                  <span className="ag-item-title">{d.title}</span>
                  <span className="muted small">{st.total} {st.total === 1 ? 'card' : 'cards'} · {st.due} due · {st.fresh} new{recall != null ? ` · recall now ≈ ${Math.round(recall * 100)}%` : ''}</span>
                </div>
                <div className="ag-row-acts">
                  <button type="button" className="btn btn-sm" onClick={() => openReview({ deckId: d.id })}>Review</button>
                  <IconButton label={`Delete deck ${d.title}`} onClick={async () => { if (await askConfirm('Delete this deck?', 'Its cards and review history are removed. Your notes stay.', 'Delete', true)) await deleteDeck(d.id); }}><Trash2 size={15} /></IconButton>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="cp-add-sources">
          <select aria-label="Note to make cards from" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Make cards from a note…</option>
            {notes.filter((n) => !n.lock && !n.tags.includes('compiled')).map((n) => <option key={n.id} value={n.id}>{n.title || 'Untitled'}</option>)}
          </select>
          <button type="button" className="btn btn-sm" disabled={!pick || busy} onClick={() => void make()}>{busy ? 'Writing cards…' : 'Make cards'}</button>
        </div>
      </Section>
    </div>
  );
}
