import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, FileOutput, FilePlus2, FileUp, RotateCw, Trash2, X } from 'lucide-react';
import type { NoteDocument } from '@inkwright/core';
import { renderPageStandalone } from '../canvas/engine.ts';
import type { AssetCache } from '../canvas/assets.ts';
import type { AppVault } from '../lib/vault.ts';
import { describePages, extractPages, rotatePage } from '../lib/pageTools.ts';
import { insertPdf } from '../lib/openFiles.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { IconButton, cx } from './primitives.tsx';
import { PageSummaryNote, SummarizePagesButton, usePageSummaries } from './PageSummaries.tsx';

/**
 * Page sorter: thumbnails of every page, with add / duplicate / move / rotate / delete, adding the
 * pages of another PDF, and selecting pages to pull out into a note of their own.
 */
export function PagesPanel({ doc, current, assets, onGo, onClose, onDelete, vault, onOpenNote }: { doc: NoteDocument; current: number; assets: AssetCache; onGo: (i: number) => void; onClose: () => void; onDelete: (i: number) => void; vault?: AppVault; onOpenNote?: (id: string) => void }) {
  const [, force] = useState(0);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const { toast } = useApp();
  useEffect(() => doc.subscribe(() => force((x) => x + 1)), [doc]);
  const summaries = usePageSummaries(vault, doc.meta.id);
  const board = doc.meta.kind === 'board';
  const pickedIdx = picked ? doc.pages.map((p, i) => (picked.has(p.id) ? i : -1)).filter((i) => i >= 0) : [];

  const mergePdf = async () => {
    if (!vault) return;
    const [f] = await pickFiles('application/pdf', false);
    if (!f) return;
    try {
      const n = await insertPdf(vault, doc, f, current + 1);
      toast({ text: `Added ${n} ${n === 1 ? 'page' : 'pages'} from ${f.name}`, tone: 'success' });
      onGo(current + 1);
    } catch (e) {
      toast({ text: `Couldn't add ${f.name}: ${(e as Error).message}`, tone: 'error' });
    }
  };

  const extract = async () => {
    if (!vault || !pickedIdx.length) return;
    try {
      const id = await extractPages(vault, doc, pickedIdx);
      toast({ text: `Copied ${describePages(pickedIdx)} to a new note`, tone: 'success', action: onOpenNote ? { label: 'Open', run: () => onOpenNote(id) } : undefined });
      setPicked(null);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };

  return (
    <aside className="side-panel pages-panel" aria-label="Pages">
      <header className="side-head">
        <h2>Pages</h2>
        {vault && doc.pageCount > 0 && !board && (
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={!!picked} onClick={() => setPicked(picked ? null : new Set())}>{picked ? 'Cancel' : 'Select'}</button>
        )}
        <IconButton label="Close pages" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <ol className="page-list">
        {doc.pages.map((p, i) => (
          <li key={p.id} className={cx('page-item', i === current && 'is-on')}>
            <button type="button" className="page-thumb" onClick={() => (picked ? setPicked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; }) : onGo(i))} aria-label={picked ? `Select page ${i + 1}` : `Go to page ${i + 1}`}>
              <PageThumb doc={doc} index={i} assets={assets} version={doc.version} />
            </button>
            {picked && <input type="checkbox" className="page-pick" aria-label={`Page ${i + 1} selected`} checked={picked.has(p.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />}
            <div className="page-row">
              <span className="page-num">{i + 1}</span>
              <div className="page-acts">
                <IconButton label="Move up" disabled={i === 0} onClick={() => doc.movePage(i, i - 1)}><ArrowUp size={14} /></IconButton>
                <IconButton label="Move down" disabled={i === doc.pageCount - 1} onClick={() => doc.movePage(i, i + 1)}><ArrowDown size={14} /></IconButton>
                {!board && <IconButton label="Rotate page" onClick={() => rotatePage(doc, i)}><RotateCw size={14} /></IconButton>}
                <IconButton label="Duplicate page" onClick={() => doc.duplicatePage(i)}><Copy size={14} /></IconButton>
                <IconButton label="Delete page" disabled={doc.pageCount <= 1} onClick={() => onDelete(i)}><Trash2 size={14} /></IconButton>
              </div>
            </div>
            <PageSummaryNote doc={doc} pageIndex={i} summaries={summaries} />
          </li>
        ))}
      </ol>
      {picked ? (
        <div className="page-selbar">
          <span>{pickedIdx.length ? `${pickedIdx.length} selected` : 'Tap pages to select them'}</span>
          <button type="button" className="btn btn-sm" disabled={!pickedIdx.length} onClick={() => void extract()}><FileOutput size={15} /> Copy to new note</button>
        </div>
      ) : (
        <div className="page-tools">
          <button type="button" className="btn add-page" onClick={() => { const i = doc.addPage(current + 1, { paper: doc.page(current).paper, size: doc.page(current).background ? undefined : doc.page(current).size }); onGo(i); }}>
            <FilePlus2 size={16} /> Add page after {current + 1}
          </button>
          {vault && !board && <button type="button" className="btn" onClick={() => void mergePdf()}><FileUp size={16} /> Add a PDF</button>}
          {vault && <SummarizePagesButton doc={doc} vault={vault} />}
        </div>
      )}
    </aside>
  );
}

function PageThumb({ doc, index, assets, version }: { doc: NoteDocument; index: number; assets: AssetCache; version: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const page = doc.pages[index];
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (!page) return;
      const c = await renderPageStandalone({ meta: doc.meta, pages: doc.pages }, index, 150 / (doc.meta.pageSize.width || 794), assets);
      if (alive) setUrl(c.toDataURL('image/webp', 0.8));
    }, 120 + index * 30);
    return () => { alive = false; clearTimeout(t); };
    // Re-render when this page's content changes.
  }, [page, index, doc, assets, version]);
  return url ? <img src={url} alt="" /> : <span className="sheet-blank" />;
}
