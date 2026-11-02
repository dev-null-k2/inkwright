/**
 * "Teach me back": a tutor that asks you to explain what is in a notebook (or a note), checks
 * your answer against the sources, names what you left out, and flags where your answer — or your
 * own notes — contradict the sources (lecture recordings and imported PDFs count as sources;
 * what you wrote counts as your notes).
 */
import { useEffect, useRef, useState } from 'react';
import { PenLine, Type, X } from 'lucide-react';
import { gradeTeachBack, tutorQuestions, type TutorQuestion, type TutorVerdict } from '@inkwright/ai';
import { detectConflicts, extractClaims, parseAnchor, stripMarkdown, unitAnchor, type Conflict, type SourceUnit } from '@inkwright/core';
import { IconButton, cx } from '../../ui/primitives.tsx';
import { useApp } from '../../state/app.ts';
import { allDocs, compilerAI, compilerStore, unitById } from '../service.ts';
import { readHandwrittenAnswer } from '../study.ts';
import { InkPad, type InkPadApi } from './Review.tsx';
import { SourceCard } from './Explain.tsx';

const isSource = (u: SourceUnit) => u.kind === 'pdf' || u.kind === 'speech';

export function TutorScreen({ init, onClose }: { init: { noteIds: string[]; title: string }; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [units, setUnits] = useState<SourceUnit[] | null>(null);
  const [notesVsSources, setNotesVsSources] = useState<Conflict[]>([]);
  const [questions, setQuestions] = useState<TutorQuestion[] | null>(null);
  const [by, setBy] = useState('');
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState('');
  const [mode, setMode] = useState<'type' | 'write'>('type');
  const [verdict, setVerdict] = useState<TutorVerdict | null>(null);
  const [results, setResults] = useState<TutorVerdict[]>([]);
  const [busy, setBusy] = useState(false);
  const pad = useRef<InkPadApi | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const docs = (await allDocs()).filter((d) => init.noteIds.includes(d.noteId));
        const all = docs.flatMap((d) => d.units);
        setUnits(all);
        // Where what you wrote disagrees with a recording or an imported PDF.
        const conflicts = detectConflicts(docs.flatMap((d) => extractClaims(d)));
        setNotesVsSources(conflicts.filter((c) => { const a = unitById(c.a.unitId), b = unitById(c.b.unitId); return !!a && !!b && isSource(a) !== isSource(b); }));
        const ai = await compilerAI(await compilerStore().config());
        const q = await tutorQuestions(ai, all, { count: 5 });
        setQuestions(q.questions);
        setBy(q.byModel && ai ? ai.label : 'the rules (no AI)');
      } catch (e) {
        toast({ text: (e as Error).message, tone: 'error' });
        setQuestions([]);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const q = questions?.[i];
  const check = async () => {
    if (!q || !units) return;
    setBusy(true);
    try {
      let text = answer;
      if (mode === 'write' && pad.current?.strokes().length) {
        const read = await readHandwrittenAnswer(pad.current.strokes(), () => pad.current!.png());
        if (read) { text = read.text; setAnswer(read.text); }
      }
      const ai = await compilerAI(await compilerStore().config());
      const v = await gradeTeachBack(ai, q, text, units);
      setVerdict(v);
      setResults((r) => [...r, v]);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };
  const next = () => { setVerdict(null); setAnswer(''); pad.current?.clear(); setI((x) => x + 1); };

  return (
    <div className="cp-review" role="dialog" aria-modal="true" aria-label="Teach me back">
      <header className="cp-review-head">
        <h2>Teach me back</h2>
        <span className="muted">{init.title}</span>
        <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
      </header>
      {!questions && <p className="muted cp-review-empty">Reading your notes…</p>}
      {questions && !questions.length && <p className="cp-review-empty">Nothing to ask about yet: these notes have no typed or recognized text.</p>}
      {notesVsSources.length > 0 && i === 0 && !verdict && (
        <section className="cp-card cp-contra" aria-label="Your notes disagree with the sources">
          <h3>Your notes disagree with the sources</h3>
          {notesVsSources.slice(0, 3).map((c) => <p key={c.id}>You wrote “{stripMarkdown(isSource(unitById(c.a.unitId)!) ? c.b.text : c.a.text)}” — the source says “{stripMarkdown(isSource(unitById(c.a.unitId)!) ? c.a.text : c.b.text)}”.</p>)}
        </section>
      )}
      {q && (
        <article className="cp-card">
          <span className="cp-card-deck">Question {i + 1} of {questions!.length} · asked by {by}</span>
          <p className="cp-card-q">{q.q}</p>
          {!verdict && (
            <div className="cp-answer">
              <div className="cp-answer-mode" role="group" aria-label="Answer with">
                <button type="button" className={cx('chip', mode === 'type' && 'is-on')} aria-pressed={mode === 'type'} onClick={() => setMode('type')}><Type size={14} /> Type</button>
                <button type="button" className={cx('chip', mode === 'write' && 'is-on')} aria-pressed={mode === 'write'} onClick={() => setMode('write')}><PenLine size={14} /> Write</button>
              </div>
              {mode === 'type' ? <textarea className="cp-answer-text" rows={3} aria-label="Your explanation" placeholder="Explain it in your own words" value={answer} onChange={(e) => setAnswer(e.target.value)} /> : <InkPad apiRef={pad} />}
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check my answer'}</button>
            </div>
          )}
          {verdict && (
            <div className="cp-reveal">
              <p className={cx('cp-grade', verdict.verdict === 'right' ? 'is-good' : 'is-miss')}>{verdict.verdict === 'right' ? 'Right.' : verdict.verdict === 'partly' ? 'Partly right.' : 'Not quite.'} {verdict.feedback}</p>
              {verdict.gaps.length > 0 && <ul className="cp-gaps">{verdict.gaps.map((g, k) => <li key={k}>{g}</li>)}</ul>}
              {verdict.contradictions.map((c, k) => <p key={k} className="cp-grade is-miss">You said “{c.says}”; your notes say “{c.sourceSays}”.</p>)}
              <p className="muted small">A full answer: {q.expected}</p>
              <ul className="cp-sources">{q.unitIds.map((id) => { const u = units?.find((x) => x.id === id); const a = u ? parseAnchor(unitAnchor(u)) : null; return a ? <SourceCard key={id} anchor={a} /> : null; })}</ul>
              <button type="button" className="btn btn-primary" onClick={next}>{i + 1 < questions!.length ? 'Next question' : 'Finish'}</button>
            </div>
          )}
        </article>
      )}
      {questions && questions.length > 0 && i >= questions.length && (
        <div className="cp-review-empty">
          <p className="cp-review-done">{results.filter((r) => r.verdict === 'right').length} of {results.length} right.</p>
          {results.some((r) => r.gaps.length) && <ul className="cp-gaps">{[...new Set(results.flatMap((r) => r.gaps))].slice(0, 8).map((g) => <li key={g}>{g}</li>)}</ul>}
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
