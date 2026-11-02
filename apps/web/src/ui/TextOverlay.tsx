import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ListChecks, List, Minus, Plus } from 'lucide-react';
import type { FontFamily, TextBox } from '@inkstone/core';
import { FONT_FAMILIES } from '../canvas/render.ts';
import { INK_PALETTE } from '../state/settings.ts';
import { cx } from './primitives.tsx';
import { DictateButton } from './Dictation.tsx';
import { insertAtCaret } from '../lib/listen/dictation.ts';
import { LinkSuggest, type SuggestHandle } from './knowledge/LinkSuggest.tsx';

/** Edits a text box in place: a textarea laid exactly over where the text renders on the page. */
export function TextOverlay({ box, screen, zoom, onChange, onDone, noteId }: {
  box: TextBox;
  /** The note being edited (left out of its own [[link]] suggestions). */
  noteId?: string;
  screen: { x: number; y: number; w: number; h: number };
  zoom: number;
  onChange: (b: TextBox) => void;
  onDone: (b: TextBox) => void;
}) {
  const [b, setB] = useState(box);
  const ta = useRef<HTMLTextAreaElement>(null);
  const suggest = useRef<SuggestHandle>(null);
  useEffect(() => { setTimeout(() => { ta.current?.focus(); const l = ta.current?.value.length ?? 0; ta.current?.setSelectionRange(l, l); }, 20); }, []);
  useLayoutEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + 2}px`;
  }, [b.text, b.fontSize, zoom, b.width]);
  const latest = useRef(b);
  latest.current = b;
  const update = (patch: Partial<TextBox>) => { const n = { ...latest.current, ...patch }; latest.current = n; setB(n); onChange(n); };
  // Dictated words go in at the caret.
  const dictated = (text: string) => {
    const t = ta.current;
    const r = insertAtCaret(latest.current.text, t?.selectionStart ?? latest.current.text.length, text);
    update({ text: r.value });
    setTimeout(() => { t?.focus(); t?.setSelectionRange(r.caret, r.caret); }, 0);
  };
  const insertPrefix = (prefix: string) => {
    const t = ta.current!;
    const start = b.text.lastIndexOf('\n', t.selectionStart - 1) + 1;
    const text = b.text.slice(0, start) + prefix + b.text.slice(start);
    update({ text });
    setTimeout(() => t.setSelectionRange(t.selectionStart + prefix.length, t.selectionStart + prefix.length), 0);
  };
  const fonts: { id: FontFamily; label: string }[] = [{ id: 'sans', label: 'Sans' }, { id: 'serif', label: 'Serif' }, { id: 'mono', label: 'Mono' }, { id: 'hand', label: 'Hand' }];
  return (
    <div className="text-edit" style={{ left: screen.x, top: screen.y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="text-tools" role="toolbar" aria-label="Text formatting">
        {fonts.map((f) => <button key={f.id} type="button" className={cx('chip', b.font === f.id && 'is-on')} style={{ fontFamily: FONT_FAMILIES[f.id] }} onClick={() => update({ font: f.id })}>{f.label}</button>)}
        <span className="sel-sep" />
        <button type="button" className="sel-icon" aria-label="Smaller" onClick={() => update({ fontSize: Math.max(8, b.fontSize - 2) })}><Minus size={15} /></button>
        <span className="text-size">{Math.round(b.fontSize)}</span>
        <button type="button" className="sel-icon" aria-label="Larger" onClick={() => update({ fontSize: Math.min(96, b.fontSize + 2) })}><Plus size={15} /></button>
        <span className="sel-sep" />
        <button type="button" className="sel-icon" aria-label="Bulleted line" onClick={() => insertPrefix('- ')}><List size={16} /></button>
        <button type="button" className="sel-icon" aria-label="Checkbox line" onClick={() => insertPrefix('- [ ] ')}><ListChecks size={16} /></button>
        <DictateButton onText={dictated} />
        <span className="sel-sep" />
        {INK_PALETTE.slice(0, 6).map((c) => <button key={c} type="button" className={cx('swatch is-mini', b.color === c && 'is-on')} aria-label={c} style={{ background: '#' + c.slice(3) }} onClick={() => update({ color: c })} />)}
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onDone(b)}><Check size={15} /> Done</button>
      </div>
      <textarea
        ref={ta}
        className="text-area"
        value={b.text}
        placeholder="Type, or write Markdown: # heading, - list, - [ ] task"
        spellCheck
        style={{ width: Math.max(120, b.width * zoom), fontSize: b.fontSize * zoom, fontFamily: FONT_FAMILIES[b.font], color: '#' + b.color.slice(3), lineHeight: 1.35 }}
        onChange={(e) => update({ text: e.target.value })}
        onKeyDown={(e) => {
          if (suggest.current?.onKeyDown(e)) { e.stopPropagation(); return; }
          if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) { e.preventDefault(); onDone(b); }
          e.stopPropagation();
        }}
      />
      <LinkSuggest ref={suggest} taRef={ta} text={b.text} noteId={noteId}
        onApply={(text, caret) => { update({ text }); setTimeout(() => { ta.current?.focus(); ta.current?.setSelectionRange(caret, caret); }, 0); }} />
    </div>
  );
}
