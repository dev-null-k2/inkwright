import { Check, Mic, X } from 'lucide-react';
import { cancelDictation, startDictation, stopDictation, useDictation } from '../lib/listen/dictation.ts';
import { SpeechModelOffer, WhereBadge } from './TranscriptPanel.tsx';
import { cx } from './primitives.tsx';

/**
 * Mic button in the text editor's toolbar: dictated words go in at the caret. While listening the
 * button turns into a stop button and words not yet final show in a line under the toolbar.
 */
export function DictateButton({ onText }: { onText: (text: string) => void }) {
  const st = useDictation();
  const mine = st.owner === 'text-box';
  const on = mine && (st.status === 'listening' || st.status === 'starting' || st.status === 'finishing');
  return (
    <>
      <button type="button" className={cx('sel-icon', on && 'is-dictating')} aria-label={on ? 'Stop dictating' : 'Dictate'} aria-pressed={on}
        disabled={mine && st.status === 'finishing'}
        onClick={async () => {
          if (on) { const t = await stopDictation(); if (t) onText(t); }
          else await startDictation('text-box');
        }}>
        <Mic size={16} />
      </button>
      {mine && (on || st.error || st.offer) && (
        <div className="dict-line" role="status">
          {st.where && <WhereBadge where={st.where} label={st.label} />}
          {st.error ? <span className="lis-error">{st.error}</span> : st.offer ? <SpeechModelOffer offer={st.offer} /> : <span className="dict-text">{st.status === 'finishing' ? 'Finishing…' : [st.text, st.partial].filter(Boolean).join(' ') || 'Listening…'}</span>}
        </div>
      )}
    </>
  );
}

/** Floating bar for "Dictate" from the ••• menu: text lands on the page as a new text box. */
export function DictationBar({ onDone }: { onDone: (text: string) => void }) {
  const st = useDictation();
  if (st.owner !== 'page' || (st.status === 'idle' && !st.error && !st.offer)) return null;
  const listening = st.status === 'listening' || st.status === 'starting';
  return (
    <div className="dict-bar" role="region" aria-label="Dictation">
      <span className={cx('dict-dot', listening && 'is-live')} aria-hidden />
      <div className="dict-main">
        {st.where && <WhereBadge where={st.where} label={st.label} />}
        {st.error ? <p className="lis-error" role="alert">{st.error}</p>
          : st.offer ? <SpeechModelOffer offer={st.offer} />
            : <p className="dict-text" aria-live="polite">{st.status === 'finishing' ? 'Finishing…' : [st.text, st.partial].filter(Boolean).join(' ') || 'Listening… speak, and your words go on the page.'}</p>}
      </div>
      {listening ? (
        <>
          <button type="button" className="btn btn-primary btn-sm" onClick={async () => { const t = await stopDictation(); if (t) onDone(t); }}><Check size={14} /> Done</button>
          <button type="button" className="icon-btn" aria-label="Cancel dictation" onClick={cancelDictation}><X size={16} /></button>
        </>
      ) : st.status !== 'finishing' && <button type="button" className="icon-btn" aria-label="Close" onClick={cancelDictation}><X size={16} /></button>}
    </div>
  );
}
