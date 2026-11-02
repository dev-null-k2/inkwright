import { useRef, useState, type ReactNode } from 'react';
import { LayoutTemplate, Link2 } from 'lucide-react';
import { parseWikiLinks, type NoteDocument } from '@inkwright/core';
import type { InkEngine } from '../../canvas/engine.ts';
import type { EditorSession } from '../../lib/session.ts';
import { addInkLink, followLink, removeInkLinks, renameNoteKeepingLinks, saveDocAsTemplate } from '../../lib/knowledge.ts';
import { useApp } from '../../state/app.ts';
import { askText } from '../prompts.tsx';
import { InkLinkLayer } from './InkLinkLayer.tsx';
import { LinksPanel } from './LinksPanel.tsx';
import { NotePicker, type PickedNote } from './NotePicker.tsx';

type MenuItem = { label: string; icon?: ReactNode; onClick: () => void; hint?: string };

/**
 * Everything the editor needs for links in one hook, so the editor itself only gains a few
 * lines: following and renaming with links kept, "Link to note…" for lassoed ink, the Links panel,
 * the ink-link layer and "Save as template".
 */
export function useKnowledgeEditor({ doc, engine, session, onPanel }: { doc: NoteDocument | null; engine: InkEngine | null; session: EditorSession | null; onPanel: () => void }) {
  const { toast, vault } = useApp();
  const [picker, setPicker] = useState(false);
  const pending = useRef<{ pageIndex: number; strokeIds: string[] } | null>(null);

  const selectedInk = () => {
    const items = engine?.getSelectionItems();
    return items && items.strokes.length ? { pageIndex: items.pageIndex, strokeIds: items.strokes.map((s) => s.id) } : null;
  };

  return {
    picker,
    follow: async (target: string, noteId?: string) => {
      await session?.flush();
      await followLink(target, { from: doc?.meta, noteId });
    },
    rename: (title: string) => { if (doc) void renameNoteKeepingLinks(doc.meta.id, title); },
    /** Link targets in the selection: typed `[[links]]` and links on the selected ink. */
    selectionLinks: (): string[] => {
      const items = engine?.getSelectionItems();
      if (!items || !doc) return [];
      const typed = items.texts.flatMap((t) => parseWikiLinks(t.text).map((l) => l.target));
      const ids = new Set(items.strokes.map((s) => s.id));
      const ink = (doc.page(items.pageIndex).links ?? []).filter((l) => l.strokeIds.some((id) => ids.has(id))).map((l) => l.target);
      return [...new Set([...typed, ...ink])];
    },
    canLinkSelection: () => !!selectedInk(),
    selectionHasInkLink: () => {
      const s = selectedInk();
      if (!s || !doc) return false;
      const ids = new Set(s.strokeIds);
      return (doc.page(s.pageIndex).links ?? []).some((l) => l.strokeIds.some((id) => ids.has(id)));
    },
    linkSelection: () => {
      pending.current = selectedInk();
      if (pending.current) setPicker(true);
    },
    unlinkSelection: () => {
      const s = selectedInk();
      if (s && doc && removeInkLinks(doc, s.pageIndex, s.strokeIds)) toast({ text: 'Link removed', action: { label: 'Undo', run: () => engine?.undo() } });
    },
    pick: (p: PickedNote) => {
      setPicker(false);
      const s = pending.current;
      pending.current = null;
      if (!s || !doc) return;
      addInkLink(doc, s.pageIndex, s.strokeIds, p);
      engine?.clearSelection();
      toast({ text: `Linked to “${p.title}”${p.page ? `, page ${p.page}` : ''}`, tone: 'success', action: { label: 'Undo', run: () => engine?.undo() } });
    },
    closePicker: () => { setPicker(false); pending.current = null; },
    menuItem: (): MenuItem => {
      const n = doc && vault ? vault.knowledge.backlinks(doc.meta.id).length : 0;
      return { label: 'Links', icon: <Link2 size={16} />, hint: n ? `${n} linked here` : undefined, onClick: onPanel };
    },
    templateMenuItem: (): MenuItem => ({
      label: 'Save as template', icon: <LayoutTemplate size={16} />,
      onClick: async () => {
        if (!doc) return;
        const name = await askText('Save as template', 'Template name', doc.meta.title, 'Save');
        if (!name) return;
        try {
          await saveDocAsTemplate(doc, name);
          toast({ text: `Saved “${name}”. Start notes from it under New note.`, tone: 'success' });
        } catch (e) {
          toast({ text: `Couldn’t save the template: ${(e as Error).message}`, tone: 'error' });
        }
      },
    }),
    panel: (onClose: () => void) => (doc ? <LinksPanel doc={doc} onClose={onClose} /> : null),
  };
}

export type KnowledgeEditor = ReturnType<typeof useKnowledgeEditor>;

/** The editor's link overlay and the "Link to note" finder. */
export function KnowledgeEditorParts({ kb, doc, engine, host, view, editingTextId }: { kb: KnowledgeEditor; doc: NoteDocument; engine: InkEngine; host: HTMLElement; view: unknown; editingTextId?: string }) {
  return (
    <>
      <InkLinkLayer doc={doc} engine={engine} host={host} version={view} editingTextId={editingTextId} onFollow={(t, id) => void kb.follow(t, id)} />
      <NotePicker open={kb.picker} exclude={doc.meta.id} onPick={kb.pick} onClose={kb.closePicker} />
    </>
  );
}
