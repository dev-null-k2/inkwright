import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Columns2, History, Lock, LockOpen } from 'lucide-react';
import { VersionHistory, sealedView, type NoteDocument, type NoteMeta, type StrokeLayer } from '@inkstone/core';
import type { InkEngine, Tool } from '../canvas/engine.ts';
import { autoSpreads } from '../canvas/layout.ts';
import type { EditorSession } from '../lib/session.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { Popover } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { HistoryDialog } from './HistoryDialog.tsx';
import { LockNoteDialog } from './LockDialogs.tsx';
import { StudioLayer, type StudioApi } from './StudioLayer.tsx';
import { ViewPanel } from './ViewPanel.tsx';
import { useVersioning, type NoteVersioning } from './versions.ts';

/**
 * The editor's "studio" features in one place, so the editor screen only wires them in: two-page
 * view, layers, sticky notes, tape (study mode), snapping, version history and locking a note.
 */

let activeLayer: StrokeLayer = 'writing';
/** The layer new strokes go on (part of the engine's tool state). */
export const currentLayer = () => activeLayer;

interface Args {
  doc: NoteDocument | null;
  engine: InkEngine | null;
  session: EditorSession | null;
  vault: AppVault | null;
  host: HTMLElement | null;
  tool: Tool;
  view: { zoom: number; pageIndex: number; pageCount: number };
  menuAnchor: HTMLElement | null;
}

export interface MenuItem { label: string; icon?: ReactNode; onClick: () => void; hint?: string; danger?: boolean }

export function useStudio({ doc, engine, session, vault, host, tool, view, menuAnchor }: Args) {
  const { toast } = useApp();
  const pageView = useSettings((s) => s.pageView);
  const [layer, setLayerState] = useState<StrokeLayer>('writing');
  const [viewOpen, setViewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [versioning, setVersioning] = useState<NoteVersioning | null>(null);
  const [screen, setScreen] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const api = useRef<StudioApi | null>(null);

  useVersioning(session, setVersioning);

  // Each note starts on the writing layer.
  useEffect(() => { activeLayer = 'writing'; setLayerState('writing'); }, [doc]);
  const setLayer = (l: StrokeLayer) => {
    activeLayer = l;
    setLayerState(l);
    if (engine) engine.setTool({ ...engine.tool, layer: l });
  };

  // Two-page view: on wide, unfolded or landscape screens for notes with more than one page (Auto), or as chosen.
  useEffect(() => {
    const on = () => setScreen({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const pageCount = doc?.pageCount ?? 0;
  const spreads = !!doc && doc.meta.kind === 'paged' && (pageView === 'spread' || (pageView === 'auto' && autoSpreads(screen.w, screen.h, pageCount)));
  const spreadEngine = useRef<InkEngine | null>(null);
  useEffect(() => {
    if (!engine) return;
    engine.setSpreads(spreads, { initial: spreadEngine.current !== engine });
    spreadEngine.current = engine;
  }, [engine, spreads]);

  const lockNote = async (passcode: string) => {
    if (!session || !doc || !vault) return;
    const id = doc.meta.id;
    await session.exclusive(async () => {
      const meta = await vault.vault.lockNote(doc.meta, [...doc.committedPages], passcode);
      await (versioning?.history ?? new VersionHistory(vault.vault)).reseal(id, undefined, meta);
      doc.updateMeta((m) => ({ ...m, lock: meta.lock }));
    });
    // Take its content out of search, links and the assistant's memory.
    vault.indexNote(doc.meta, doc.pages.map(sealedView));
    vault.forgetThumb(id);
    await session.flush();
    toast({ text: 'Locked. You’ll need the passcode to open this note.', tone: 'success' });
  };

  const removeLock = async () => {
    if (!session || !doc || !vault || !doc.meta.lock) return;
    if (!(await askConfirm('Remove the lock?', 'The note is stored unencrypted again and shows up in search and for the assistant.', 'Remove lock'))) return;
    const id = doc.meta.id;
    await session.exclusive(async () => {
      const key = vault.vault.keyFor(id);
      const plain = await vault.vault.removeLock(doc.meta, [...doc.committedPages]);
      await (versioning?.history ?? new VersionHistory(vault.vault)).reseal(id, key, plain);
      doc.updateMeta((m) => { const { lock: _l, ...rest } = m; return rest as NoteMeta; });
    });
    vault.indexNote(doc.meta, [...doc.pages]);
    vault.forgetThumb(id);
    toast({ text: 'Lock removed', tone: 'success' });
  };

  const locked = !!doc?.meta.lock;
  const menuItems: MenuItem[] = doc ? [
    { label: 'View', icon: <Columns2 size={16} />, hint: spreads ? 'Two pages' : layer === 'drawing' ? 'Drawing layer' : undefined, onClick: () => setTimeout(() => setViewOpen(true), 0) },
    { label: 'Version history', icon: <History size={16} />, onClick: () => setHistoryOpen(true) },
    locked
      ? { label: 'Remove lock', icon: <LockOpen size={16} />, onClick: () => void removeLock() }
      : { label: 'Lock note', icon: <Lock size={16} />, onClick: () => setLockOpen(true) },
  ] : [];

  const parts = (
    <>
      {doc && engine && host && <StudioLayer doc={doc} engine={engine} host={host} tool={tool} view={view} apiRef={api} />}
      {layer === 'drawing' && <div className="layer-pill" role="status">Drawing layer</div>}
      {doc && engine && (
        <Popover anchor={menuAnchor} open={viewOpen} onClose={() => setViewOpen(false)} title="View" placement="below">
          <ViewPanel doc={doc} engine={engine} pageIndex={view.pageIndex} layer={layer} onLayer={setLayer} />
        </Popover>
      )}
      {doc && vault && <HistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} doc={doc} vault={vault} versioning={versioning} currentPage={view.pageIndex} />}
      <LockNoteDialog open={lockOpen} onClose={() => setLockOpen(false)} onLock={lockNote} />
    </>
  );

  return {
    layer,
    menuItems,
    parts,
    locked,
    /** The text tool tapped a page point: type on a sticky note there (true if handled). */
    editStickyAt: (pageIndex: number, x: number, y: number) => !!api.current?.editStickyAt(pageIndex, x, y),
    addSticky: () => api.current?.addSticky(),
  };
}
