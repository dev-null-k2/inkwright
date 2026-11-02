import { Pause, Play, Square } from 'lucide-react';
import { pauseReadAloud, stopReadAloud, useReadAloud } from './readaloud.ts';

/** The small player while a page is read aloud; the sentence being read is announced politely. */
export function ReadAloudBar() {
  const s = useReadAloud();
  if (!s.playing) return null;
  const seg = s.segments[s.index];
  return (
    <div className="ia-readbar" role="region" aria-label="Reading aloud">
      <button type="button" className="icon-btn" aria-label={s.paused ? 'Resume reading' : 'Pause reading'} onClick={pauseReadAloud}>{s.paused ? <Play size={16} /> : <Pause size={16} />}</button>
      <button type="button" className="icon-btn" aria-label="Stop reading" onClick={stopReadAloud}><Square size={14} /></button>
      <span className="ia-readbar-text" aria-live="polite">{seg?.text}</span>
      <span className="ia-muted">{s.index + 1} / {s.segments.length}</span>
    </div>
  );
}
