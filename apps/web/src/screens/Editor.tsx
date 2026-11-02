import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Camera, CloudUpload, Undo2, Redo2, Download, FileImage, FileText, FileType2, Files, Image as ImageIcon, Layers,
  AudioLines, Mic, MoreHorizontal, VolumeX, Pause, Play, Sparkles, Square, Tag, Trash2, ZoomIn, ZoomOut, Maximize2, FilePlus2, Copy, Scan,
} from 'lucide-react';
import { newId, PAGE_SIZE_PRESETS, pagePaper, pageSizeOf, type ImageItem, type InkStroke, type TextBox } from '@inkstone/core';
import { InkEngine, type SelectionInfo, type Tool, type ToolState } from '../canvas/engine.ts';
import { inspectPdf } from '../canvas/assets.ts';
import { EditorSession } from '../lib/session.ts';
import { exportNote, type ExportFormat } from '../lib/exporter.ts';
import { Recorder, audioExt, formatDuration } from '../lib/audio.ts';
import { imageSize, setTags, trashNote, duplicateNote } from '../lib/actions.ts';
import { PaperFeel } from '../platform/feel.ts';
import { NativeInkTip } from '../platform/inktip.ts';
import { InkstoneNative, hasNativePlugin } from '../platform/native.ts';
import { pickFiles } from '../platform/files.ts';
import { isArtifact, isMac, modKey, safeStorage } from '../platform/env.ts';
import { useApp } from '../state/app.ts';
import { activePreset, inputPrefs, useSettings } from '../state/settings.ts';
import { PenDock } from '../ui/PenDock.tsx';
import { SelectionBar } from '../ui/SelectionBar.tsx';
import { TextOverlay } from '../ui/TextOverlay.tsx';
import { PagesPanel } from '../ui/PagesPanel.tsx';
import { PaperPicker } from '../ui/NewNoteSheet.tsx';
import { FeelPanel } from '../ui/FeelPanel.tsx';
import { AIPanel, type AIRequest } from '../ui/AIPanel.tsx';
import { IconButton, Menu, Popover, cx, useMediaQuery } from '../ui/primitives.tsx';
import { askConfirm, askText } from '../ui/prompts.tsx';
import { isAIReady, transcribePage } from '../lib/ai.ts';

declare const __E2E__: boolean;
/** Test builds (`vite build --mode e2e`) expose the document to end-to-end tests; releases never do. */
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

/** Clipboard for ink between notes (system clipboard can't hold ink). */
let inkClipboard: { noteId: string; strokes: InkStroke[]; texts: TextBox[]; images: ImageItem[] } | null = null;

export function Editor({ noteId, initialPage }: { noteId: string; initialPage?: number }) {
  const { vault, navigate, toast } = useApp();
  const settings = useSettings();
  const wide = useMediaQuery('(min-width: 900px)');
  const narrow = useMediaQuery('(max-width: 699px)');
  // A side dock only where there's room beside the page; foldables and tablets use the bottom tray.
  const sideDock = useMediaQuery('(min-width: 1100px)');
  const host = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [engine, setEngine] = useState<InkEngine | null>(null);
  const [missing, setMissing] = useState(false);
  const [tool, setToolState] = useState<Tool>('pen');
  const [latched, setLatched] = useState(false);
  const [view, setView] = useState({ zoom: 1, pageIndex: 0, pageCount: 1 });
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const [editingText, setEditingText] = useState<{ pageIndex: number; box: TextBox; isNew: boolean } | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [panel, setPanel] = useState<'pages' | 'ai' | null>(null);
  const [aiRequest, setAiRequest] = useState<AIRequest | null>(null);
  const [paperOpen, setPaperOpen] = useState(false);
  const [menu, setMenu] = useState<'export' | 'insert' | 'more' | 'feel' | null>(null);
  const [, bump] = useState(0);
  const feel = useMemo(() => new PaperFeel(settings.feel), []); // eslint-disable-line react-hooks/exhaustive-deps
  const inkTip = useMemo(() => new NativeInkTip(), []);
  const recorder = useRef(new Recorder());
  const [recording, setRecording] = useState<number | null>(null);
  const [playback, setPlayback] = useState<{ clipId: string; position: number; playing: boolean } | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  // Engine callbacks are bound once; they call through these refs so they always see fresh state.
  const live = useRef<{ seekTo: (t: number) => void; editText: (req: { pageIndex: number; box: TextBox; isNew: boolean }) => void }>(null!);
  const latestText = useRef<TextBox | null>(null);
  const btn = { paper: useRef<HTMLButtonElement>(null), export: useRef<HTMLButtonElement>(null), insert: useRef<HTMLButtonElement>(null), more: useRef<HTMLButtonElement>(null), feel: useRef<HTMLButtonElement>(null) };

  // ---- Open the note ---------------------------------------------------------------------------
  useEffect(() => {
    if (!vault) return;
    let s: EditorSession | null = null;
    let alive = true;
    void EditorSession.open(vault, noteId).then((x) => {
      if (!alive) { void x?.close(); return; }
      if (!x) return setMissing(true);
      s = x;
      x.onSaved = (st) => setSaveState(st === 'saving' ? 'saving' : st === 'error' ? 'error' : 'saved');
      setSession(x);
    });
    return () => { alive = false; void s?.close(); };
  }, [vault, noteId]);

  const doc = session?.doc ?? null;
  useEffect(() => (doc ? doc.subscribe(() => bump((x) => x + 1)) : undefined), [doc]);

  const toolState = useCallback((t: Tool): ToolState => {
    const s = useSettings.getState();
    return { tool: t, preset: activePreset(s), eraserMode: s.eraserMode, eraserSize: s.eraserSize };
  }, []);

  // ---- Engine ----------------------------------------------------------------------------------
  useEffect(() => {
    if (!session || !host.current || !vault) return;
    const vpKey = `inkstone.vp.${session.doc.meta.id}`;
    let initialViewport: { zoom: number; panX: number; panY: number } | undefined;
    try { const raw = safeStorage.get(vpKey); if (raw && initialPage == null) initialViewport = JSON.parse(raw); } catch { /* ignore */ }
    const e = new InkEngine(host.current, session.doc, {
      tool: toolState('pen'),
      prefs: inputPrefs(useSettings.getState()),
      loadAsset: (n, a) => vault.vault.readAsset(n, a),
      initialViewport,
    });
    e.feel = feel;
    feel.setPaper(pagePaper(session.doc.meta, session.doc.page(0)).texture);
    // Warm the audio path now so the first stroke sounds the instant the nib lands.
    feel.prepare();
    e.inkTip = inkTip;
    void inkTip.prepare(true);
    e.callbacks = {
      onViewport: (v) => setView(v),
      onSelection: setSel,
      onEditText: (req) => live.current.editText(req),
      onCommitted: (pageIndex, res) => {
        if (res.kind === 'scratched') toast({ text: `Scratched out ${res.erased} ${res.erased === 1 ? 'stroke' : 'strokes'}`, action: { label: 'Undo', run: () => e.undo() } });
        if (pageIndex >= 0) session.scheduleRecognition(pageIndex);
      },
      onButtonToggle: () => setLatched(e.buttonLatched),
      onSeek: (createdAt) => live.current.seekTo(createdAt),
      onViewportSaved: (v) => safeStorage.set(vpKey, JSON.stringify(v)),
    };
    setEngine(e);
    // Test hook (only with ?e2e in the URL): lets end-to-end tests inspect document state.
    if (E2E_BUILD) (window as any).__inkstone = { doc: session.doc, engine: e };
    if (initialPage != null) requestAnimationFrame(() => e.scrollToPage(initialPage));
    return () => { e.destroy(); setEngine(null); void inkTip.prepare(false); };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings → engine/feel.
  useEffect(() => {
    if (!engine) return;
    engine.setPrefs(inputPrefs(settings));
    engine.setTool(toolState(tool));
    feel.update(settings.feel);
  }, [engine, settings, tool, toolState, feel]);

  useEffect(() => {
    if (engine && doc) feel.setPaper(pagePaper(doc.meta, doc.pages[view.pageIndex]).texture);
  }, [engine, doc, view.pageIndex, feel, doc?.meta.paper]);

  useEffect(() => () => feel.dispose(), [feel]);

  // Moto Pen Ultra / S Pen / USI button via the Android plugin: hold = temporary, tap = toggle.
  useEffect(() => {
    if (!engine || !hasNativePlugin) return;
    let handle: { remove: () => void } | null = null;
    void InkstoneNative.addListener('stylusButton', (ev) => { engine.setExternalButton(ev.pressed); setLatched(engine.buttonLatched); }).then((h) => (handle = h));
    return () => handle?.remove();
  }, [engine]);

  const setTool = (t: Tool) => {
    setToolState(t);
    if (engine?.buttonLatched) { engine.setButtonLatched(false); setLatched(false); }
  };

  const selectPreset = (id: string) => {
    settings.update(() => ({ activePresetId: id }));
    setTool('pen');
  };

  // ---- Keyboard ----------------------------------------------------------------------------------
  useEffect(() => {
    if (!engine || !doc) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) engine.redo(); else engine.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); engine.redo(); return; }
      if (mod && k === 'a') { e.preventDefault(); engine.selectAll(); setTool('lasso'); return; }
      if (mod && k === 'c' && engine.hasSelection()) { e.preventDefault(); copySel(); return; }
      if (mod && k === 'x' && engine.hasSelection()) { e.preventDefault(); copySel(); engine.deleteSelection(); return; }
      if (mod && k === 'v' && inkClipboard) { e.preventDefault(); void pasteClipboard(); return; }
      if (mod && k === 'd' && engine.hasSelection()) { e.preventDefault(); engine.duplicateSelection(); return; }
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); engine.zoomBy(1.25); return; }
      if (mod && k === '-') { e.preventDefault(); engine.zoomBy(0.8); return; }
      if (mod && k === '0') { e.preventDefault(); engine.fitWidth(); return; }
      if (mod && k === 's') { e.preventDefault(); void session?.flush(); return; }
      if (mod && k === 'p') { e.preventDefault(); void doExport('pdf'); return; }
      if (mod || e.altKey) return;
      if ((k === 'delete' || k === 'backspace') && engine.hasSelection()) { e.preventDefault(); engine.deleteSelection(); return; }
      if (k === 'escape') { engine.clearSelection(); setPanel(null); return; }
      if (k === 'p') setTool('pen');
      else if (k === 'e') setTool('eraser');
      else if (k === 'l') setTool('lasso');
      else if (k === 't') setTool('text');
      else if (k === 'h') setTool('hand');
      else if (k === 'k') setTool('laser');
      else if (/^[1-9]$/.test(k)) { const p = useSettings.getState().tray[Number(k) - 1]; if (p) selectPreset(p.id); }
      else if (k === 'pagedown' || k === 'arrowright') engine.scrollToPage(Math.min(doc.pageCount - 1, engine.currentPageIndex + 1));
      else if (k === 'pageup' || k === 'arrowleft') engine.scrollToPage(Math.max(0, engine.currentPageIndex - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // re-bind each render: handlers close over current state

  const pasteClipboard = async () => {
    const clip = inkClipboard;
    if (!clip || !engine || !doc || !vault) return;
    // Images pasted into another note bring their files along.
    if (clip.noteId !== doc.meta.id) {
      for (const im of clip.images) {
        const bytes = await vault.vault.readAsset(clip.noteId, im.asset);
        if (bytes) await vault.vault.writeAsset(doc.meta.id, im.asset, bytes);
      }
    }
    engine.pasteItems(clip);
    setTool('lasso');
  };

  const copySel = () => {
    const items = engine?.getSelectionItems();
    if (items && doc) { inkClipboard = { noteId: doc.meta.id, strokes: items.strokes, texts: items.texts, images: items.images }; toast({ text: 'Copied' }); }
  };

  // ---- Text editing ------------------------------------------------------------------------------
  const commitText = (b: TextBox) => {
    if (!editingText || !doc || !engine) return;
    doc.upsertText(editingText.pageIndex, b, editingText.isNew ? 'Add text' : 'Edit text');
    engine.setEditingText(null);
    setEditingText(null);
    latestText.current = null;
  };

  const startTextEdit = (req: { pageIndex: number; box: TextBox; isNew: boolean }) => {
    // Tapping another box while editing saves the current one first.
    if (editingText && latestText.current && doc) doc.upsertText(editingText.pageIndex, latestText.current, editingText.isNew ? 'Add text' : 'Edit text');
    latestText.current = req.box;
    engine?.setEditingText(req.box.id);
    setEditingText(req);
  };

  const editSelectedText = () => {
    const items = engine?.getSelectionItems();
    const t = items?.texts[0];
    if (!engine || !items || !t) return;
    engine.clearSelection();
    startTextEdit({ pageIndex: items.pageIndex, box: t, isNew: false });
  };

  // ---- Insert ----------------------------------------------------------------------------------
  const insertImages = async (capture?: boolean) => {
    if (!doc || !engine || !vault) return;
    const files = await pickFiles('image/*', !capture, capture ? 'environment' : undefined);
    const pageIndex = engine.currentPageIndex;
    const c = engine.visibleCenter(pageIndex);
    const size = pageSizeOf(doc.meta, doc.page(pageIndex));
    let offset = 0;
    for (const f of files) {
      const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
      const asset = vault.newAssetName(ext);
      await vault.vault.writeAsset(doc.meta.id, asset, new Uint8Array(await f.arrayBuffer()));
      const dim = await imageSize(f);
      const maxW = (size.width || 800) * 0.7, maxH = (size.height || 800) * 0.6;
      const k = Math.min(1, maxW / dim.width, maxH / dim.height);
      const w = dim.width * k, h = dim.height * k;
      doc.addImage(pageIndex, { id: newId(), x: c.x - w / 2 + offset, y: c.y - h / 2 + offset, width: w, height: h, asset, rotation: 0, createdAt: Date.now() });
      offset += 24;
    }
    if (files.length) setTool('lasso');
  };

  const insertPdfPages = async () => {
    if (!doc || !vault || !engine) return;
    const [f] = await pickFiles('application/pdf', false);
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const info = await inspectPdf(bytes);
    const asset = vault.newAssetName('pdf');
    await vault.vault.writeAsset(doc.meta.id, asset, bytes);
    let at = engine.currentPageIndex + 1;
    info.sizes.forEach((s, i) => {
      doc.addPage(at++, { size: { name: 'PDF', width: s.width, height: s.height }, background: { kind: 'pdf', asset, pageNumber: i + 1 } });
    });
    toast({ text: `Added ${info.count} ${info.count === 1 ? 'page' : 'pages'} from ${f.name}`, tone: 'success' });
  };

  // ---- Audio -----------------------------------------------------------------------------------
  const toggleRecording = async () => {
    if (!doc || !vault) return;
    const r = recorder.current;
    if (r.recording) {
      const out = await r.stop();
      setRecording(null);
      if (!out) return;
      const asset = `${out.clip.id}.${audioExt(out.clip.mimeType)}`;
      await vault.vault.writeAsset(doc.meta.id, asset, new Uint8Array(await out.blob.arrayBuffer()));
      doc.updateMeta((m) => ({ ...m, recordings: [...(m.recordings ?? []), { ...out.clip, asset }] }));
      toast({ text: `Saved recording (${formatDuration(out.clip.durationMs)})`, tone: 'success' });
    } else {
      try {
        await r.start();
        setRecording(Date.now());
      } catch (e) {
        toast({ text: `Microphone unavailable: ${(e as Error).message}`, tone: 'error' });
      }
    }
  };

  useEffect(() => {
    if (recording == null) return;
    const id = setInterval(() => bump((x) => x + 1), 500);
    return () => clearInterval(id);
  }, [recording]);

  const clips = doc?.meta.recordings ?? [];

  const playClip = async (clipId: string, fromMs = 0) => {
    const clip = clips.find((c) => c.id === clipId);
    if (!clip || !vault || !doc) return;
    let a = audioEl.current;
    if (!a || a.dataset.clip !== clipId) {
      if (a) { a.pause(); URL.revokeObjectURL(a.src); }
      const bytes = await vault.vault.readAsset(doc.meta.id, clip.asset);
      if (!bytes) return toast({ text: 'Recording file is missing on this device', tone: 'error' });
      a = new Audio(URL.createObjectURL(new Blob([bytes as BlobPart], { type: clip.mimeType })));
      a.dataset.clip = clipId;
      a.ontimeupdate = () => {
        const pos = a!.currentTime * 1000;
        setPlayback((p) => (p ? { ...p, position: pos } : p));
        engine?.setPlayback({ start: clip.startedAt, position: pos });
      };
      a.onended = () => setPlayback((p) => (p ? { ...p, playing: false } : p));
      audioEl.current = a;
    }
    a.currentTime = fromMs / 1000;
    await a.play();
    setPlayback({ clipId, position: fromMs, playing: true });
    engine?.setPlayback({ start: clip.startedAt, position: fromMs });
  };

  const seekTo = (createdAt: number) => {
    const clip = [...clips].reverse().find((c) => createdAt >= c.startedAt && createdAt <= c.startedAt + c.durationMs);
    if (clip) void playClip(clip.id, Math.max(0, createdAt - clip.startedAt - 1500));
  };

  const stopPlayback = () => {
    audioEl.current?.pause();
    setPlayback(null);
    engine?.setPlayback(null);
  };

  live.current = { seekTo, editText: startTextEdit };

  // Leaving the editor stops playback and frees the audio.
  useEffect(() => () => {
    const a = audioEl.current;
    if (a) { a.pause(); URL.revokeObjectURL(a.src); }
    if (recorder.current.recording) void recorder.current.stop();
  }, []);

  // A note moved to Trash (e.g. by the assistant) closes the editor.
  useEffect(() => {
    if (doc?.meta.trashedAt != null) { void session?.flush().then(() => navigate({ name: 'library' })); }
  }, [doc?.meta.trashedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Export ----------------------------------------------------------------------------------
  const doExport = async (f: ExportFormat) => {
    if (!doc || !vault) return;
    await session?.flush();
    try {
      toast({ text: f === 'pdf' ? 'Preparing PDF…' : 'Exporting…' });
      await exportNote(vault, doc.meta, [...doc.pages], f, engine?.currentPageIndex ?? 0);
    } catch (e) {
      console.error(e);
      toast({ text: `Export failed: ${(e as Error).message}`, tone: 'error' });
    }
  };

  // ---- AI --------------------------------------------------------------------------------------
  const aiReady = isAIReady();
  const askAboutSelection = () => {
    const items = engine?.getSelectionItems();
    if (!items) return;
    setAiRequest({ kind: 'selection', pageIndex: items.pageIndex, strokeIds: items.strokes.map((s) => s.id), textIds: items.texts.map((t) => t.id), at: Date.now() });
    setPanel('ai');
  };

  const convertSelection = async () => {
    const items = engine?.getSelectionItems();
    if (!items || !doc || !vault || !engine) return;
    toast({ text: 'Converting handwriting…' });
    try {
      const text = await transcribePage(vault, doc, items.pageIndex, items.strokes);
      if (!text?.trim()) return toast({ text: 'No text recognized in the selection', tone: 'error' });
      const b = items.strokes.reduce((r, s) => ({ minX: Math.min(r.minX, ...s.points.map((p) => p.x)), minY: Math.min(r.minY, ...s.points.map((p) => p.y)), maxX: Math.max(r.maxX, ...s.points.map((p) => p.x)) }), { minX: Infinity, minY: Infinity, maxX: -Infinity });
      const box: TextBox = { id: newId(), x: b.minX, y: b.minY, width: Math.max(160, b.maxX - b.minX), text: text.trim(), fontSize: 18, color: items.strokes[0]?.color ?? '#FF1B1F24', font: 'sans', createdAt: Date.now() };
      doc.commit(items.pageIndex, {
        label: 'Convert to text',
        strokes: { removed: doc.page(items.pageIndex).strokes.map((s, i) => ({ index: i, item: s })).filter((x) => items.strokes.some((s) => s.id === x.item.id)), added: [] },
        texts: { removed: [], added: [{ index: (doc.page(items.pageIndex).texts ?? []).length, item: box }] },
      });
      engine.clearSelection();
      toast({ text: 'Converted to text', action: { label: 'Undo', run: () => engine.undo() } });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };

  // [[Wiki links]]: open the note with that title, or create it (like Obsidian).
  const openWikiLink = async (title: string) => {
    await session?.flush();
    const target = useApp.getState().notes.find((n) => n.title.trim().toLowerCase() === title.toLowerCase());
    if (target) return navigate({ name: 'editor', noteId: target.id });
    const { createNote } = await import('../lib/actions.ts');
    const id = await createNote({ title, notebookId: doc?.meta.notebookId });
    if (id) navigate({ name: 'editor', noteId: id });
  };

  // ---- Render ----------------------------------------------------------------------------------
  if (missing) {
    return (
      <div className="editor-missing">
        <p>This note no longer exists on this device.</p>
        <button type="button" className="btn btn-primary" onClick={() => navigate({ name: 'library' })}>Back to library</button>
      </div>
    );
  }

  const meta = doc?.meta;
  const curPage = doc?.pages[view.pageIndex];
  const editingScreen = editingText && engine ? engine.pageRectToScreen(editingText.pageIndex, { minX: editingText.box.x, minY: editingText.box.y, maxX: editingText.box.x + editingText.box.width, maxY: editingText.box.y + 20 }) : null;
  const sidePanel = panel && doc && engine && vault;

  return (
    <div className={cx('editor', wide && 'is-wide', panel && 'has-panel')}>
      <header className="ed-top">
        <IconButton label="Back to library" onClick={() => navigate({ name: 'library' })}><ArrowLeft size={20} /></IconButton>
        <button type="button" className="ed-title" onClick={async () => { if (!doc) return; const t = await askText('Rename note', 'Title', doc.meta.title, 'Rename'); if (t) doc.rename(t); }}>
          <span className="ed-title-text">{meta?.title ?? ''}</span>
          <span className={cx('save-dot', `is-${saveState}`)} title={saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved — retrying' : 'Saved'} aria-label={saveState === 'saved' ? 'Saved' : saveState} />
        </button>
        <div className="ed-top-spacer" />
        {doc && doc.pageCount > 1 && <button type="button" className="page-pill" onClick={() => setPanel(panel === 'pages' ? null : 'pages')}>{view.pageIndex + 1} / {doc.pageCount}</button>}
        <div className="ed-top-actions">
          {narrow && <IconButton label="Undo" onClick={() => engine?.undo()} disabled={!doc?.canUndo}><Undo2 size={19} /></IconButton>}
          {narrow && <IconButton label="Redo" onClick={() => engine?.redo()} disabled={!doc?.canRedo}><Redo2 size={19} /></IconButton>}
          {wide && <IconButton label="Zoom out" shortcut={`${modKey}−`} onClick={() => engine?.zoomBy(0.8)}><ZoomOut size={18} /></IconButton>}
          {wide && <button type="button" className="zoom-pill" onClick={() => engine?.fitWidth()} title={`Fit width (${modKey}0)`}>{Math.round(view.zoom * 100)}%</button>}
          {wide && <IconButton label="Zoom in" shortcut={`${modKey}+`} onClick={() => engine?.zoomBy(1.25)}><ZoomIn size={18} /></IconButton>}
          {(!narrow || recording != null) && !isArtifact && <IconButton label={recording != null ? 'Stop recording' : 'Record audio'} tone={recording != null ? 'seal' : undefined} active={recording != null} onClick={() => void toggleRecording()}>
            {recording != null ? <Square size={16} fill="currentColor" /> : <Mic size={19} />}
          </IconButton>}
          {recording != null && <span className="rec-time">{formatDuration(Date.now() - recording)}</span>}
          {!narrow && <IconButton label="Pages" active={panel === 'pages'} onClick={() => setPanel(panel === 'pages' ? null : 'pages')}><Layers size={19} /></IconButton>}
          <button ref={btn.feel} type="button" className={cx('icon-btn', narrow && 'is-hidden')} aria-label="Writing feel" title="Writing sound & feel" onClick={() => setMenu('feel')}>
            {settings.feel.sound ? <AudioLines size={19} /> : <VolumeX size={19} />}
          </button>
          <button ref={btn.paper} type="button" className={cx('icon-btn', narrow && 'is-hidden')} aria-label="Paper" title="Paper" onClick={() => setPaperOpen(true)}><Files size={19} /></button>
          <button ref={btn.insert} type="button" className={cx('icon-btn', narrow && 'is-hidden')} aria-label="Insert" title="Insert image, photo or PDF pages" onClick={() => setMenu('insert')}><ImageIcon size={19} /></button>
          <button type="button" className={cx('ai-btn', panel === 'ai' && 'is-on')} onClick={() => setPanel(panel === 'ai' ? null : 'ai')} aria-pressed={panel === 'ai'}>
            <Sparkles size={17} /><span>AI</span>
          </button>
          <button ref={btn.export} type="button" className={cx('icon-btn', narrow && 'is-hidden')} aria-label="Export and share" title="Export and share" onClick={() => setMenu('export')}><Download size={19} /></button>
          <button ref={btn.more} type="button" className="icon-btn" aria-label="More" title="More" onClick={() => setMenu('more')}><MoreHorizontal size={19} /></button>
        </div>
      </header>

      <div className="ed-body">
        <div className="ed-canvas-wrap">
          <div ref={host} className="ed-canvas" data-tool={tool} />
          {!session && <div className="ed-loading" aria-live="polite">Opening…</div>}
          {sel && engine && !editingText && (
            <SelectionBar sel={sel} aiReady={aiReady}
              onDelete={() => engine.deleteSelection()} onDuplicate={() => engine.duplicateSelection()} onCopy={copySel}
              onCut={() => { copySel(); engine.deleteSelection(); }} onRecolor={(c) => engine.recolorSelection(c)}
              onAsk={askAboutSelection} onConvert={() => void convertSelection()} onEditText={editSelectedText}
              links={[...new Set((engine.getSelectionItems()?.texts ?? []).flatMap((t) => [...t.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!.trim())))]}
              onOpenLink={(title) => void openWikiLink(title)} />
          )}
          {editingText && editingScreen && engine && (
            <TextOverlay key={editingText.box.id} box={editingText.box} screen={editingScreen} zoom={engine.zoom} onChange={(b) => { latestText.current = b; }} onDone={commitText} />
          )}
          {latched && <div className="latch-pill" role="status">{settings.input.buttonAction === 'lasso' ? 'Lasso' : settings.input.buttonAction === 'highlighter' ? 'Highlighter' : 'Eraser'} on — press the pen button to switch back</div>}
          {clips.length > 0 && (
            <div className="audio-bar" role="region" aria-label="Recordings">
              {playback?.playing ? (
                <IconButton label="Pause" onClick={() => { audioEl.current?.pause(); setPlayback((p) => (p ? { ...p, playing: false } : p)); }}><Pause size={17} /></IconButton>
              ) : (
                <IconButton label="Play recording" onClick={() => void playClip(playback?.clipId ?? clips[clips.length - 1]!.id, playback?.position ?? 0)}><Play size={17} /></IconButton>
              )}
              {(() => {
                const clip = clips.find((c) => c.id === playback?.clipId) ?? clips[clips.length - 1]!;
                return (
                  <>
                    <input type="range" className="audio-scrub" min={0} max={clip.durationMs} value={playback?.clipId === clip.id ? playback.position : 0} aria-label="Playback position"
                      onChange={(e) => void playClip(clip.id, Number(e.target.value))} />
                    <span className="audio-time">{formatDuration(playback?.clipId === clip.id ? playback.position : 0)} / {formatDuration(clip.durationMs)}</span>
                    {clips.length > 1 && (
                      <select className="audio-pick" value={clip.id} onChange={(e) => void playClip(e.target.value)} aria-label="Recording">
                        {clips.map((c) => <option key={c.id} value={c.id}>{c.title ?? formatDuration(c.durationMs)}</option>)}
                      </select>
                    )}
                    {playback && <button type="button" className="btn btn-ghost btn-sm" onClick={stopPlayback}>Done</button>}
                  </>
                );
              })()}
              <span className="audio-hint">{playback ? 'Tap ink to hear that moment' : ''}</span>
            </div>
          )}
          <PenDock vertical={sideDock} compact={narrow} tool={tool} activePresetId={settings.activePresetId} latched={latched}
            canUndo={!!doc?.canUndo} canRedo={!!doc?.canRedo} onTool={setTool} onPreset={selectPreset}
            onUndo={() => engine?.undo()} onRedo={() => engine?.redo()}
            onClearPage={async () => { if (doc && engine && (await askConfirm('Clear this page?', 'Everything on this page is removed. You can undo this.', 'Clear page', true))) doc.clearPage(engine.currentPageIndex); }} />
        </div>
        {sidePanel && panel === 'pages' && (
          <PagesPanel doc={doc!} current={view.pageIndex} assets={vault!.assets} onGo={(i) => engine!.scrollToPage(i)} onClose={() => setPanel(null)}
            onDelete={async (i) => { if (await askConfirm(`Delete page ${i + 1}?`, 'The page and its ink are removed from this note.', 'Delete page', true)) doc!.deletePage(i); }} />
        )}
        {sidePanel && panel === 'ai' && (
          <AIPanel session={session!} engine={engine!} request={aiRequest} onClose={() => setPanel(null)} onOpenSettings={() => navigate({ name: 'settings', section: 'ai' })} />
        )}
      </div>

      <Popover anchor={btn.paper.current} open={paperOpen} onClose={() => setPaperOpen(false)} title="Paper" placement="below" className="paper-pop">
        {doc && curPage && (
          <div className="pop-section">
            <h3 className="pop-title">Paper for {doc.pageCount > 1 ? 'this note' : 'this page'}</h3>
            <PaperPicker paper={doc.meta.paper} size={doc.meta.pageSize} kind={doc.meta.kind} onChange={(p) => { doc.setPaper(p); doc.pages.forEach((pg, i) => { if (pg.paper) doc.setPageProps(i, { paper: undefined }); }); }} />
            {doc.meta.kind === 'paged' && !curPage.background && (
              <label className="field-row">
                <span className="field-label">Page size</span>
                <select value={doc.meta.pageSize.name} onChange={(e) => { const s = PAGE_SIZE_PRESETS.find((x) => x.name === e.target.value); if (s) doc.updateMeta((m) => ({ ...m, pageSize: s })); }}>
                  {PAGE_SIZE_PRESETS.map((p) => <option key={p.name}>{p.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </Popover>

      <Popover anchor={narrow ? btn.more.current : btn.feel.current} open={menu === 'feel'} onClose={() => setMenu(null)} title="Writing feel" placement="below" className="feel-pop">
        <div className="pop-section">
          <h3 className="pop-title">Writing sound &amp; feel</h3>
          <FeelPanel feel={feel} texture={doc ? pagePaper(doc.meta, curPage ?? doc.page(0)).texture : undefined}
            onTexture={(t) => { if (!doc) return; doc.setPaper({ ...doc.meta.paper, texture: t }); doc.pages.forEach((pg, i) => { if (pg.paper) doc.setPageProps(i, { paper: { ...pg.paper, texture: t } }); }); }} />
        </div>
      </Popover>

      <Popover anchor={btn.insert.current} open={menu === 'insert'} onClose={() => setMenu(null)} title="Insert" placement="below">
        <Menu onClose={() => setMenu(null)} items={[
          { label: 'Image', icon: <FileImage size={16} />, onClick: () => void insertImages() },
          { label: 'Photo from camera', icon: <Camera size={16} />, onClick: () => void insertImages(true) },
          { label: 'Scan document', icon: <Scan size={16} />, hint: 'Camera', onClick: () => void insertImages(true) },
          { label: 'PDF pages', icon: <FileType2 size={16} />, onClick: () => void insertPdfPages() },
          { label: 'Blank page', icon: <FilePlus2 size={16} />, onClick: () => { if (doc && engine) { const i = doc.addPage(engine.currentPageIndex + 1); setTimeout(() => engine.scrollToPage(i), 30); } } },
          { label: 'Text box', icon: <FileText size={16} />, hint: 'T', onClick: () => setTool('text') },
        ]} />
      </Popover>

      <Popover anchor={btn.export.current} open={menu === 'export'} onClose={() => setMenu(null)} title="Export" placement="below">
        <Menu onClose={() => setMenu(null)} items={[
          { label: 'PDF', icon: <FileType2 size={16} />, hint: 'All pages, vector', onClick: () => void doExport('pdf') },
          { label: 'PNG image', icon: <FileImage size={16} />, hint: 'This page', onClick: () => void doExport('png') },
          { label: 'SVG', icon: <FileImage size={16} />, hint: 'This page', onClick: () => void doExport('svg') },
          { label: 'Markdown', icon: <FileText size={16} />, hint: 'Text + recognized handwriting', onClick: () => void doExport('md') },
        ]} />
      </Popover>

      <Popover anchor={btn.more.current} open={menu === 'more'} onClose={() => setMenu(null)} title="More" placement="below">
        <Menu onClose={() => setMenu(null)} items={[
          ...(narrow ? [
            { label: 'Pages', icon: <Layers size={16} />, onClick: () => setPanel('pages') },
            { label: 'Paper', icon: <Files size={16} />, onClick: () => setTimeout(() => setPaperOpen(true), 0) },
            { label: 'Writing sound & feel', icon: <AudioLines size={16} />, hint: settings.feel.sound ? `${Math.round(settings.feel.soundVolume * 100)}%` : 'Off', onClick: () => setTimeout(() => setMenu('feel'), 0) },
            { label: 'Insert', icon: <ImageIcon size={16} />, onClick: () => setTimeout(() => setMenu('insert'), 0) },
            ...(isArtifact ? [] : [{ label: recording != null ? 'Stop recording' : 'Record audio', icon: <Mic size={16} />, onClick: () => void toggleRecording() }]),
            { label: 'Export and share', icon: <Download size={16} />, onClick: () => setTimeout(() => setMenu('export'), 0) },
            'sep' as const,
          ] : []),
          { label: 'Tags', icon: <Tag size={16} />, hint: meta?.tags.join(', ') || 'None', onClick: async () => { if (!doc) return; const t = await askText('Tags', 'Comma-separated', doc.meta.tags.join(', ')); if (t != null) { doc.setTags(t.split(',')); await session?.flush(); await setTags(doc.meta.id, doc.meta.tags); } } },
          { label: 'Fit to width', icon: <Maximize2 size={16} />, hint: `${modKey}0`, onClick: () => engine?.fitWidth() },
          { label: 'Duplicate note', icon: <Copy size={16} />, onClick: async () => { await session?.flush(); await duplicateNote(noteId); toast({ text: 'Duplicated', tone: 'success' }); } },
          { label: 'Save now', icon: <CloudUpload size={16} />, hint: `${modKey}S`, onClick: () => void session?.flush().then(() => toast({ text: 'Saved', tone: 'success' })) },
          'sep',
          { label: 'Move to Trash', icon: <Trash2 size={16} />, danger: true, onClick: async () => { await session?.flush(); await trashNote(noteId); navigate({ name: 'library' }); } },
        ]} />
      </Popover>
    </div>
  );
}
