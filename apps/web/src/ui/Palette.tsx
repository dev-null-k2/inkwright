import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight, AudioLines, BookOpen, Bot, Cpu, FilePlus2, FileText, FileUp, Hash, MessageCircleQuestion, Moon, NotebookPen, PenLine, Search, Settings as SettingsIcon, Sparkles, Square, Sun, Type, X,
} from 'lucide-react';
import { parseAnswerCitations, parseMemoryLink } from '@inkstone/ai';
import { matchScore, type RankedChunk } from '@inkstone/core';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { getActiveAI } from '../lib/ai.ts';
import { aiCanSee, noteLabelOf } from '../lib/trust/state.ts';
import { anchorOf, askNotes, sourceKindLabel, toSources, type AskSource } from '../lib/ask.ts';
import { openAnchor } from '../lib/focus.ts';
import { appMemory, useMemoryStatus } from '../lib/memory.ts';
import { closePalette, findActions, openPalette, registerPaletteActions, usePalette, type PaletteAction, type PaletteMode } from '../lib/palette.ts';
import { createNote, importFiles } from '../lib/actions.ts';
import { pickFiles } from '../platform/files.ts';
import { isMac, modKey } from '../platform/env.ts';
import { LocalAISetup } from './LocalAISetup.tsx';
import { Segmented, cx, relativeTime } from './primitives.tsx';

/**
 * Search everything, from anywhere (Ctrl/⌘-K; the library search field on touch screens): notes,
 * passages of typed text, handwriting and PDF text with the exact page, notebooks and tags, and
 * the app's own actions. "Ask" answers a question from all notes with numbered citations that open
 * the note at the cited words.
 */

interface Row {
  key: string;
  group: string;
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  hint?: string;
  run: () => void;
}

/** Renders «matched» words from a snippet as <mark>. */
export function Marked({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith('«') && p.endsWith('»') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

const SOURCE_ICON: Record<RankedChunk['chunk']['source'], ReactNode> = {
  handwriting: <PenLine size={16} />,
  text: <Type size={16} />,
  pdf: <FileText size={16} />,
  meta: <NotebookPen size={16} />,
  speech: <AudioLines size={16} />,
};

function useGlobalActions() {
  useEffect(() => registerPaletteActions('app', () => {
    const app = useApp.getState();
    const s = useSettings.getState();
    const theme = s.theme;
    return [
      { id: 'new-note', label: 'New note', keywords: 'create page write', hint: `${modKey}N`, icon: <FilePlus2 size={16} />, run: async () => { const id = await createNote(); if (id) app.navigate({ name: 'editor', noteId: id }); } },
      { id: 'import', label: 'Import PDF or image', keywords: 'open file upload annotate', icon: <FileUp size={16} />, run: async () => { const files = await pickFiles('application/pdf,image/*,.zip', true); const id = await importFiles(files); if (id) app.navigate({ name: 'editor', noteId: id }); } },
      { id: 'library', label: 'All notes', keywords: 'library home', icon: <BookOpen size={16} />, run: () => { app.setFilter({ kind: 'all' }); app.navigate({ name: 'library' }); } },
      { id: 'sound', label: s.feel.sound ? 'Turn writing sound off' : 'Turn writing sound on', keywords: 'writing sound audio feel quiet mute', hint: s.feel.sound ? 'On' : 'Off', icon: <AudioLines size={16} />, run: () => s.update((x) => ({ feel: { ...x.feel, sound: !x.feel.sound } })) },
      { id: 'theme', label: theme === 'dark' ? 'Light appearance' : 'Dark appearance', keywords: 'theme dark mode night light appearance', icon: theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />, run: () => s.update(() => ({ theme: theme === 'dark' ? 'light' : 'dark' })) },
      { id: 'ai-settings', label: 'AI settings', keywords: 'on-device model download provider key ollama lm studio semantic search', icon: <Cpu size={16} />, run: () => app.navigate({ name: 'settings', section: 'ai' }) },
      { id: 'settings', label: 'Settings', keywords: 'preferences options', icon: <SettingsIcon size={16} />, run: () => app.navigate({ name: 'settings' }) },
    ] satisfies PaletteAction[];
  }), []);
}

export function Palette() {
  const { open, mode, query } = usePalette();
  useGlobalActions();

  // Ctrl/⌘-K anywhere toggles the palette; citation links in any rendered text open their place.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        if (usePalette.getState().open) closePalette();
        else openPalette({ query: '' });
      }
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#mem/"]');
      if (!a) return;
      const anchor = parseMemoryLink(a.getAttribute('href') ?? '');
      if (!anchor) return;
      e.preventDefault();
      closePalette();
      openAnchor(anchor);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick);
    return () => { window.removeEventListener('keydown', onKey, true); document.removeEventListener('click', onClick); };
  }, []);

  if (!open) return null;
  return createPortal(
    <div className="pal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closePalette(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={mode === 'ask' ? 'Ask your notes' : 'Search everything'}>
        <PaletteBody mode={mode} query={query} />
      </div>
    </div>,
    document.body,
  );
}

function PaletteBody({ mode, query }: { mode: PaletteMode; query: string }) {
  const input = useRef<HTMLInputElement>(null);
  const setQuery = (q: string) => usePalette.setState({ query: q });
  const setMode = (m: PaletteMode) => { usePalette.setState({ mode: m }); input.current?.focus(); };
  const ask = useRef<{ run: () => void } | null>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  return (
    <>
      <div className="pal-top">
        {mode === 'ask' ? <MessageCircleQuestion size={18} aria-hidden /> : <Search size={18} aria-hidden />}
        <input ref={input} className="pal-input" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === 'ask' ? 'Ask anything about your notes' : 'Search notes, handwriting, PDFs and actions'}
          aria-label={mode === 'ask' ? 'Question' : 'Search'}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
            else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); setMode(mode === 'ask' ? 'search' : 'ask'); }
            else if (mode === 'ask' && e.key === 'Enter') { e.preventDefault(); ask.current?.run(); }
          }} />
        <Segmented label="Mode" value={mode} onChange={setMode} options={[{ value: 'search', label: 'Search' }, { value: 'ask', label: 'Ask' }]} />
        <button type="button" className="icon-btn pal-close" aria-label="Close search" onClick={closePalette}><X size={18} /></button>
      </div>
      {mode === 'search' ? <SearchResults query={query} inputRef={input} onAsk={() => setMode('ask')} /> : <AskPanel query={query} handle={ask} />}
    </>
  );
}

// ---- Search ---------------------------------------------------------------------------------------

function SearchResults({ query, inputRef, onAsk }: { query: string; inputRef: React.RefObject<HTMLInputElement | null>; onAsk: () => void }) {
  const { notes, notebooks, navigate, setFilter } = useApp();
  const status = useMemoryStatus();
  const [passages, setPassages] = useState<RankedChunk[]>([]);
  const [semantic, setSemantic] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim();

  // Keyword results instantly; semantic results replace them a moment later.
  useEffect(() => {
    const mem = appMemory();
    if (!q || !mem) { setPassages([]); setSemantic(false); return; }
    setPassages(mem.searchNow(q, { limit: 12 }));
    setSemantic(false);
    const ac = new AbortController();
    const t = setTimeout(() => {
      void mem.search(q, { limit: 12, signal: ac.signal }).then((r) => { if (!ac.signal.aborted && r.semantic) { setPassages(r.results); setSemantic(true); } }).catch(() => {});
    }, 220);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q, notes, status.version]);

  const done = () => closePalette();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const titleHits = q
      ? notes.map((n) => ({ n, s: matchScore(q, n.title) * 2 + matchScore(q, n.tags.join(' ')) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt).slice(0, 5).map((x) => x.n)
      : [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
    for (const n of titleHits) {
      out.push({ key: `note:${n.id}`, group: q ? 'Notes' : 'Recent notes', icon: <NotebookPen size={16} />, title: n.title || 'Untitled', detail: relativeTime(n.updatedAt), run: () => { done(); navigate({ name: 'editor', noteId: n.id }); } });
    }
    for (const r of passages) {
      const c = r.chunk;
      if (c.source === 'meta' && titleHits.some((n) => n.id === c.noteId)) continue;
      out.push({
        key: `chunk:${c.id}`,
        group: 'In your notes',
        icon: SOURCE_ICON[c.source],
        title: <><span className="pal-note">{c.title}</span><span className="pal-page">p. {c.pageIndex + 1} · {sourceKindLabel(c)}</span></>,
        detail: <Marked text={r.snippet} />,
        run: () => {
          done();
          openAnchor(anchorOf(toSources([r])[0]!));
        },
      });
    }
    if (q) {
      for (const nb of notebooks.filter((b) => matchScore(q, b.name) > 0).slice(0, 3)) {
        out.push({ key: `nb:${nb.id}`, group: 'Notebooks and tags', icon: <BookOpen size={16} />, title: nb.name, run: () => { done(); setFilter({ kind: 'notebook', id: nb.id }); navigate({ name: 'library' }); } });
      }
      const tags = [...new Set(notes.flatMap((n) => n.tags))].filter((t) => matchScore(q.replace(/^#/, ''), t) > 0).slice(0, 4);
      for (const t of tags) out.push({ key: `tag:${t}`, group: 'Notebooks and tags', icon: <Hash size={16} />, title: `#${t}`, run: () => { done(); setFilter({ kind: 'tag', tag: t }); navigate({ name: 'library' }); } });
      out.push({ key: 'ask', group: 'Ask', icon: <Sparkles size={16} />, title: <>Ask your notes: “{q}”</>, hint: 'Tab', run: onAsk });
    }
    for (const a of findActions(q, q ? 6 : 8)) {
      out.push({ key: `act:${a.id}`, group: 'Actions', icon: a.icon ?? <ArrowRight size={16} />, title: a.label, hint: a.hint, run: () => { done(); void a.run(); } });
    }
    return out;
  }, [q, notes, notebooks, passages]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Arrow keys and Enter act on the list while focus stays in the search field.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); rows[active]?.run(); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [rows, active, inputRef]);

  let lastGroup = '';
  return (
    <>
      <div className="pal-list" ref={listRef} role="listbox" aria-label="Results">
        {q && rows.every((r) => r.group === 'Actions' || r.group === 'Ask') && (
          <p className="pal-empty">Nothing in your notes matches “{q}”. Handwriting becomes searchable once it is recognized.</p>
        )}
        {rows.map((r, i) => {
          const head = r.group !== lastGroup ? r.group : null;
          lastGroup = r.group;
          return (
            <div key={r.key}>
              {head && <div className="pal-group">{head}</div>}
              <button type="button" role="option" aria-selected={i === active} data-index={i} className={cx('pal-row', i === active && 'is-active')}
                onPointerMove={() => setActive(i)} onClick={r.run}>
                <span className="pal-icon">{r.icon}</span>
                <span className="pal-text">
                  <span className="pal-title">{r.title}</span>
                  {r.detail && <span className="pal-detail">{r.detail}</span>}
                </span>
                {r.hint && <span className="pal-hint">{r.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
      <div className="pal-foot">
        <span>{status.embedder && semantic ? `Searching by meaning and keywords · ${status.embedder}` : status.embedder ? `Keyword results · meaning search ready for ${status.embedded} of ${status.passages} passages` : 'Keyword search'}</span>
        {!status.embedder && <button type="button" className="link-btn" onClick={() => { closePalette(); useApp.getState().navigate({ name: 'settings', section: 'ai' }); }}>Search by meaning</button>}
        <span className="pal-keys">↑↓ Enter · Tab to ask</span>
      </div>
    </>
  );
}

// ---- Ask ------------------------------------------------------------------------------------------

type AskState =
  | { phase: 'idle' }
  | { phase: 'needs-ai' }
  | { phase: 'working'; question: string; sources: AskSource[]; answer: string; label: string }
  | { phase: 'done'; question: string; sources: AskSource[]; answer: string; label: string }
  | { phase: 'error'; message: string };

function AskPanel({ query, handle }: { query: string; handle: React.MutableRefObject<{ run: () => void } | null> }) {
  const [st, setSt] = useState<AskState>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const notes = useApp((s) => s.notes);
  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    const q = query.trim();
    const mem = appMemory();
    if (!q || !mem) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const ai = await getActiveAI({ task: 'chat', source: 'ask' }).catch(() => null);
    if (!ai) { setSt({ phase: 'needs-ai' }); return; }
    setSt({ phase: 'working', question: q, sources: [], answer: '', label: ai.label });
    try {
      const saw = (ids: string[]) => ids.forEach((id) => { const l = noteLabelOf(id); if (l) ai.trust?.see(l); });
      const r = await askNotes(q, { search: (x, o) => mem.search(x, o), ai, updatedAt: (id) => notes.find((n) => n.id === id)?.updatedAt, canSee: aiCanSee, saw }, {
        signal: ac.signal,
        onSources: (sources) => setSt((s) => (s.phase === 'working' ? { ...s, sources } : s)),
        onDelta: (answer) => setSt((s) => (s.phase === 'working' ? { ...s, answer } : s)),
      });
      if (!ac.signal.aborted) setSt({ phase: 'done', question: q, sources: r.sources, answer: r.answer, label: r.label });
    } catch (e) {
      if (!ac.signal.aborted) setSt({ phase: 'error', message: (e as Error).message });
    }
  };
  handle.current = { run: () => void run() };

  const go = (s: AskSource) => { closePalette(); openAnchor(anchorOf(s)); };

  return (
    <div className="pal-ask">
      {st.phase === 'idle' && (
        <div className="pal-ask-intro">
          <p>Ask a question and get an answer from everything you’ve written, with links to the exact page.</p>
          <p className="muted">For example: “What did the professor say about Fourier transforms?”</p>
          <button type="button" className="btn btn-primary" disabled={!query.trim()} onClick={() => void run()}><Sparkles size={15} /> Ask</button>
        </div>
      )}
      {st.phase === 'needs-ai' && (
        <div className="pal-ask-intro">
          <LocalAISetup compact onReady={() => void run()} />
          <button type="button" className="link-btn" onClick={() => { closePalette(); useApp.getState().navigate({ name: 'settings', section: 'ai' }); }}><Bot size={15} /> Or connect an AI provider</button>
        </div>
      )}
      {st.phase === 'error' && <p className="pal-error" role="alert">{st.message}</p>}
      {(st.phase === 'working' || st.phase === 'done') && (
        <>
          <div className="pal-answer" aria-live="polite">
            {st.answer ? <Answer text={st.answer} sources={st.sources} onCite={go} /> : <p className="muted">{st.sources.length ? 'Reading your notes…' : 'Searching your notes…'}</p>}
          </div>
          {st.sources.length > 0 && (
            <ol className="pal-sources" aria-label="Sources">
              {st.sources.map((s) => (
                <li key={s.n}>
                  <button type="button" className="pal-source" onClick={() => go(s)}>
                    <span className="pal-cite-n">{s.n}</span>
                    <span className="pal-text">
                      <span className="pal-title"><span className="pal-note">{s.title}</span><span className="pal-page">p. {s.pageIndex + 1} · {sourceKindLabel(s)}</span></span>
                      <span className="pal-detail"><Marked text={s.snippet} /></span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="pal-foot">
            <span>Answered by {st.label}</span>
            {st.phase === 'working' && <button type="button" className="link-btn" onClick={() => abort.current?.abort()}><Square size={12} /> Stop</button>}
          </div>
        </>
      )}
    </div>
  );
}

function Answer({ text, sources, onCite }: { text: string; sources: AskSource[]; onCite: (s: AskSource) => void }) {
  const { segments } = parseAnswerCitations(text, sources.length);
  return (
    <p className="pal-answer-text">
      {segments.map((s, i) => {
        if (s.type === 'text') return <span key={i}>{s.text}</span>;
        const src = sources[s.n - 1]!;
        return (
          <button key={i} type="button" className="pal-cite" title={`${src.title}, page ${src.pageIndex + 1}`} aria-label={`Source ${s.n}: ${src.title}, page ${src.pageIndex + 1}`} onClick={() => onCite(src)}>{s.n}</button>
        );
      })}
    </p>
  );
}
