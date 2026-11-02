import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Maximize, Pause, Play, Search, X } from 'lucide-react';
import { ForceLayout, buildGraph, fuzzyScore, type GraphData, type Vec3 } from '@inkstone/core';
import { useApp } from '../state/app.ts';
import { useKnowledge } from '../state/knowledge.ts';
import { useSettings } from '../state/settings.ts';
import { onRelatedProviderChange, relatedForAll } from '../lib/related.ts';
import { IconButton, Segmented, cx, relativeTime } from '../ui/primitives.tsx';
import { argbCss } from '../ui/knowledge/color.ts';
import { Graph2D } from './render2d.ts';
import { displayGraph, prefersReducedMotion, readTheme, type DisplayGraph, type GraphRenderer } from './scene.ts';
import './graph.css';

declare const __E2E__: boolean;
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

/** Test hook (e2e builds only): what the graph shows and a way to drive it. */
export interface GraphTestHook {
  renderer: '3d' | '2d';
  frames: () => number;
  nodes: { id: string; kind: string; label: string; visible: boolean }[];
  edges: number;
  select: (id: string) => void;
}

const DAY = 864e5;

/**
 * The graph of your notes, full screen: every note an ink drop in its notebook's colour, links as
 * threads, tags and notebooks joining them, related notes faintly dotted; 3D (three.js, loaded only
 * here) or flat 2D. Search lights notes up, filters narrow it, and the time slider replays how the
 * knowledge grew. Click a note to focus it (the jade stone-eye marks it); click again to open.
 */
export default function GraphView() {
  const { vault, notes, notebooks, navigate, toast } = useApp();
  const prefs = useKnowledge();
  const theme = useSettings((s) => s.theme);
  const palette = useSettings((s) => s.palette);
  const host = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [renderer, setRenderer] = useState<GraphRenderer | null>(null);
  const [notebookId, setNotebookId] = useState('');
  const [tag, setTag] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [thumb, setThumb] = useState<{ id: string; url: string | null } | null>(null);
  const [related, setRelated] = useState<Map<string, { id: string; score: number }[]> | null>(null);
  const [relatedTick, setRelatedTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [webgl3d, setWebgl3d] = useState(true);
  const reduced = useMemo(prefersReducedMotion, []);
  const mode = prefs.graph.mode === '3d' && webgl3d ? '3d' : '2d';
  const k = vault?.knowledge;

  // ---- Data ---------------------------------------------------------------------------------
  useEffect(() => onRelatedProviderChange(() => setRelatedTick((x) => x + 1)), []);
  useEffect(() => {
    if (!prefs.graph.related || !k) { setRelated(null); return; }
    let alive = true;
    void relatedForAll(k.notes().map((n) => n.id), 4).then((m) => alive && setRelated(m));
    return () => { alive = false; };
  }, [prefs.graph.related, k, notes, relatedTick]);

  const data: GraphData | null = useMemo(() => {
    if (!k) return null;
    return buildGraph(k, notebooks, {
      tags: prefs.graph.tags, notebooks: prefs.graph.notebooks,
      notebookIds: notebookId ? [notebookId] : undefined, tag: tag || undefined,
      related: prefs.graph.related ? related ?? undefined : undefined,
    });
  }, [k, notes, notebooks, prefs.graph.tags, prefs.graph.notebooks, prefs.graph.related, notebookId, tag, related]); // eslint-disable-line react-hooks/exhaustive-deps

  const positions = useRef<Map<string, Vec3>>(new Map());
  const layout = useMemo(() => {
    if (!data) return null;
    const l = new ForceLayout(data, { dims: mode === '3d' ? 3 : 2, initial: positions.current });
    // Settle most of the way before the first frame; the rest eases in on screen.
    l.run(reduced ? 600 : positions.current.size ? 30 : 140);
    return l;
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (layout) positions.current = layout.positions(); }, [layout]);
  useEffect(() => { if (layout) { layout.setDims(mode === '3d' ? 3 : 2); if (reduced) layout.run(600); } }, [layout, mode, reduced]);

  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setThemeTick((x) => x + 1)); return () => cancelAnimationFrame(id); }, [theme, palette]);
  const graphTheme = useMemo(() => readTheme(), [themeTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const display: DisplayGraph | null = useMemo(() => (data ? displayGraph(data, graphTheme) : null), [data, graphTheme]);

  // ---- Renderer -------------------------------------------------------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    let r: GraphRenderer | null = null;
    (async () => {
      if (mode === '3d') {
        try {
          const m = await import('./render3d.ts');
          if (!m.webglAvailable()) throw new Error('WebGL unavailable');
          if (!alive) return;
          r = new m.Graph3D(el, readTheme());
        } catch (e) {
          console.warn('3D graph unavailable, showing it flat', e);
          if (alive) { setWebgl3d(false); toast({ text: 'This device can’t show the graph in 3D, so it’s flat here.' }); }
          return;
        }
      } else r = new Graph2D(el, readTheme());
      if (alive) setRenderer(r);
      else r.destroy();
    })();
    const ro = new ResizeObserver(() => r?.resize());
    ro.observe(el);
    return () => { alive = false; ro.disconnect(); r?.destroy(); setRenderer(null); };
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { renderer?.setTheme(graphTheme); }, [renderer, graphTheme]);
  const fitted = useRef<GraphRenderer | null>(null);
  useEffect(() => {
    if (!renderer || !display || !layout) return;
    renderer.setGraph(display, layout);
    if (fitted.current !== renderer) { fitted.current = renderer; renderer.fit(false); }
  }, [renderer, display, layout]);

  // ---- Time -----------------------------------------------------------------------------------
  const span = useMemo(() => {
    const times = display?.nodes.filter((n) => n.kind === 'note').map((n) => n.createdAt) ?? [];
    const min = times.length ? Math.min(...times) : Date.now();
    return { min, max: Math.max(Date.now(), min + DAY) };
  }, [display]);
  const [until, setUntil] = useState<number | null>(null);
  const t = until ?? span.max;

  useEffect(() => {
    if (!playing) return;
    const total = reduced ? 10 : 9000 / 16;
    let step = 0;
    const tick = () => {
      step++;
      const v = span.min + ((span.max - span.min) * step) / total;
      setUntil(v >= span.max ? null : v);
      if (v >= span.max) setPlaying(false);
    };
    const id = setInterval(tick, reduced ? 600 : 16);
    return () => clearInterval(id);
  }, [playing, span, reduced]);

  const matches = useMemo(() => {
    const q = query.trim();
    if (!q || !display) return null;
    const hits = new Set<string>();
    for (const n of display.nodes) if (fuzzyScore(q, n.label) >= 0) hits.add(n.id);
    // Text inside notes too (typed and recognized handwriting).
    for (const h of vault?.search.search(q, { limit: 80 }) ?? []) hits.add(h.noteId);
    return hits;
  }, [query, display, vault]);

  const targets = useMemo(() => {
    if (!display) return new Float32Array(0);
    return Float32Array.from(display.nodes, (n) => (n.createdAt > t + 1 ? 0 : matches && !matches.has(n.id) ? 0.16 : 1));
  }, [display, t, matches]);
  useEffect(() => { renderer?.setTargets(targets); }, [renderer, targets]);

  useEffect(() => { renderer?.setSelected(selected); }, [renderer, selected, display]);
  useEffect(() => { renderer?.setHovered(hover?.id ?? null); }, [renderer, hover?.id]);

  const labels = useMemo(() => {
    if (!display) return [];
    const ids = new Set<string>();
    for (const n of display.nodes) if (n.kind === 'notebook') ids.add(n.id);
    [...display.nodes].filter((n) => n.kind === 'note').sort((a, b) => b.size - a.size).slice(0, display.nodes.length > 200 ? 4 : 7).forEach((n) => ids.add(n.id));
    if (matches) [...matches].slice(0, 12).forEach((id) => ids.add(id));
    if (selected) {
      ids.add(selected);
      const i = display.index.get(selected);
      let c = 0;
      for (const e of display.edges) {
        if (c >= 14 || i == null) break;
        if (e.s === i) { ids.add(display.nodes[e.t]!.id); c++; } else if (e.t === i) { ids.add(display.nodes[e.s]!.id); c++; }
      }
    }
    if (hover) ids.add(hover.id);
    return [...ids];
  }, [display, matches, selected, hover]);
  useEffect(() => { renderer?.setLabels(labels); }, [renderer, labels]);

  // ---- Interaction ----------------------------------------------------------------------------
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const nodeById = useCallback((id: string) => display?.nodes[display.index.get(id) ?? -1], [display]);
  const select = useCallback((id: string | null) => {
    setSelected(id);
    if (id) renderer?.focus(id, !reduced);
  }, [renderer, reduced]);

  const open = useCallback((id: string) => {
    const n = nodeById(id);
    if (n?.kind === 'note') navigate({ name: 'editor', noteId: id });
    else if (n?.kind === 'tag') { setTag(n.label.replace(/^#/, '')); setSelected(null); }
    else if (n?.kind === 'notebook') { setNotebookId(id.replace(/^nb:/, '')); setSelected(null); }
  }, [nodeById, navigate]);

  useEffect(() => {
    const el = host.current;
    if (!el || !renderer) return;
    let down: { x: number; y: number } | null = null;
    let raf = 0;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
      down = null;
      const id = renderer.pick(e.clientX, e.clientY);
      if (!id) { setSelected(null); return; }
      if (id === selectedRef.current) open(id);
      else select(id);
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const id = renderer.pick(e.clientX, e.clientY);
        const r = el.getBoundingClientRect();
        setHover(id ? { id, x: e.clientX - r.left, y: e.clientY - r.top } : null);
        el.style.cursor = id ? 'pointer' : '';
      });
    };
    const onLeave = () => setHover(null);
    const onDbl = (e: MouseEvent) => { const id = renderer.pick(e.clientX, e.clientY); if (id) open(id); };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('dblclick', onDbl);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('dblclick', onDbl);
    };
  }, [renderer, open, select]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const typing = tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (typing && query) { setQuery(''); return; }
        if (selectedRef.current) setSelected(null);
        else if (!typing) navigate({ name: 'library' });
      } else if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'Enter' && selectedRef.current && !typing) open(selectedRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, open, query]);

  // Thumbnails on hover (and for the selected note).
  const peek = hover?.id ?? selected;
  useEffect(() => {
    if (!peek || !vault) return;
    const note = notes.find((n) => n.id === peek);
    if (!note) { setThumb(null); return; }
    let alive = true;
    void vault.thumbnail(note).then((url) => alive && setThumb({ id: peek, url }));
    return () => { alive = false; };
  }, [peek, vault, notes]);

  // Test hook.
  useEffect(() => {
    if (!E2E_BUILD || !renderer || !display) return;
    const hook: GraphTestHook = {
      renderer: renderer.kind,
      frames: () => renderer.frames,
      nodes: display.nodes.map((n, i) => ({ id: n.id, kind: n.kind, label: n.label, visible: targets[i]! > 0.5 })),
      edges: display.edges.length,
      select: (id) => select(id),
    };
    (window as unknown as { __inkstoneGraph?: GraphTestHook }).__inkstoneGraph = hook;
    return () => { delete (window as unknown as { __inkstoneGraph?: GraphTestHook }).__inkstoneGraph; };
  }, [renderer, display, targets, select]);

  // ---- UI --------------------------------------------------------------------------------------
  const tags = useMemo(() => k?.allTags() ?? [], [k, notes]); // eslint-disable-line react-hooks/exhaustive-deps
  const noteCount = display?.nodes.filter((n, i) => n.kind === 'note' && targets[i]! > 0.5).length ?? 0;
  const linkCount = display?.edges.filter((e) => e.kind === 'link' && targets[e.s]! > 0.5 && targets[e.t]! > 0.5).length ?? 0;
  const setGraphPref = (p: Partial<typeof prefs.graph>) => prefs.update((x) => ({ graph: { ...x.graph, ...p } }));
  const sel = selected ? nodeById(selected) : undefined;
  const selNote = sel?.kind === 'note' ? notes.find((n) => n.id === sel.id) : undefined;
  const hoverNode = hover ? nodeById(hover.id) : undefined;

  const describe = (id: string) => {
    const n = nodeById(id);
    if (!n) return null;
    if (n.kind === 'tag' || n.kind === 'notebook') {
      const i = display!.index.get(id)!;
      const count = display!.edges.filter((e) => (e.s === i || e.t === i) && display!.nodes[e.s === i ? e.t : e.s]!.kind === 'note').length;
      return { title: n.label, meta: `${n.kind === 'tag' ? 'Tag' : 'Notebook'} · ${count === 1 ? '1 note' : `${count} notes`}`, snippet: '' };
    }
    const note = notes.find((x) => x.id === id);
    const nb = notebooks.find((b) => b.id === note?.notebookId);
    return { title: n.label, meta: [nb?.name, note ? `edited ${relativeTime(note.updatedAt)}` : ''].filter(Boolean).join(' · '), snippet: k?.snippet(id, 150) ?? '', color: nb?.color };
  };
  const hoverInfo = hover && hover.id !== selected ? describe(hover.id) : null;
  const selInfo = selected ? describe(selected) : null;
  const backlinkCount = selNote && k ? k.backlinks(selNote.id, notebooks).length : 0;
  const outCount = selNote && k ? k.outgoing(selNote.id, notebooks).filter((o) => o.note).length : 0;

  return (
    <div className={cx('graph-screen', `is-${mode}`)}>
      <header className="graph-top">
        <IconButton label="Back to library" onClick={() => navigate({ name: 'library' })}><ArrowLeft size={20} /></IconButton>
        <h1 className="graph-title">Graph</h1>
        <label className="search graph-search">
          <Search size={17} aria-hidden />
          <input ref={searchRef} type="search" placeholder="Find in the graph" aria-label="Find in the graph" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches?.size) { const first = display?.nodes.find((n) => matches.has(n.id) && n.kind === 'note'); if (first) select(first.id); } }} />
          {query && <button type="button" className="search-clear" aria-label="Clear" onClick={() => setQuery('')}><X size={15} /></button>}
        </label>
        <Segmented label="Graph view" value={mode} onChange={(v) => { if (v === '3d' && !webgl3d) { toast({ text: '3D isn’t available on this device.' }); return; } setGraphPref({ mode: v }); }}
          options={[{ value: '3d', label: '3D' }, { value: '2d', label: '2D' }]} />
      </header>
      <div className="graph-filters" role="toolbar" aria-label="Graph filters">
        <select value={notebookId} onChange={(e) => setNotebookId(e.target.value)} aria-label="Notebook">
          <option value="">All notebooks</option>
          {notebooks.map((nb) => <option key={nb.id} value={nb.id}>{nb.name}</option>)}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">All tags</option>
          {tags.map((x) => <option key={x.tag} value={x.tag}>#{x.tag}</option>)}
        </select>
        <button type="button" className={cx('chip', prefs.graph.tags && 'is-on')} aria-pressed={prefs.graph.tags} onClick={() => setGraphPref({ tags: !prefs.graph.tags })}>Tags</button>
        <button type="button" className={cx('chip', prefs.graph.notebooks && 'is-on')} aria-pressed={prefs.graph.notebooks} onClick={() => setGraphPref({ notebooks: !prefs.graph.notebooks })}>Notebooks</button>
        <button type="button" className={cx('chip', prefs.graph.related && 'is-on')} aria-pressed={prefs.graph.related} onClick={() => setGraphPref({ related: !prefs.graph.related })}>Related</button>
        <span className="graph-count" aria-live="polite">{noteCount === 1 ? '1 note' : `${noteCount} notes`} · {linkCount === 1 ? '1 link' : `${linkCount} links`}</span>
        <IconButton label="Fit to screen" onClick={() => renderer?.fit(!reduced)}><Maximize size={17} /></IconButton>
      </div>

      <div ref={host} className="graph-host" aria-label={`Graph of ${noteCount} notes`} role="img" />

      {!!display && display.nodes.filter((n) => n.kind === 'note').length === 0 && (
        <div className="graph-empty"><p>No notes to show{notebookId || tag ? ' with these filters' : ''}.</p></div>
      )}

      {hoverInfo && hover && (
        <div className="graph-peek" style={{ left: hover.x, top: hover.y }} role="tooltip">
          {thumb?.id === hover.id && thumb.url && <img src={thumb.url} alt="" />}
          <div className="graph-peek-text">
            <span className="graph-peek-title">{hoverInfo.title}</span>
            <span className="graph-peek-meta">{hoverInfo.meta}</span>
            {hoverInfo.snippet && <span className="graph-peek-snippet">{hoverInfo.snippet}</span>}
          </div>
        </div>
      )}

      {selInfo && sel && (
        <aside className="graph-card" aria-label="Selected note">
          <div className="graph-card-head">
            {selInfo.color && <span className="nb-dot" style={{ background: argbCss(selInfo.color) }} />}
            <h2>{selInfo.title}</h2>
            <IconButton label="Close" onClick={() => setSelected(null)}><X size={16} /></IconButton>
          </div>
          {thumb?.id === sel.id && thumb.url && <img className="graph-card-thumb" src={thumb.url} alt="" />}
          <p className="graph-card-meta">{selInfo.meta}{selNote ? ` · ${backlinkCount} linked here · ${outCount} out` : ''}</p>
          {selInfo.snippet && <p className="graph-card-snippet">{selInfo.snippet}</p>}
          {selNote && k && k.tagsOf(selNote.id).length > 0 && <p className="graph-card-tags">{k.tagsOf(selNote.id).map((x) => `#${x}`).join('  ')}</p>}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => open(sel.id)}>
            {sel.kind === 'note' ? <><ArrowUpRight size={15} /> Open note</> : sel.kind === 'tag' ? 'Show only this tag' : 'Show only this notebook'}
          </button>
        </aside>
      )}

      <footer className="graph-time">
        <IconButton label={playing ? 'Pause' : 'Watch it grow'} onClick={() => { if (!playing && until == null) setUntil(span.min); setPlaying(!playing); }}>{playing ? <Pause size={17} /> : <Play size={17} />}</IconButton>
        <input type="range" className="graph-slider" min={0} max={1000} step={1} aria-label="Show notes created until"
          value={Math.round(((t - span.min) / (span.max - span.min)) * 1000)}
          onChange={(e) => { setPlaying(false); const v = span.min + ((span.max - span.min) * Number(e.target.value)) / 1000; setUntil(Number(e.target.value) >= 1000 ? null : v); }} />
        <span className="graph-date">{until == null ? 'Today' : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
      </footer>
    </div>
  );
}
