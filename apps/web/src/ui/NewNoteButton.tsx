import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FileText, LayoutTemplate, NotebookPen, Plus, Signature } from 'lucide-react';
import type { NoteMeta, NoteTemplate } from '@inkwright/core';
import { createNote } from '../lib/actions.ts';
import { useApp } from '../state/app.ts';
import { isModuleOn, useModules } from '../modules/registry.ts';
import { useLongPress } from '../studio/useLongPress.ts';
import { Dialog, Menu, Popover, cx } from './primitives.tsx';

/**
 * The editor's "+": a new note from anywhere, without going back to the library.
 *
 * A tap starts a note like this one: same notebook, same paper and page size (or a new document,
 * when this is a document). Press and hold — or right-click, or ↓ on the keyboard — for the other
 * ways to start: a new page here, a note from a template, a document, or a PDF to sign.
 */
export interface NewNoteButtonProps {
  /** The note on screen: the new one copies its notebook and paper. */
  meta: NoteMeta | null;
  /** Saves the current note before leaving it. */
  flush: () => Promise<void>;
  /** "New page in this note" (absent where pages don't apply). */
  onNewPage?: () => void;
  /** Label of the new-page entry ("New page in this note", or "Page break" in documents). */
  newPageLabel?: string;
}

export function NewNoteButton({ meta, flush, onNewPage, newPageLabel = 'New page in this note' }: NewNoteButtonProps) {
  const navigate = useApp((a) => a.navigate);
  const toast = useApp((a) => a.toast);
  const mods = useModules((m) => m.enabled);
  const [menu, setMenu] = useState(false);
  const [templates, setTemplates] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const press = useLongPress(() => setMenu(true));
  const notebookId = meta?.notebookId;
  const isDoc = !!meta?.document;

  const go = async (make: () => Promise<string | null>) => {
    await flush();
    const id = await make();
    if (id) navigate({ name: 'editor', noteId: id });
  };
  const newLikeThis = () => void go(async () => {
    if (isDoc && isModuleOn('documents')) return (await import('../documents/create.ts')).createDocumentNote({ notebookId });
    return createNote({ notebookId, kind: meta?.kind, paper: meta?.paper, pageSize: meta?.pageSize });
  });

  const items = [
    { label: isDoc ? 'New document' : 'New note', icon: isDoc ? <FileText size={16} /> : <NotebookPen size={16} />, hint: isDoc ? undefined : 'Same paper', onClick: newLikeThis },
    ...(onNewPage ? [{ label: newPageLabel, icon: <FilePlus2 size={16} />, onClick: onNewPage }] : []),
    ...(isModuleOn('knowledge', mods) ? [{ label: 'New note from template', icon: <LayoutTemplate size={16} />, onClick: () => setTemplates(true) }] : []),
    ...(!isDoc && isModuleOn('documents', mods) ? [{ label: 'New document', icon: <FileText size={16} />, onClick: () => void go(async () => (await import('../documents/create.ts')).createDocumentNote({ notebookId })) }] : []),
    ...(isDoc ? [{ label: 'New note', icon: <NotebookPen size={16} />, onClick: () => void go(() => createNote({ notebookId })) }] : []),
    ...(isModuleOn('fill-sign', mods) ? ['sep' as const, { label: 'Open a PDF to sign', icon: <Signature size={16} />, onClick: () => void flush().then(() => import('../fill/signFlow.ts')).then((m) => m.startSigning(notebookId)).catch((e) => toast({ text: (e as Error).message, tone: 'error' })) }] : []),
  ];

  return (
    <>
      <button ref={btn} type="button" className={cx('icon-btn', 'new-here')} aria-label={isDoc ? 'New document' : 'New note'} aria-haspopup="menu"
        title={`${isDoc ? 'New document' : 'New note with this paper'} — press and hold for more`}
        {...press.handlers}
        onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setMenu(true); } }}
        onClick={() => { if (press.consumed()) return; newLikeThis(); }}>
        <Plus size={20} />
      </button>
      <Popover anchor={btn.current} open={menu} onClose={() => setMenu(false)} title="New" placement="below">
        <Menu onClose={() => setMenu(false)} items={items} />
      </Popover>
      <TemplateDialog open={templates} notebookId={notebookId} onClose={() => setTemplates(false)} onPick={(id) => void go(async () => id)} />
    </>
  );
}

/** Templates to start from, or how to make one when there are none yet. */
function TemplateDialog({ open, notebookId, onClose, onPick }: { open: boolean; notebookId?: string; onClose: () => void; onPick: (noteId: string) => void }) {
  const [list, setList] = useState<NoteTemplate[] | null>(null);
  const toast = useApp((a) => a.toast);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setList(null);
    void import('../lib/knowledge.ts').then((m) => m.listTemplates()).then((l) => alive && setList(l)).catch(() => alive && setList([]));
    return () => { alive = false; };
  }, [open]);
  return (
    <Dialog open={open} title="New note from template" onClose={onClose} actions={<button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>}>
      {list == null ? <p className="muted">Loading templates…</p> : list.length === 0 ? (
        <p className="muted">No templates yet. To make one, open a note you want to reuse and choose ••• › Note › Use as template.</p>
      ) : (
        <div className="template-pick" role="list">
          {list.map((t) => (
            <button key={t.id} type="button" role="listitem" className="nav-item" onClick={async () => {
              try {
                const { createFromTemplate } = await import('../lib/knowledge.ts');
                const id = await createFromTemplate(t.id, { notebookId });
                onClose();
                if (id) onPick(id);
              } catch (e) {
                toast({ text: `Couldn’t use “${t.name}”: ${(e as Error).message}`, tone: 'error' });
              }
            }}>
              <LayoutTemplate size={16} /> <span className="nav-label">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
