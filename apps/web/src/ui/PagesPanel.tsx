import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, FilePlus2, Trash2, X } from 'lucide-react';
import type { NoteDocument } from '@inkstone/core';
import { renderPageStandalone } from '../canvas/engine.ts';
import type { AssetCache } from '../canvas/assets.ts';
import { IconButton, cx } from './primitives.tsx';

/** Page sorter: thumbnails of every page, with add / duplicate / move / delete. */
export function PagesPanel({ doc, current, assets, onGo, onClose, onDelete }: { doc: NoteDocument; current: number; assets: AssetCache; onGo: (i: number) => void; onClose: () => void; onDelete: (i: number) => void }) {
  const [, force] = useState(0);
  useEffect(() => doc.subscribe(() => force((x) => x + 1)), [doc]);
  return (
    <aside className="side-panel pages-panel" aria-label="Pages">
      <header className="side-head">
        <h2>Pages</h2>
        <IconButton label="Close pages" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <ol className="page-list">
        {doc.pages.map((p, i) => (
          <li key={p.id} className={cx('page-item', i === current && 'is-on')}>
            <button type="button" className="page-thumb" onClick={() => onGo(i)} aria-label={`Go to page ${i + 1}`}>
              <PageThumb doc={doc} index={i} assets={assets} version={doc.version} />
            </button>
            <div className="page-row">
              <span className="page-num">{i + 1}</span>
              <div className="page-acts">
                <IconButton label="Move up" disabled={i === 0} onClick={() => doc.movePage(i, i - 1)}><ArrowUp size={14} /></IconButton>
                <IconButton label="Move down" disabled={i === doc.pageCount - 1} onClick={() => doc.movePage(i, i + 1)}><ArrowDown size={14} /></IconButton>
                <IconButton label="Duplicate page" onClick={() => doc.duplicatePage(i)}><Copy size={14} /></IconButton>
                <IconButton label="Delete page" disabled={doc.pageCount <= 1} onClick={() => onDelete(i)}><Trash2 size={14} /></IconButton>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" className="btn add-page" onClick={() => { const i = doc.addPage(current + 1, { paper: doc.page(current).paper, size: doc.page(current).background ? undefined : doc.page(current).size }); onGo(i); }}>
        <FilePlus2 size={16} /> Add page after {current + 1}
      </button>
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
