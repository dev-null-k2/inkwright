/**
 * Review: one card at a time on a calm sheet. Answer by typing or by writing with the pen (read
 * on the device when it can, else by the AI's vision), then "Show answer": your answer is graded,
 * the card's source is shown (with a picture of where it came from), and you rate it — the four
 * FSRS buttons say when the card comes back. Keyboard: Space shows the answer, 1–4 rate, Esc
 * closes; typing in the answer box is never taken for a shortcut.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, PenLine, Type, X } from 'lucide-react';
import { RATING_LABEL, formatInterval, newId, parseAnchor, previewIntervals, type InkStroke, type StudyCard, type StudyDeck } from '@inkstone/core';
import { IconButton, cx } from '../../ui/primitives.tsx';
import { useApp } from '../../state/app.ts';
import { dueNow, gradeCard, readHandwrittenAnswer, refreshDecks, review, useStudy } from '../study.ts';
import { SourceCard } from './Explain.tsx';

type Grade = Awaited<ReturnType<typeof gradeCard>>;

export function ReviewScreen({ deckId, onClose }: { deckId?: string; onClose: () => void }) {
  const decks = useStudy((s) => s.decks);
  const [cram, setCram] = useState(false);
  const [queue, setQueue] = useState<Array<{ deck: StudyDeck; card: StudyCard }> | null>(null);
  const [i, setI] = useState(0);
  const [done, setDone] = useState(0);
  useEffect(() => { void refreshDecks(); }, []);
  // The queue is fixed when the session starts, so a card rated "Again" waits for the next session.
  useEffect(() => {
    if (queue || !useStudy.getState().loaded) return;
    const pool = decks.filter((d) => !deckId || d.id === deckId);
    const due = dueNow(pool);
    setQueue(cram && !due.length ? pool.flatMap((d) => d.cards.filter((c) => !c.suspended).map((card) => ({ deck: d, card }))) : due);
  }, [decks, deckId, cram, queue]);
  const item = queue?.[i];
  return (
    <div className="cp-review" role="dialog" aria-modal="true" aria-label="Review">
      <header className="cp-review-head">
        <h2>Review</h2>
        {queue && queue.length > 0 && <span className="muted">{Math.min(i + 1, queue.length)} of {queue.length}</span>}
        <IconButton label="Close review" onClick={onClose}><X size={18} /></IconButton>
      </header>
      {!queue && <p className="muted cp-review-empty">Loading cards…</p>}
      {queue && !item && (
        <div className="cp-review-empty">
          <p className="cp-review-done">{done ? `Done for now: ${done} ${done === 1 ? 'card' : 'cards'} reviewed.` : 'Nothing is due.'}</p>
          {!done && decks.some((d) => (!deckId || d.id === deckId) && d.cards.length) && <button type="button" className="btn" onClick={() => { setCram(true); setQueue(null); setI(0); }}>Review all cards anyway</button>}
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      )}
      {item && <CardSheet key={`${item.card.id}-${i}`} deck={item.deck} card={item.card} onRated={() => { setDone((d) => d + 1); setI((x) => x + 1); }} />}
    </div>
  );
}

function CardSheet({ deck, card, onRated }: { deck: StudyDeck; card: StudyCard; onRated: () => void }) {
  const toast = useApp((s) => s.toast);
  const [mode, setMode] = useState<'type' | 'write'>('type');
  const [answer, setAnswer] = useState('');
  const [shown, setShown] = useState(false);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [busy, setBusy] = useState(false);
  const pad = useRef<InkPadApi | null>(null);
  const intervals = useMemo(() => previewIntervals(card, Date.now()), [card]);
  const anchor = card.src ? parseAnchor(card.src) : null;

  const reveal = async () => {
    if (shown || busy) return;
    setBusy(true);
    try {
      let text = answer;
      if (mode === 'write' && pad.current?.strokes().length) {
        const read = await readHandwrittenAnswer(pad.current.strokes(), () => pad.current!.png());
        if (read) { text = read.text; setAnswer(read.text); }
        else toast({ text: 'Your writing can’t be read here (no on-device recognition or vision AI). Type the answer, or rate yourself.' });
      }
      if (text.trim()) setGrade(await gradeCard(card, text));
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setShown(true);
      setBusy(false);
    }
  };
  const rate = async (r: 1 | 2 | 3 | 4) => {
    await review(deck.id, card.id, r, grade ? { text: answer, score: grade.score } : undefined);
    onRated();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('textarea, input');
      if (typing && !(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
      if (!shown && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); void reveal(); }
      else if (shown && /^[1-4]$/.test(e.key)) { e.preventDefault(); void rate(Number(e.key) as 1 | 2 | 3 | 4); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <article className="cp-card" aria-live="polite">
      <span className="cp-card-deck">{deck.title}</span>
      <p className="cp-card-q">{card.q}</p>
      {!shown && (
        <div className="cp-answer">
          <div className="cp-answer-mode" role="group" aria-label="Answer with">
            <button type="button" className={cx('chip', mode === 'type' && 'is-on')} aria-pressed={mode === 'type'} onClick={() => setMode('type')}><Type size={14} /> Type</button>
            <button type="button" className={cx('chip', mode === 'write' && 'is-on')} aria-pressed={mode === 'write'} onClick={() => setMode('write')}><PenLine size={14} /> Write</button>
          </div>
          {mode === 'type'
            ? <textarea className="cp-answer-text" rows={2} placeholder="Your answer (optional)" aria-label="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            : <InkPad apiRef={pad} />}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void reveal()}>{busy ? 'Checking…' : 'Show answer'}</button>
        </div>
      )}
      {shown && (
        <div className="cp-reveal">
          <p className="cp-card-a">{card.a}</p>
          {answer && <p className="cp-your">You wrote: <q>{answer}</q></p>}
          {grade && (
            <p className={cx('cp-grade', grade.rating >= 3 ? 'is-good' : 'is-miss')}>
              {grade.rating >= 3 ? 'That matches.' : grade.missing.length ? `Missing: ${grade.missing.join(', ')}.` : 'Not quite.'}
              {grade.feedback ? ` ${grade.feedback}` : ''} <span className="muted small">Graded by {grade.by === 'rules' ? 'the rules (no AI)' : grade.by}.</span>
            </p>
          )}
          {grade?.contradictions.map((c, k) => <p key={k} className="cp-grade is-miss">Your answer says “{c.says}”, your notes say “{c.sourceSays}”.</p>)}
          {anchor && <ul className="cp-sources"><SourceCard anchor={anchor} /></ul>}
          <div className="cp-rate" role="group" aria-label="How well did you know it?">
            {([1, 2, 3, 4] as const).map((r) => (
              <button key={r} type="button" className={cx('btn', r === (grade?.rating ?? 3) && 'btn-primary')} onClick={() => void rate(r)}>
                <span>{RATING_LABEL[r]}</span><span className="cp-rate-when">{formatInterval(intervals[r])}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

// ---- A small ink pad for written answers ------------------------------------------------------------

export interface InkPadApi {
  strokes(): InkStroke[];
  png(): Promise<string>;
  clear(): void;
}

/** Pen-first answer pad: pressure-aware lines on a paper-coloured canvas; fingers scroll. */
export function InkPad({ apiRef }: { apiRef: React.MutableRefObject<InkPadApi | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<InkStroke[]>([]);
  const cur = useRef<InkStroke | null>(null);
  const [count, setCount] = useState(0);
  const redraw = () => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const k = c.width / c.clientWidth;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    ctx.strokeStyle = getComputedStyle(c).color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of [...strokes.current, ...(cur.current ? [cur.current] : [])]) {
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1]!, b = s.points[i]!;
        ctx.lineWidth = 1.2 + 2.4 * (b.p != null && b.p >= 0 ? b.p : 0.5);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  };
  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    redraw();
    apiRef.current = {
      strokes: () => strokes.current,
      clear: () => { strokes.current = []; setCount(0); redraw(); },
      png: async () => c.toDataURL('image/png').split(',')[1]!,
    };
    return () => { apiRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pt = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Date.now() - (cur.current?.createdAt ?? Date.now()), p: e.pointerType === 'pen' ? e.pressure : -1, tilt: -1, orient: -1 };
  };
  return (
    <div className="cp-pad-wrap">
      <canvas ref={canvas} className="cp-pad" aria-label="Write your answer" data-strokes={count}
        onPointerDown={(e) => { if (e.pointerType === 'touch') return; e.currentTarget.setPointerCapture(e.pointerId); cur.current = { id: newId(), pen: 'ballpoint', color: '#FF1B1F24', size: 2, createdAt: Date.now(), input: e.pointerType === 'pen' ? 'pen' : 'mouse', points: [] }; cur.current.points.push(pt(e)); }}
        onPointerMove={(e) => { if (!cur.current) return; cur.current.points.push(pt(e)); redraw(); }}
        onPointerUp={() => { if (cur.current && cur.current.points.length > 1) { strokes.current.push(cur.current); setCount(strokes.current.length); } cur.current = null; redraw(); }} />
      {count > 0 && <IconButton label="Clear writing" onClick={() => apiRef.current?.clear()}><Eraser size={16} /></IconButton>}
    </div>
  );
}
