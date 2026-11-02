import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, ChevronDown, Clock, FileUp, FolderInput, Hash, Inbox, Menu as MenuIcon, MoreHorizontal, NotebookPen, Pin, PinOff,
  Plus, Search, Settings as SettingsIcon, Trash2, X, Copy, Pencil, RotateCcw, Cloud, CloudOff, Image as ImageIcon,
} from 'lucide-react';
import type { NoteMeta, NotebookMeta, SearchHit } from '@inkstone/core';
import { useApp, type LibraryFilter } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { Dialog, IconButton, Menu, Popover, cx, relativeTime, useMediaQuery } from '../ui/primitives.tsx';
import { NewNoteSheet } from '../ui/NewNoteSheet.tsx';
import { createNote, importFiles, moveNote, renameNote, togglePin, trashNote, restoreNote, deleteForever, duplicateNote, createNotebook, deleteNotebook, renameNotebook } from '../lib/actions.ts';
import { BrandMark } from '../ui/Brand.tsx';
import { InkRipple, NotebookCover } from '../ui/Cover.tsx';
import { LockedCover } from '../studio/LockedCover.tsx';
import { syncNow, useSync } from '../lib/sync.ts';
import { OPENABLE, useFileDrop } from '../lib/openFiles.ts';
import { GraphNavItem, TodayNavItem } from '../ui/knowledge/LibraryParts.tsx';
import { openPalette, usePaletteActions } from '../lib/palette.ts';

export function Library() {
  const { notes, trash, notebooks, filter, setFilter, query, setQuery, navigate, vault } = useApp();
  const sort = useSettings((s) => s.library.sort);
  const account = useSettings((s) => s.sync.account);
  const wide = useMediaQuery('(min-width: 900px)');
  // On touch screens the search field opens search-everything (notes, handwriting, PDFs, Ask).
  const touch = useMediaQuery('(pointer: coarse)');
  const [drawer, setDrawer] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const newBtn = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const addSamples = useCallback(async () => {
    const { seedSampleLibrary } = await import('../lib/sample.ts');
    if (!vault) return;
    const before = new Set((await vault.listNotes(true)).map((n) => n.id));
    await seedSampleLibrary(vault.vault);
    for (const n of await vault.listNotes()) if (!before.has(n.id)) vault.indexNote(n, await vault.vault.readPages(n));
    await useApp.getState().refresh();
    setFilter({ kind: 'all' });
  }, [vault, setFilter]);
  usePaletteActions('library', [{ id: 'library.samples', label: 'Add sample notebooks', keywords: 'demo example try tour handwriting', run: addSamples }]);
  const sync = useSync();
  // Drop PDFs, images or text files anywhere on the library to open them.
  const [libEl, setLibEl] = useState<HTMLDivElement | null>(null);
  const dropping = useFileDrop(libEl, useCallback(async (files: File[]) => {
    const id = await importFiles(files, filter.kind === 'notebook' ? filter.id : undefined);
    if (id) navigate({ name: 'editor', noteId: id });
  }, [filter, navigate]));

  useEffect(() => {
    if (!query.trim() || !vault) return setHits(null);
    const id = setTimeout(() => setHits(vault.search.search(query, { limit: 60 })), 90);
    return () => clearTimeout(id);
  }, [query, vault, notes]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); void quickNew(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const tags = useMemo(() => [...new Set(notes.flatMap((n) => n.tags))].sort((a, b) => a.localeCompare(b)), [notes]);

  const shown = useMemo(() => {
    let list: NoteMeta[];
    switch (filter.kind) {
      case 'trash': list = trash; break;
      case 'pinned': list = notes.filter((n) => n.pinned); break;
      case 'recent': list = notes.filter((n) => Date.now() - n.updatedAt < 7 * 864e5); break;
      case 'unfiled': list = notes.filter((n) => !n.notebookId); break;
      case 'notebook': {
        const ids = descendants(notebooks, filter.id);
        list = notes.filter((n) => n.notebookId && ids.has(n.notebookId));
        break;
      }
      case 'tag': list = notes.filter((n) => n.tags.includes(filter.tag)); break;
      default: list = notes;
    }
    const sorted = [...list];
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt);
    else sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    return sorted;
  }, [filter, notes, trash, notebooks, sort]);

  const pinned = filter.kind === 'all' ? shown.filter((n) => n.pinned) : [];
  const rest = filter.kind === 'all' ? shown.filter((n) => !n.pinned) : shown;
  const heading = filterTitle(filter, notebooks);

  async function quickNew() {
    const nbId = filter.kind === 'notebook' ? filter.id : undefined;
    const id = await createNote({ notebookId: nbId });
    if (id) navigate({ name: 'editor', noteId: id });
  }

  const sidebar = (
    <nav className="lib-nav" aria-label="Library">
      <div className="lib-brand">
        <BrandMark size={32} />
        <span className="lib-brand-name">Inkstone</span>
        {!wide && <IconButton label="Close" onClick={() => setDrawer(false)}><X size={18} /></IconButton>}
      </div>
      <NavItem icon={<BookOpen size={17} />} label="All notes" count={notes.length} on={filter.kind === 'all'} onClick={() => { setFilter({ kind: 'all' }); setDrawer(false); }} />
      <TodayNavItem onDone={() => setDrawer(false)} />
      <NavItem icon={<Pin size={17} />} label="Pinned" count={notes.filter((n) => n.pinned).length} on={filter.kind === 'pinned'} onClick={() => { setFilter({ kind: 'pinned' }); setDrawer(false); }} />
      <NavItem icon={<Clock size={17} />} label="This week" on={filter.kind === 'recent'} onClick={() => { setFilter({ kind: 'recent' }); setDrawer(false); }} />
      <NavItem icon={<Inbox size={17} />} label="Unfiled" on={filter.kind === 'unfiled'} onClick={() => { setFilter({ kind: 'unfiled' }); setDrawer(false); }} />
      <GraphNavItem />
      <div className="lib-nav-head">
        <span>Notebooks</span>
        <IconButton label="New notebook" onClick={async () => { const nb = await createNotebook(); if (nb) setFilter({ kind: 'notebook', id: nb.id }); }}><Plus size={16} /></IconButton>
      </div>
      {notebookTree(notebooks).map(({ nb, depth }) => (
        <NotebookItem key={nb.id} nb={nb} depth={depth} on={filter.kind === 'notebook' && filter.id === nb.id} count={notes.filter((n) => n.notebookId === nb.id).length}
          onClick={() => { setFilter({ kind: 'notebook', id: nb.id }); setDrawer(false); }} />
      ))}
      {!notebooks.length && <p className="lib-nav-empty">Group notes by class, project or person.</p>}
      {tags.length > 0 && <div className="lib-nav-head"><span>Tags</span></div>}
      {tags.map((t) => (
        <NavItem key={t} icon={<Hash size={15} />} label={t} on={filter.kind === 'tag' && filter.tag === t} onClick={() => { setFilter({ kind: 'tag', tag: t }); setDrawer(false); }} />
      ))}
      <div className="lib-nav-foot">
        <NavItem icon={<Trash2 size={17} />} label="Trash" count={trash.length || undefined} on={filter.kind === 'trash'} onClick={() => { setFilter({ kind: 'trash' }); setDrawer(false); }} />
        <button type="button" className="lib-account" onClick={() => navigate({ name: 'settings', section: 'sync' })}>
          {account ? (
            <>
              {account.picture ? <img src={account.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{account.name.slice(0, 1)}</span>}
              <span className="lib-account-text"><span>{account.name}</span><span className="muted">{sync.status === 'syncing' ? 'Syncing…' : sync.lastSync ? `Synced ${relativeTime(sync.lastSync)}` : 'Google Drive'}</span></span>
              {sync.status === 'error' ? <CloudOff size={16} /> : <Cloud size={16} />}
            </>
          ) : (
            <>
              <span className="avatar is-empty"><Cloud size={15} /></span>
              <span className="lib-account-text"><span>Sign in to sync</span><span className="muted">Drive, folder or WebDAV</span></span>
            </>
          )}
        </button>
        <NavItem icon={<SettingsIcon size={17} />} label="Settings" onClick={() => navigate({ name: 'settings' })} />
      </div>
    </nav>
  );

  return (
    <div ref={setLibEl} className={cx('library', wide && 'is-wide')}>
      {dropping && <div className="drop-hint" aria-live="polite"><FileUp size={22} /> Drop to open</div>}
      {wide ? sidebar : drawer && (
        <>
          <div className="drawer-scrim" onClick={() => setDrawer(false)} />
          <div className="drawer">{sidebar}</div>
        </>
      )}
      <main className="lib-main">
        <header className="lib-top">
          {!wide && <IconButton label="Menu" onClick={() => setDrawer(true)}><MenuIcon size={20} /></IconButton>}
          <label className="search">
            <Search size={18} aria-hidden />
            <input ref={searchRef} type="search" placeholder="Search your notes and handwriting" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search notes"
              onFocus={(e) => { if (touch) { e.currentTarget.blur(); openPalette({ query }); } }} />
            {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}
          </label>
          {account && <IconButton label="Sync now" onClick={() => void syncNow()} className={cx(sync.status === 'syncing' && 'is-spinning')}><Cloud size={19} /></IconButton>}
          <div className="new-split">
            <button ref={newBtn} type="button" className="btn btn-primary new-btn" onClick={() => void quickNew()}>
              <NotebookPen size={17} /> <span>New note</span>
            </button>
            <button type="button" className="btn btn-primary new-more" aria-label="More ways to create" onClick={() => setNewOpen(true)}><ChevronDown size={16} /></button>
          </div>
        </header>

        <input ref={fileInput} type="file" hidden multiple accept={OPENABLE} onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          const id = await importFiles(files, filter.kind === 'notebook' ? filter.id : undefined);
          if (id) navigate({ name: 'editor', noteId: id });
        }} />

        <NewNoteSheet anchor={newBtn.current} open={newOpen} onClose={() => setNewOpen(false)} notebookId={filter.kind === 'notebook' ? filter.id : undefined}
          onImport={() => { setNewOpen(false); fileInput.current?.click(); }} />

        <div className="lib-scroll">
          {hits ? (
            <section className="results" aria-label="Search results">
              <h1 className="lib-h1">{hits.length ? `${hits.length} ${hits.length === 1 ? 'note' : 'notes'} match “${query}”` : `Nothing matches “${query}”`}</h1>
              {!hits.length && <p className="muted">Search covers titles, tags, typed text and recognized handwriting. Handwriting is searchable once it has been recognized.</p>}
              <ul className="hit-list">
                {hits.map((h) => (
                  <li key={h.noteId}>
                    <button type="button" className="hit" onClick={() => navigate({ name: 'editor', noteId: h.noteId, page: h.pageIndex })}>
                      <span className="hit-title">{h.title}</span>
                      <span className="hit-snippet">{renderSnippet(h.snippet)}</span>
                      <span className="hit-meta">Page {h.pageIndex + 1}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <>
              <div className="lib-heading">
                {filter.kind === 'notebook' && (() => { const nb = notebooks.find((b) => b.id === filter.id); return nb ? <span className="lib-cover"><NotebookCover id={nb.id} color={nb.color} size={42} /></span> : null; })()}
                <h1 className="lib-h1">{heading}</h1>
                {filter.kind === 'notebook' && <NotebookActions id={filter.id} />}
                {filter.kind === 'trash' && trash.length > 0 && <span className="muted">Notes in Trash are deleted after 30 days.</span>}
              </div>
              {filter.kind === 'all' && notebooks.some((nb) => !nb.parentId) && (
                <section className="nb-shelf" aria-label="Notebooks">
                  {notebooks.filter((nb) => !nb.parentId).map((nb) => {
                    const count = notes.filter((n) => n.notebookId === nb.id).length;
                    return (
                      <button key={nb.id} type="button" className="nb-shelf-item" onClick={() => setFilter({ kind: 'notebook', id: nb.id })}>
                        <NotebookCover id={nb.id} color={nb.color} size={96} />
                        <span className="nb-shelf-name">{nb.name}</span>
                        <span className="nb-shelf-count">{count === 1 ? '1 note' : `${count} notes`}</span>
                      </button>
                    );
                  })}
                </section>
              )}
              {pinned.length > 0 && (
                <>
                  <h2 className="lib-h2">Pinned</h2>
                  <div className="note-grid">{pinned.map((n) => <NoteCard key={n.id} note={n} notebooks={notebooks} />)}</div>
                  {rest.length > 0 && <h2 className="lib-h2">Everything else</h2>}
                </>
              )}
              {rest.length > 0 && <div className="note-grid">{rest.map((n) => <NoteCard key={n.id} note={n} notebooks={notebooks} trashed={filter.kind === 'trash'} />)}</div>}
              {shown.length === 0 && <EmptyState filter={filter} onNew={() => void quickNew()} onImport={() => fileInput.current?.click()} onSample={addSamples} />}
            </>
          )}
        </div>
        {!wide && (
          <button type="button" className="fab" aria-label="New note" onClick={() => void quickNew()}><Plus size={26} /></button>
        )}
      </main>
    </div>
  );
}

function renderSnippet(s: string) {
  const parts = s.split(/(«[^»]*»)/g);
  return parts.map((p, i) => (p.startsWith('«') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>));
}

function filterTitle(f: LibraryFilter, notebooks: NotebookMeta[]) {
  switch (f.kind) {
    case 'all': return 'All notes';
    case 'pinned': return 'Pinned';
    case 'recent': return 'This week';
    case 'unfiled': return 'Unfiled';
    case 'trash': return 'Trash';
    case 'tag': return `#${f.tag}`;
    case 'notebook': return notebooks.find((n) => n.id === f.id)?.name ?? 'Notebook';
  }
}

function descendants(nbs: NotebookMeta[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nbs) if (n.parentId && out.has(n.parentId) && !out.has(n.id)) { out.add(n.id); grew = true; }
  }
  return out;
}

function notebookTree(nbs: NotebookMeta[]) {
  const out: { nb: NotebookMeta; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const nb of nbs.filter((n) => (n.parentId ?? undefined) === parent && (parent === undefined || nbs.some((p) => p.id === parent)))) {
      out.push({ nb, depth });
      walk(nb.id, depth + 1);
    }
  };
  walk(undefined, 0);
  // Orphans (parent deleted elsewhere) at the root.
  for (const nb of nbs) if (!out.some((o) => o.nb.id === nb.id)) out.push({ nb, depth: 0 });
  return out;
}

function NavItem({ icon, label, count, on, onClick }: { icon: React.ReactNode; label: string; count?: number; on?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cx('nav-item', on && 'is-on')} onClick={onClick} aria-current={on ? 'page' : undefined}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {count != null && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
}

function NotebookItem({ nb, depth, on, count, onClick }: { nb: NotebookMeta; depth: number; on: boolean; count: number; onClick: () => void }) {
  return (
    <button type="button" className={cx('nav-item', on && 'is-on')} style={{ paddingLeft: 12 + depth * 16 }} onClick={onClick}>
      <span className="nb-mini"><NotebookCover id={nb.id} color={nb.color} size={15} /></span>
      <span className="nav-label">{nb.name}</span>
      {count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
}

function NotebookActions({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" className="icon-btn" aria-label="Notebook options" onClick={() => setOpen(true)}><MoreHorizontal size={18} /></button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} title="Notebook options">
        <Menu onClose={() => setOpen(false)} items={[
          { label: 'Rename notebook', icon: <Pencil size={16} />, onClick: () => void renameNotebook(id) },
          { label: 'New notebook inside', icon: <Plus size={16} />, onClick: () => void createNotebook(id) },
          'sep',
          { label: 'Delete notebook', icon: <Trash2 size={16} />, danger: true, hint: 'Notes are kept', onClick: () => void deleteNotebook(id) },
        ]} />
      </Popover>
    </>
  );
}

export const argbCss = (hex: string) => {
  const c = hex.replace('#', '');
  return c.length === 8 ? `#${c.slice(2)}` : `#${c}`;
};

function NoteCard({ note, notebooks, trashed }: { note: NoteMeta; notebooks: NotebookMeta[]; trashed?: boolean }) {
  const { navigate, vault } = useApp();
  const [thumb, setThumb] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!vault) return;
    let alive = true;
    const el = ref.current;
    const load = () => vault.thumbnail(note).then((u) => alive && setThumb(u));
    if (!el || typeof IntersectionObserver === 'undefined') { void load(); return () => { alive = false; }; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { void load(); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [vault, note]);

  const aspect = note.kind === 'board' ? 4 / 3 : (note.pageSize.width || 794) / (note.pageSize.height || 1123);
  const nb = notebooks.find((n) => n.id === note.notebookId);
  const pages = note.pageIds.length;
  return (
    <div className="note-card" ref={ref}>
      <button type="button" className="note-open" onClick={() => !trashed && navigate({ name: 'editor', noteId: note.id })} aria-label={`Open ${note.title}`} disabled={trashed}>
        <span className={cx('sheet', pages > 1 && 'is-stack', note.kind === 'board' && 'is-board')} style={{ aspectRatio: String(aspect) }}>
          {note.lock ? <LockedCover /> : thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="sheet-blank" />}
        </span>
      </button>
      <div className="note-info">
        <div className="note-title-row">
          <span className="note-title">{note.title || 'Untitled'}</span>
          <button ref={moreBtn} type="button" className="icon-btn note-more" aria-label={`Options for ${note.title}`} onClick={() => setMenu(true)}><MoreHorizontal size={17} /></button>
        </div>
        <span className="note-meta">
          {note.pinned && <Pin size={12} aria-label="Pinned" />}
          {relativeTime(note.updatedAt)}
          {note.kind === 'board' ? ' · board' : pages > 1 ? ` · ${pages} pages` : ''}
          {nb && <> · <span className="nb-dot" style={{ background: argbCss(nb.color) }} />{nb.name}</>}
        </span>
      </div>
      <Popover anchor={moreBtn.current} open={menu} onClose={() => setMenu(false)} title="Note options">
        <Menu onClose={() => setMenu(false)} items={trashed ? [
          { label: 'Restore', icon: <RotateCcw size={16} />, onClick: () => void restoreNote(note.id) },
          { label: 'Delete forever', icon: <Trash2 size={16} />, danger: true, onClick: () => void deleteForever(note.id) },
        ] : [
          { label: note.pinned ? 'Unpin' : 'Pin to top', icon: note.pinned ? <PinOff size={16} /> : <Pin size={16} />, onClick: () => void togglePin(note.id) },
          { label: 'Rename', icon: <Pencil size={16} />, onClick: () => void renameNote(note.id) },
          { label: 'Move to notebook', icon: <FolderInput size={16} />, onClick: () => setMoveOpen(true) },
          { label: 'Duplicate', icon: <Copy size={16} />, onClick: () => void duplicateNote(note.id) },
          'sep',
          { label: 'Move to Trash', icon: <Trash2 size={16} />, danger: true, onClick: () => void trashNote(note.id) },
        ]} />
      </Popover>
      <Dialog open={moveOpen} title={`Move “${note.title}”`} onClose={() => setMoveOpen(false)}>
        <div className="move-list">
          <button type="button" className={cx('nav-item', !note.notebookId && 'is-on')} onClick={() => { void moveNote(note.id, undefined); setMoveOpen(false); }}>
            <Inbox size={16} /> <span className="nav-label">Unfiled</span>
          </button>
          {notebookTree(notebooks).map(({ nb, depth }) => (
            <button key={nb.id} type="button" className={cx('nav-item', note.notebookId === nb.id && 'is-on')} style={{ paddingLeft: 12 + depth * 16 }} onClick={() => { void moveNote(note.id, nb.id); setMoveOpen(false); }}>
              <span className="nb-swatch" style={{ background: argbCss(nb.color) }} /> <span className="nav-label">{nb.name}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

function EmptyState({ filter, onNew, onImport, onSample }: { filter: LibraryFilter; onNew: () => void; onImport: () => void; onSample: () => Promise<void> }) {
  if (filter.kind === 'trash') return <div className="empty"><p>Trash is empty.</p></div>;
  return (
    <div className="empty">
      <InkRipple />
      <p className="empty-lead">{filter.kind === 'all' ? 'Your desk is clear.' : 'No notes here yet.'}</p>
      <p className="muted">Start a page, or bring in a PDF to write on.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-primary" onClick={onNew}><NotebookPen size={17} /> New note</button>
        <button type="button" className="btn" onClick={onImport}><FileUp size={17} /> Open a file</button>
        {filter.kind === 'all' && <button type="button" className="btn btn-ghost" data-testid="try-samples" onClick={() => void onSample()}>Try sample notebooks</button>}
      </div>
      <p className="muted small"><ImageIcon size={13} /> PDFs become pages you can annotate, fill in and sign. Images go on a new page; text files become typed notes.</p>
    </div>
  );
}

export { createNote };
