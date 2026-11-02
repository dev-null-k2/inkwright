import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookMarked } from 'lucide-react';
import { citeTrigger, referenceLabel, suggestReferences, type CiteTrigger } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { caretPoint } from '../ui/knowledge/LinkSuggest.tsx';
import { cx } from '../ui/primitives.tsx';
import { libraryReferences } from './library.ts';

/**
 * `[@` autocomplete in any text box being typed in on a page: the library's papers by citation
 * key, author, title word or year. It attaches to the text editor's textarea from outside (so the
 * editor needs no knowledge of papers): arrow keys move, Enter or Tab inserts `[@key]`, Escape
 * closes. The value is set through the native setter plus an `input` event, so React's state for
 * the textarea follows.
 */
export function CiteSuggest() {
  const notes = useApp((s) => s.notes);
  const [ta, setTa] = useState<HTMLTextAreaElement | null>(null);
  const [trigger, setTrigger] = useState<CiteTrigger | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; h: number } | null>(null);
  const [active, setActive] = useState(0);
  const dismissed = useRef<number | null>(null);
  const refs = useMemo(() => libraryReferences(notes).map((x) => x.ref), [notes]);
  const items = useMemo(() => (trigger ? suggestReferences(trigger.query, refs, 7) : []), [trigger, refs]);

  // Follow focus into the editor's text boxes.
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLTextAreaElement && t.closest('.text-edit')) setTa(t);
    };
    document.addEventListener('focusin', onFocus);
    const cur = document.activeElement;
    if (cur instanceof HTMLTextAreaElement && cur.closest('.text-edit')) setTa(cur);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  useEffect(() => {
    if (!ta) return;
    const recompute = () => {
      if (!ta.isConnected || document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { setTrigger(null); return; }
      const t = citeTrigger(ta.value.slice(0, ta.selectionStart));
      if (!t || dismissed.current === t.at) { setTrigger(null); return; }
      setTrigger((cur) => (cur && cur.at === t.at && cur.query === t.query ? cur : t));
      setPos(caretPoint(ta, t.at));
    };
    const on = () => requestAnimationFrame(recompute);
    const evs = ['input', 'keyup', 'click', 'blur'] as const;
    evs.forEach((e) => ta.addEventListener(e, on));
    return () => evs.forEach((e) => ta.removeEventListener(e, on));
  }, [ta]);

  useEffect(() => setActive(0), [trigger?.at, items.length]);

  const apply = (key: string) => {
    if (!ta || !trigger) return;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, trigger.at);
    let after = ta.value.slice(caret);
    // Inside "[@…" that is not closed yet: close it.
    const openBracket = before.lastIndexOf('[') > before.lastIndexOf(']');
    const closes = /^[^\[\]\n]*\]/.test(after);
    const insert = `@${key}${openBracket && !closes ? ']' : ''}`;
    after = after.replace(/^[\p{L}\p{N}_:.#$%&\-+?<>~/]*/u, '');
    const value = before + insert + after;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const c = before.length + insert.length;
    ta.setSelectionRange(c, c);
    setTrigger(null);
  };

  // Keys go to the list first while it is open (before the editor's own handlers).
  useEffect(() => {
    if (!ta) return;
    const key = (e: KeyboardEvent) => {
      if (!trigger || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); apply(items[active]!.id); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissed.current = trigger.at; setTrigger(null); }
    };
    ta.addEventListener('keydown', key, true);
    return () => ta.removeEventListener('keydown', key, true);
  });

  if (!trigger || !pos || !items.length) return null;
  return createPortal(
    <div className="ia-cite-list" role="listbox" aria-label="Cite a paper" style={{ left: pos.x, top: pos.y + pos.h + 4 }} onPointerDown={(e) => e.preventDefault()}>
      {items.map((r, i) => (
        <div key={r.id} role="option" aria-selected={i === active} className={cx('ia-cite-item', i === active && 'is-active')} onMouseEnter={() => setActive(i)} onClick={() => apply(r.id)}>
          <BookMarked size={14} aria-hidden />
          <span className="ia-cite-key">@{r.id}</span>
          <span className="ia-cite-label">{referenceLabel(r)}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
