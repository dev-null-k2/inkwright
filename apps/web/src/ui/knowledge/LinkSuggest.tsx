import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Code2, FilePlus2, FileText, Hash } from 'lucide-react';
import { formatCodeLink, fuzzyScore, linkTrigger, suggestNotes, type CodeSymbol, type LinkTrigger, type NoteMeta } from '@inkwright/core';
import { suggestCode } from '../../dev/suggest.ts';
import { useApp } from '../../state/app.ts';
import { argbCss } from './color.ts';
import { cx } from '../primitives.tsx';

export interface SuggestHandle {
  /** Lets the list take arrow keys, Enter, Tab and Escape first; true when it handled the key. */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

type Item =
  | { kind: 'note'; note: NoteMeta; notebook?: { name: string; color: string } }
  | { kind: 'create'; title: string }
  | { kind: 'page'; note: NoteMeta; page: number }
  | { kind: 'tag'; tag: string; count: number; isNew?: boolean }
  | { kind: 'code'; symbol: CodeSymbol };

/** Caret position inside a textarea, in viewport px, via a mirror element styled like it. */
export function caretPoint(ta: HTMLTextAreaElement, pos: number): { x: number; y: number; h: number } {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'] as const) {
    (div.style as unknown as Record<string, string>)[p] = cs[p];
  }
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.overflowWrap = 'break-word';
  div.style.top = '0';
  div.style.left = '-9999px';
  div.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = ta.value.slice(pos) || '.';
  div.appendChild(mark);
  document.body.appendChild(div);
  const r = ta.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
  const out = { x: r.left + mark.offsetLeft - ta.scrollLeft, y: r.top + mark.offsetTop - ta.scrollTop, h: lh };
  div.remove();
  return out;
}

/**
 * Autocomplete for `[[links]]` and `#tags` while typing in a text box: fuzzy note titles (with
 * their notebook), pages after `#`, a "Create" choice for a new note, and existing tags.
 */
export const LinkSuggest = forwardRef<SuggestHandle, { taRef: RefObject<HTMLTextAreaElement | null>; text: string; noteId?: string; onApply: (text: string, caret: number) => void }>(function LinkSuggest({ taRef, text, noteId, onApply }, ref) {
  const { notes, notebooks, vault } = useApp();
  const [trigger, setTrigger] = useState<{ t: LinkTrigger; caret: number } | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; h: number } | null>(null);

  const recompute = useCallback(() => {
    const ta = taRef.current;
    if (!ta || document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { setTrigger(null); return; }
    const caret = ta.selectionStart;
    const t = linkTrigger(ta.value.slice(0, caret));
    if (!t || dismissed === t.start) { setTrigger(null); return; }
    setTrigger((cur) => (cur && cur.t.start === t.start && cur.t.kind === t.kind && cur.caret === caret ? cur : { t, caret }));
    setPos(caretPoint(ta, t.start));
  }, [taRef, dismissed]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const on = () => requestAnimationFrame(recompute);
    const evs = ['input', 'keyup', 'click', 'focus', 'blur', 'scroll'] as const;
    evs.forEach((e) => ta.addEventListener(e, on));
    return () => evs.forEach((e) => ta.removeEventListener(e, on));
  }, [taRef, recompute]);
  useEffect(() => { recompute(); }, [text, recompute]);

  const items = useMemo<Item[]>(() => {
    if (!trigger) return [];
    const t = trigger.t;
    if (t.kind === 'note') {
      const found = suggestNotes(t.query, notes, { limit: 7, exclude: noteId });
      const out: Item[] = found.map((n) => {
        const nb = notebooks.find((b) => b.id === n.notebookId);
        return { kind: 'note', note: n, notebook: nb ? { name: nb.name, color: nb.color } : undefined };
      });
      const q = t.query.trim();
      if (q && !notes.some((n) => n.title.trim().toLowerCase() === q.toLowerCase())) out.push({ kind: 'create', title: q });
      return out;
    }
    if (t.kind === 'code') return suggestCode(t.query).map((symbol) => ({ kind: 'code' as const, symbol }));
    if (t.kind === 'page') {
      const target = notes.find((n) => n.title.trim().toLowerCase() === t.title.trim().toLowerCase());
      if (!target) return [];
      return target.pageIds.map((_, i) => ({ kind: 'page' as const, note: target, page: i + 1 }))
        .filter((p) => fuzzyScore(t.query, `Page ${p.page}`) >= 0).slice(0, 12);
    }
    const all = vault?.knowledge.allTags() ?? [];
    const out: Item[] = all.filter((x) => fuzzyScore(t.query, x.tag) >= 0).sort((a, b) => fuzzyScore(t.query, b.tag) - fuzzyScore(t.query, a.tag) || b.count - a.count).slice(0, 7)
      .map((x) => ({ kind: 'tag', tag: x.tag, count: x.count }));
    // An empty "#" is too eager (headings, numbers): only suggest once there's a letter.
    return t.query ? out : [];
  }, [trigger, notes, notebooks, vault, noteId]);

  useEffect(() => { setActive(0); }, [trigger?.t.start, trigger?.t.kind, items.length]);

  const apply = (it: Item) => {
    const ta = taRef.current;
    if (!ta || !trigger) return;
    const value = ta.value;
    const caret = trigger.caret;
    const after = value.slice(caret);
    const closes = after.startsWith(']]');
    let insert: string;
    if (it.kind === 'tag') insert = `#${it.tag} `;
    else if (it.kind === 'page') insert = `[[${it.note.title}#Page ${it.page}]]`;
    else if (it.kind === 'code') insert = formatCodeLink({ path: it.symbol.file, symbol: it.symbol.qualified });
    else insert = `[[${it.kind === 'note' ? it.note.title : it.title}]]`;
    const rest = it.kind !== 'tag' && closes ? after.slice(2) : after;
    const next = value.slice(0, trigger.t.start) + insert + rest;
    setTrigger(null);
    onApply(next, trigger.t.start + insert.length);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown(e) {
      if (!trigger || !items.length) return false;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); apply(items[Math.min(active, items.length - 1)]!); return true; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(trigger.t.start); setTrigger(null); return true; }
      return false;
    },
  }));

  if (!trigger || !items.length || !pos) return null;
  const below = pos.y + pos.h + 6;
  const flip = below + 280 > window.innerHeight;
  const style = { left: Math.max(8, Math.min(pos.x - 8, window.innerWidth - 328)), ...(flip ? { bottom: window.innerHeight - pos.y + 6 } : { top: below }) };
  return createPortal(
    <div className="link-suggest" role="listbox" aria-label={trigger.t.kind === 'tag' ? 'Tags' : trigger.t.kind === 'code' ? 'Link to code' : 'Link to note'} style={style} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {items.map((it, i) => (
        <button key={i} type="button" role="option" aria-selected={i === active} className={cx('link-suggest-item', i === active && 'is-on')}
          onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(it)}>
          {it.kind === 'note' && (
            <>
              <span className="ls-icon">{it.notebook ? <span className="nb-dot" style={{ background: argbCss(it.notebook.color) }} /> : <FileText size={14} />}</span>
              <span className="ls-title">{it.note.title || 'Untitled'}</span>
              {it.notebook && <span className="ls-meta">{it.notebook.name}</span>}
            </>
          )}
          {it.kind === 'create' && (<><span className="ls-icon"><FilePlus2 size={14} /></span><span className="ls-title">Create “{it.title}”</span><span className="ls-meta">New note</span></>)}
          {it.kind === 'page' && (<><span className="ls-icon"><FileText size={14} /></span><span className="ls-title">Page {it.page}</span><span className="ls-meta">{it.note.title}</span></>)}
          {it.kind === 'code' && (<><span className="ls-icon"><Code2 size={14} /></span><span className="ls-title">{it.symbol.qualified}</span><span className="ls-meta">{it.symbol.kind} · {it.symbol.file}</span></>)}
          {it.kind === 'tag' && (<><span className="ls-icon"><Hash size={14} /></span><span className="ls-title">{it.tag}</span><span className="ls-meta">{it.count === 1 ? '1 note' : `${it.count} notes`}</span></>)}
        </button>
      ))}
    </div>,
    document.body,
  );
});
