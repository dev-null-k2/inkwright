import { useState } from 'react';
import { FileUp, FolderOpen } from 'lucide-react';
import { create } from 'zustand';
import { useApp } from '../state/app.ts';
import { pickFiles } from '../platform/files.ts';
import { Dialog } from '../ui/primitives.tsx';
import { attachPdfs, importReferences, libraryReferences, PAPERS_NOTEBOOK, type AttachReport, type ImportReport } from './library.ts';

/**
 * Library of papers: import references (Zotero → File › Export Library… as BibTeX, Better BibTeX
 * or CSL JSON) and attach PDFs from a folder; they are matched to their papers by DOI, citation
 * key or author–year–title.
 */
export const usePapersDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openPapers = () => usePapersDialog.setState({ open: true });

export function PapersDialogHost() {
  const open = usePapersDialog((s) => s.open);
  return open ? <PapersDialog onClose={() => usePapersDialog.setState({ open: false })} /> : null;
}

/** Picks a whole folder where the browser allows it (webkitdirectory), else several files. */
function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'application/pdf,.pdf';
    (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

function PapersDialog({ onClose }: { onClose: () => void }) {
  const notes = useApp((s) => s.notes);
  const notebooks = useApp((s) => s.notebooks);
  const setFilter = useApp((s) => s.setFilter);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<ImportReport | null>(null);
  const [attached, setAttached] = useState<AttachReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = libraryReferences(notes).length;
  const nb = notebooks.find((n) => n.name === PAPERS_NOTEBOOK && !n.parentId);

  const doImport = async () => {
    const files = await pickFiles('.bib,.bibtex,.json,.csljson,application/x-bibtex,application/json,text/plain', true);
    if (!files.length) return;
    setBusy(true); setError(null);
    try {
      const total: ImportReport = { added: 0, updated: 0, skipped: 0, errors: [] };
      for (const f of files) {
        const r = await importReferences(await f.text());
        total.added += r.added; total.updated += r.updated; total.skipped += r.skipped;
        total.errors.push(...r.errors.map((e) => ({ ...e, message: `${f.name}: ${e.message}` })));
      }
      setImported(total);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const doAttach = async (folder: boolean) => {
    const files = folder ? await pickFolder() : await pickFiles('application/pdf,.pdf', true);
    if (!files.length) return;
    setBusy(true); setError(null);
    try { setAttached(await attachPdfs(files)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Dialog open title="Library of papers" onClose={onClose} actions={<>
      {nb && <button type="button" className="btn" onClick={() => { setFilter({ kind: 'notebook', id: nb.id }); onClose(); }}>Show papers</button>}
      <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
    </>}>
      <p>{count ? `${count} ${count === 1 ? 'paper' : 'papers'} in your library.` : 'Each reference becomes a note in the “Papers” notebook, with its details kept in the note.'} Cite them in typed text with <code>[@key]</code>; ••• › Bibliography lists and exports what a note cites.</p>
      <div className="ia-row">
        <button type="button" className="btn" disabled={busy} onClick={() => void doImport()}><FileUp size={16} aria-hidden /> Import references</button>
        <button type="button" className="btn" disabled={busy || !count} onClick={() => void doAttach(true)}><FolderOpen size={16} aria-hidden /> Attach PDFs from a folder</button>
        <button type="button" className="btn btn-ghost" disabled={busy || !count} onClick={() => void doAttach(false)}>Choose PDFs</button>
      </div>
      <p className="ia-note">From Zotero: File › Export Library… as BibTeX, Better BibTeX or CSL JSON. Zotero’s own local API does not accept requests from web pages, so the library is read from these files.</p>
      {busy && <p role="status">Working…</p>}
      {imported && (
        <p role="status">Added {imported.added}, updated {imported.updated}{imported.skipped ? `, ${imported.skipped} already up to date` : ''}.{imported.errors.length ? ` Couldn’t read ${imported.errors.length}: ${imported.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join('; ')}` : ''}</p>
      )}
      {attached && (
        <div role="status">
          <p>Attached {attached.attached.length} {attached.attached.length === 1 ? 'PDF' : 'PDFs'}{attached.unmatched.length ? `; ${attached.unmatched.length} matched no paper` : ''}.</p>
          {attached.attached.length > 0 && <ul className="ia-list">{attached.attached.map((a) => <li key={a.file}>{a.file} → {a.title} <span className="ia-muted">(by {a.reason})</span></li>)}</ul>}
          {attached.unmatched.length > 0 && <p className="ia-muted">Not matched: {attached.unmatched.slice(0, 8).join(', ')}{attached.unmatched.length > 8 ? '…' : ''}</p>}
        </div>
      )}
      {error && <p className="ia-error" role="alert">{error}</p>}
    </Dialog>
  );
}
