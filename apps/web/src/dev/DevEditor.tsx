import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Code2, Database, GitCompareArrows, Lightbulb, Link2, Workflow } from 'lucide-react';
import { DRIFTED, formatCodeTarget, isDataAsset, makeDiagramObject, type DiagramIR, type DiagramObject, type NoteDocument } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import { usePaletteActions } from '../lib/palette.ts';
import type { AppVault } from '../lib/vault.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { Menu, Popover } from '../ui/primitives.tsx';
import { placeUserDiagram } from './agent.ts';
import { linkInkToCode, useCodeRefs } from './codeRefs.ts';
import { DevLayer } from './DevLayer.tsx';
import { CodePickerDialog, DiagramDialog, DriftDialog } from './dialogs.tsx';
import { findLessons, isSessionNote } from './journal.ts';
import { useDevSettings } from './settings.ts';
import { ensureCodeLoaded } from './store.ts';

interface Args {
  doc: NoteDocument | null;
  engine: InkEngine | null;
  vault: AppVault | null;
  host: HTMLElement | null;
  view: unknown;
  menuAnchor: HTMLElement | null;
  editingTextId?: string;
}

export interface DevMenuItem { label: string; icon?: ReactNode; onClick: () => void; hint?: string }

/**
 * Everything the developer module adds to the editor, in one hook so the editor only wires it in
 * (like the studio and knowledge hooks): the code-link / runbook layer, a "Developer" entry in
 * the ••• menu, palette actions and their dialogs. With the module off it adds nothing.
 */
export function useDevEditor({ doc, engine, vault, host, view, menuAnchor, editingTextId }: Args): { parts: ReactNode; menuItems: DevMenuItem[] } {
  const on = useDevSettings((s) => s.devTools);
  const toast = useApp((s) => s.toast);
  const states = useCodeRefs(doc, on);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'picker' | 'diagram' | 'drift' | null>(null);
  const [editing, setEditing] = useState<{ pageIndex: number; obj: DiagramObject } | null>(null);
  const pendingInk = useRef<{ pageIndex: number; strokeIds: string[] } | null>(null);

  useEffect(() => { if (on) void ensureCodeLoaded(); }, [on]);

  const drifted = states.filter((s) => DRIFTED.has(s.status)).length;
  const selectedInk = () => {
    const items = engine?.getSelectionItems();
    return items && items.strokes.length ? { pageIndex: items.pageIndex, strokeIds: items.strokes.map((s) => s.id) } : null;
  };
  const pageDiagram = () => {
    if (!doc || !engine) return null;
    const pageIndex = engine.currentPageIndex;
    const obj = [...(doc.page(pageIndex)?.objects ?? [])].reverse().find((o): o is DiagramObject => o.type === 'diagram');
    return obj ? { pageIndex, obj } : null;
  };

  const actions = {
    linkInk: () => {
      pendingInk.current = selectedInk();
      if (!pendingInk.current) return toast({ text: 'Select handwriting with the lasso first, then link it to code.' });
      setDialog('picker');
    },
    diagram: () => { setEditing(null); setDialog('diagram'); },
    editDiagram: () => { const d = pageDiagram(); if (d) { setEditing(d); setDialog('diagram'); } },
    drift: () => setDialog('drift'),
    attach: async () => {
      if (!doc || !vault) return;
      const files = await pickFiles('.csv,.tsv,.json,text/csv,application/json', true);
      let n = 0;
      for (const f of files) {
        const name = f.name.replace(/[^0-9A-Za-z_.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 90) || 'data.csv';
        if (!isDataAsset(name)) continue;
        await vault.vault.writeAsset(doc.meta.id, name, new Uint8Array(await f.arrayBuffer()));
        n++;
      }
      if (n) toast({ text: `Attached ${n} data ${n === 1 ? 'file' : 'files'}. Query them in a \`\`\`sql block.`, tone: 'success' });
    },
    lessons: async () => {
      if (!doc) return;
      toast({ text: 'Reading the session for lessons…' });
      try {
        const n = await findLessons(doc.meta.id);
        toast({ text: n ? `${n} ${n === 1 ? 'lesson' : 'lessons'} proposed. Review them in Settings › Extend › Code & runbooks.` : 'No new lessons in this session.', tone: n ? 'success' : undefined });
      } catch (e) {
        toast({ text: (e as Error).message, tone: 'error' });
      }
    },
  };

  usePaletteActions('dev-editor', on && doc ? [
    { id: 'dev-link-code', label: 'Link selection to code', keywords: 'developer symbol function ink', icon: <Link2 size={16} />, run: actions.linkInk },
    { id: 'dev-diagram', label: 'Insert diagram', keywords: 'architecture verified developer', icon: <Workflow size={16} />, run: actions.diagram },
    { id: 'dev-note-drift', label: 'Code drift in this note', keywords: 'developer stale docs', hint: drifted ? String(drifted) : undefined, icon: <GitCompareArrows size={16} />, run: actions.drift },
    { id: 'dev-attach', label: 'Attach data file', keywords: 'csv json sql runbook developer', icon: <Database size={16} />, run: () => void actions.attach() },
  ] : []);

  if (!on || !doc || !engine || !vault || !host) return { parts: null, menuItems: [] };

  const sub = [
    { label: 'Link selection to code…', icon: <Link2 size={16} />, onClick: actions.linkInk },
    { label: 'Insert diagram…', icon: <Workflow size={16} />, onClick: actions.diagram },
    ...(pageDiagram() ? [{ label: 'Edit diagram on this page…', icon: <Workflow size={16} />, onClick: actions.editDiagram }] : []),
    { label: 'Code drift', icon: <GitCompareArrows size={16} />, hint: drifted ? `${drifted} changed` : states.length ? 'None' : undefined, onClick: actions.drift },
    { label: 'Attach data file…', icon: <Database size={16} />, hint: 'CSV, JSON', onClick: () => void actions.attach() },
    ...(isSessionNote(doc.meta) ? [{ label: 'Find lessons', icon: <Lightbulb size={16} />, onClick: () => void actions.lessons() }] : []),
  ];

  const parts = (
    <>
      <DevLayer doc={doc} engine={engine} host={host} vault={vault} version={view} states={states} editingTextId={editingTextId} />
      <Popover anchor={menuAnchor} open={menu} onClose={() => setMenu(false)} title="Developer" placement="below">
        <Menu onClose={() => setMenu(false)} items={sub} />
      </Popover>
      <CodePickerDialog open={dialog === 'picker'} onClose={() => setDialog(null)} onPick={(s) => {
        const ink = pendingInk.current;
        setDialog(null);
        if (!ink) return;
        linkInkToCode(doc, ink.pageIndex, ink.strokeIds, formatCodeTarget({ path: s.file, symbol: s.qualified }));
        engine.clearSelection();
        toast({ text: `Linked to ${s.qualified}`, tone: 'success', action: { label: 'Undo', run: () => engine.undo() } });
      }} />
      <DiagramDialog open={dialog === 'diagram'} initial={editing?.obj.ir} onClose={() => setDialog(null)} onPlace={(ir: DiagramIR) => {
        setDialog(null);
        if (editing) {
          const next = makeDiagramObject(ir, { id: editing.obj.id, x: editing.obj.x, y: editing.obj.y, width: editing.obj.width, now: editing.obj.createdAt, color: editing.obj.color, ...(editing.obj.origin ? { origin: editing.obj.origin } : {}) });
          doc.editObjects(editing.pageIndex, 'Edit diagram', { upsert: [next] });
          setEditing(null);
        } else {
          const pageIndex = engine.currentPageIndex;
          placeUserDiagram(doc, ir, pageIndex, engine.visibleCenter(pageIndex));
        }
        toast({ text: 'Diagram placed', tone: 'success', action: { label: 'Undo', run: () => engine.undo() } });
      }} />
      <DriftDialog open={dialog === 'drift'} noteId={doc.meta.id} onClose={() => setDialog(null)} />
    </>
  );
  return { parts, menuItems: [{ label: 'Developer', icon: <Code2 size={16} />, hint: drifted ? `${drifted} drifted` : undefined, onClick: () => setTimeout(() => setMenu(true), 0) }] };
}
