import { type ReactNode } from 'react';
import { BookMarked, Camera, Database, Image as ImageIcon, PenLine, Table2, TextSearch, Volume2, Workflow } from 'lucide-react';
import type { NoteDocument } from '@inkwright/core';
import type { InkEngine, SelectionInfo } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { usePaletteActions, type PaletteAction } from '../lib/palette.ts';
import { useModules, isModuleOn } from '../modules/registry.ts';
import { answerSelectionHere } from '../inkanswer/answer.ts';
import { CanvasRunLayer } from '../canvasdag/CanvasRunLayer.tsx';
import { prepareCanvasRun, useCanvasRun } from '../canvasdag/run.ts';
import { DataPanelHost, openDataPanel } from '../datasandbox/DataPanel.tsx';
import { pickAndAddData } from '../datasandbox/actions.ts';
import { PhotoDialogHost, openPhotoToInk } from '../photoink/PhotoDialog.tsx';
import { UnderlayLayer } from '../photoink/UnderlayLayer.tsx';
import { useUnderlayView } from '../photoink/photo.ts';
import { ReadAloudBar } from '../a11y/ReadAloudBar.tsx';
import { ReadingViewHost, openReadingView } from '../a11y/ReadingView.tsx';
import { speechSupported, startReadAloud } from '../a11y/readaloud.ts';
import { CiteSuggest } from '../papers/CiteSuggest.tsx';
import { CiteHover } from '../papers/CiteHover.tsx';
import { BibliographyHost, openBibliography } from '../papers/Bibliography.tsx';
import { PapersDialogHost } from '../papers/PapersDialog.tsx';

/**
 * Ink actions in the editor, wired in like the studio and compiler parts: the editor spreads
 * `menuItems` into its ••• menu, puts `selectionActions` in the lasso bar and renders `parts`.
 * Each piece appears only while its module is on (Settings › Modules).
 */

interface MenuItem { label: string; icon?: ReactNode; onClick: () => void; hint?: string; disabled?: boolean }

export function useInkActions({ doc, engine, vault, host, view, sel }: { doc: NoteDocument | null; engine: InkEngine | null; vault: AppVault | null; host: HTMLElement | null; view: unknown; sel: SelectionInfo | null }): { menuItems: MenuItem[]; selectionActions: ReactNode; parts: ReactNode } {
  const toast = useApp((s) => s.toast);
  const fail = useApp((s) => s.fail);
  const mods = useModules((m) => m.enabled);
  const on = (id: string) => isModuleOn(id, mods);
  const underlayShown = useUnderlayView((s) => s.shown);
  const toggleUnderlay = useUnderlayView((s) => s.toggle);
  const running = useCanvasRun((s) => s.phase !== 'idle');

  const selection = () => engine?.getSelectionItems() ?? null;
  const needSelection = (what: string) => toast({ text: `Lasso ${what} first, then choose this again.` });

  const answer = async () => {
    const items = selection();
    if (!items || !doc || !vault) return needSelection('the question');
    toast({ text: 'Asking the AI…' });
    try { await answerSelectionHere({ vault, doc, engine, sel: { pageIndex: items.pageIndex, strokes: items.strokes, texts: items.texts } }); }
    catch (e) { fail((e as Error).message); }
  };
  const runDiagram = async () => {
    const items = selection();
    if (!items || !doc || !vault) return needSelection('the diagram');
    try {
      await prepareCanvasRun(vault, doc, { pageIndex: items.pageIndex, strokeIds: items.strokes.map((s) => s.id), textIds: items.texts.map((t) => t.id) });
      engine?.clearSelection();
    } catch (e) { fail((e as Error).message); }
  };
  const readAloud = async () => {
    if (!doc) return;
    if (!speechSupported()) return fail('This browser has no text-to-speech voices.');
    const items = selection();
    const pageIndex = items?.pageIndex ?? engine?.currentPageIndex ?? 0;
    const filter = items ? { strokeIds: new Set(items.strokes.map((s) => s.id)), textIds: new Set(items.texts.map((t) => t.id)) } : undefined;
    const r = await startReadAloud({ doc, engine, pageIndex, ...(filter ? { filter } : {}) });
    if (r === 'empty') toast({ text: 'Nothing to read here yet: type text, or have your handwriting recognized (AI › Transcribe page).' });
  };
  const hasUnderlay = !!doc?.pages.some((p) => p.underlay);

  const menuItems: MenuItem[] = !doc || !vault ? [] : [
    ...(on('ink-answers') ? [{ label: 'Write the answer here', icon: <PenLine size={16} />, hint: sel ? undefined : 'Lasso first', onClick: () => void answer() }] : []),
    ...(on('canvas-run') ? [{ label: 'Run diagram', icon: <Workflow size={16} />, hint: sel ? undefined : 'Lasso first', onClick: () => void runDiagram() }] : []),
    ...(on('data-sandbox') ? [
      { label: 'Add data', icon: <Table2 size={16} />, hint: 'CSV, JSON, Excel', onClick: () => void pickAndAddData(vault, doc, engine) },
      { label: 'Query data', icon: <Database size={16} />, hint: 'SQL', onClick: () => openDataPanel(vault, doc, engine) },
    ] : []),
    ...(on('photo-ink') ? [
      { label: 'Photo to ink', icon: <Camera size={16} />, onClick: () => openPhotoToInk(vault, doc, engine) },
      ...(hasUnderlay ? [{ label: underlayShown ? 'Hide the original photo' : 'Show the original photo', icon: <ImageIcon size={16} />, onClick: toggleUnderlay }] : []),
    ] : []),
    ...(on('accessibility') ? [
      { label: 'Read aloud', icon: <Volume2 size={16} />, hint: sel ? 'Selection' : 'This page', onClick: () => void readAloud() },
      { label: 'Reading view', icon: <TextSearch size={16} />, onClick: () => openReadingView(doc) },
    ] : []),
    ...(on('papers') ? [{ label: 'Bibliography', icon: <BookMarked size={16} />, onClick: () => openBibliography(doc, engine) }] : []),
  ];

  const palette: PaletteAction[] = menuItems.map((m) => ({
    id: ({ 'Write the answer here': 'ink.answer', 'Run diagram': 'ink.canvas-run', 'Add data': 'ink.data-add', 'Query data': 'ink.data-query', 'Photo to ink': 'ink.photo', 'Read aloud': 'ink.read-aloud', 'Reading view': 'ink.reading-view', Bibliography: 'papers.bibliography' } as Record<string, string>)[m.label] ?? `ink.${m.label}`,
    label: m.label,
    icon: m.icon,
    run: m.onClick,
  }));
  usePaletteActions('inkactions.editor', palette);

  const strokes = sel?.strokes ?? 0;
  const selectionActions = sel && (strokes > 0 || sel.texts > 0) ? (
    <>
      {on('ink-answers') && <button type="button" className="sel-btn" onClick={() => void answer()} title="Write the answer next to this"><PenLine size={16} aria-hidden /><span>Answer</span></button>}
      {on('canvas-run') && strokes >= 2 && <button type="button" className="sel-btn" onClick={() => void runDiagram()} title="Run this diagram"><Workflow size={16} aria-hidden /><span>Run</span></button>}
    </>
  ) : null;

  const parts = doc && engine && vault && host ? (
    <>
      {on('canvas-run') && running && <CanvasRunLayer doc={doc} engine={engine} vault={vault} view={view} />}
      {on('photo-ink') && hasUnderlay && <UnderlayLayer doc={doc} engine={engine} vault={vault} view={view} />}
      {on('accessibility') && <ReadAloudBar />}
      {on('papers') && <><CiteSuggest /><CiteHover doc={doc} engine={engine} host={host} /></>}
      <DataPanelHost />
      <PhotoDialogHost />
      <ReadingViewHost />
      <BibliographyHost />
      <PapersDialogHost />
    </>
  ) : null;
  return { menuItems, selectionActions, parts };
}
