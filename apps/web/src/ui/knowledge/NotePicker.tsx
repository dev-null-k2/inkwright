import { useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, FileText, Search } from 'lucide-react';
import { suggestNotes, type NoteMeta } from '@inkwright/core';
import { useApp } from '../../state/app.ts';
import { Dialog, cx, relativeTime } from '../primitives.tsx';
import { argbCss } from './color.ts';

export interface PickedNote {
  title: string;
  /** Set when an existing note was picked (absent: "create a note with this title"). */
  noteId?: string;
  /** 1-based page, when a page was chosen. */
  page?: number;
}

/**
 * "Link to note…": a quick finder over every note (fuzzy titles, with notebook), with a page
 * choice for multi-page notes and a "Create" row for a note that doesn't exist yet.
 */
export function NotePicker({ open, title = 'Link to note', exclude, onPick, onClose }: { open: boolean; title?: string; exclude?: string; onPick: (p: PickedNote) => void; onClose: () => void }) {
  const { notes, notebooks } = useApp();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [page, setPage] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(''); setActive(0); setPage(0); setTimeout(() => input.current?.focus(), 30); } }, [open]);

  const found = useMemo(() => suggestNotes(q, notes, { limit: 30, exclude }), [q, notes, exclude]);
  const canCreate = q.trim() && !notes.some((n) => n.title.trim().toLowerCase() === q.trim().toLowerCase());
  const count = found.length + (canCreate ? 1 : 0);
  useEffect(() => { setActive(0); setPage(0); }, [q]);
  const current: NoteMeta | undefined = found[active];

  const pick = (i: number) => {
    const n = found[i];
    if (n) onPick({ title: n.title, noteId: n.id, page: i === active && page > 0 ? page : undefined });
    else if (canCreate) onPick({ title: q.trim() });
  };

  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <div className="note-picker">
        <label className="search note-picker-search">
          <Search size={17} aria-hidden />
          <input ref={input} value={q} placeholder="Find a note" aria-label="Find a note" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(count - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
            }} />
        </label>
        <ul className="note-picker-list" role="listbox" aria-label="Notes">
          {found.map((n, i) => {
            const nb = notebooks.find((b) => b.id === n.notebookId);
            return (
              <li key={n.id}>
                <button type="button" role="option" aria-selected={i === active} className={cx('np-item', i === active && 'is-on')} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
                  <span className="ls-icon">{nb ? <span className="nb-dot" style={{ background: argbCss(nb.color) }} /> : <FileText size={14} />}</span>
                  <span className="ls-title">{n.title || 'Untitled'}</span>
                  <span className="ls-meta">{nb ? `${nb.name} · ` : ''}{relativeTime(n.updatedAt)}</span>
                </button>
              </li>
            );
          })}
          {canCreate && (
            <li>
              <button type="button" role="option" aria-selected={active === found.length} className={cx('np-item', active === found.length && 'is-on')} onMouseEnter={() => setActive(found.length)} onClick={() => pick(found.length)}>
                <span className="ls-icon"><FilePlus2 size={14} /></span>
                <span className="ls-title">Create “{q.trim()}”</span>
                <span className="ls-meta">New note</span>
              </button>
            </li>
          )}
          {!count && <li className="muted small np-empty">No notes match.</li>}
        </ul>
        {current && current.pageIds.length > 1 && (
          <label className="field-row np-page">
            <span className="field-label">Open at</span>
            <select value={page} onChange={(e) => setPage(Number(e.target.value))} aria-label="Page">
              <option value={0}>The note</option>
              {current.pageIds.map((_, i) => <option key={i} value={i + 1}>Page {i + 1}</option>)}
            </select>
          </label>
        )}
      </div>
    </Dialog>
  );
}
