import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Volume2 } from 'lucide-react';
import { create } from 'zustand';
import { readingSegments, type NoteDocument } from '@inkstone/core';
import { Dialog, cx } from '../ui/primitives.tsx';
import { useInkPrefs, type ReadingPrefs } from '../inkactions/prefs.ts';
import { speechSupported } from './readaloud.ts';

/**
 * The reading view: the note's typed and recognized text reflowed in the reader's own font,
 * size and spacing (Settings › Reading), on a calm tint, with line focus — the paragraph being
 * read stays clear while the rest dims, following the pointer or the arrow keys. Ink and layout
 * on the page are untouched; this is a way to read, not a change to the note.
 */

export const useReadingView = create<{ doc: NoteDocument | null }>(() => ({ doc: null }));
export const openReadingView = (doc: NoteDocument) => useReadingView.setState({ doc });

export function readingStyle(r: ReadingPrefs): CSSProperties {
  return {
    ['--rv-font' as string]: r.font ? `"${r.font}", var(--font-ui)` : 'var(--font-ui)',
    ['--rv-size' as string]: `${r.size}px`,
    ['--rv-letter' as string]: `${r.letterSpacing}em`,
    ['--rv-word' as string]: `${r.wordSpacing}em`,
    ['--rv-line' as string]: String(r.lineHeight),
  };
}

export function ReadingViewHost() {
  const doc = useReadingView((s) => s.doc);
  if (!doc) return null;
  return <ReadingView doc={doc} onClose={() => useReadingView.setState({ doc: null })} />;
}

function ReadingView({ doc, onClose }: { doc: NoteDocument; onClose: () => void }) {
  const reading = useInkPrefs((s) => s.reading);
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLParagraphElement | null)[]>([]);
  const paras = useMemo(() => doc.pages.flatMap((p, i) => readingSegments(p).map((s) => ({ ...s, page: i }))), [doc, doc.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (i: number) => { const k = Math.max(0, Math.min(paras.length - 1, i)); setFocus(k); refs.current[k]?.focus(); };
  const speak = (text: string) => {
    if (!speechSupported()) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = useInkPrefs.getState().readAloud.rate;
    speechSynthesis.speak(u);
  };
  return (
    <Dialog open wide title={`Reading: ${doc.meta.title || 'Untitled'}`} onClose={() => { if (speechSupported()) speechSynthesis.cancel(); onClose(); }} actions={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className={cx('ia-reader', `is-${reading.tint}`, reading.lineFocus && 'has-focus')} style={readingStyle(reading)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(focus + 1); } else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(focus - 1); } }}>
        {paras.length === 0 ? <p className="ia-muted">Nothing to read yet: type text, or recognize your handwriting (AI › Transcribe page, or the on-device recognizer in Settings › Handwriting).</p> : paras.map((p, i) => (
          <p key={i} ref={(el) => { refs.current[i] = el; }} tabIndex={i === focus ? 0 : -1} className={cx('ia-reader-line', i === focus && 'is-focus')}
            onMouseEnter={() => setFocus(i)} onFocus={() => setFocus(i)}>
            {p.text}
            {speechSupported() && <button type="button" className="icon-btn ia-reader-say" aria-label="Read this aloud" tabIndex={i === focus ? 0 : -1} onClick={() => speak(p.text)}><Volume2 size={15} /></button>}
          </p>
        ))}
      </div>
      <p className="ia-note">↑ ↓ move between lines. Font, spacing and tint: Settings › Reading.</p>
    </Dialog>
  );
}
