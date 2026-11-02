import { useEffect, useState } from 'react';
import { CopyPlus, History, RotateCcw } from 'lucide-react';
import { SNAPSHOT_REASONS, newId, type InkLink, type NoteDocument, type PageInk, type Snapshot, type SnapshotInfo } from '@inkwright/core';
import { renderPageStandalone } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { Dialog, cx } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import type { NoteVersioning } from './versions.ts';

/**
 * Version history: every saved version of the note, newest first, grouped by day. Picking one
 * shows its pages as thumbnails; the whole note can be restored (after a snapshot of how it is
 * now, so a restore can itself be undone from here) or a single page copied into the note.
 */
export function HistoryDialog({ open, onClose, doc, vault, versioning, currentPage }: { open: boolean; onClose: () => void; doc: NoteDocument; vault: AppVault; versioning: NoteVersioning | null; currentPage: number }) {
  const { toast } = useApp();
  const [list, setList] = useState<SnapshotInfo[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !versioning) return;
    let alive = true;
    setSnap(null); setThumbs([]); setError(null);
    // The note as it is now becomes a version too, so it can be compared and returned to.
    void versioning.take('manual').then(() => versioning.history.list(doc.meta.id)).then((l) => {
      if (!alive) return;
      setList(l);
      setPicked(l[1]?.id ?? l[0]?.id ?? null);
    });
    return () => { alive = false; };
  }, [open, versioning, doc]);

  useEffect(() => {
    if (!open || !picked || !versioning) return;
    let alive = true;
    setThumbs([]);
    setError(null);
    void (async () => {
      try {
        const s = await versioning.history.read(doc.meta.id, picked);
        if (!alive) return;
        if (!s) { setError('This version can’t be read on this device.'); return; }
        setSnap(s);
        const out: string[] = [];
        for (let i = 0; i < s.pages.length; i++) {
          const width = s.meta.kind === 'board' ? 900 : s.meta.pageSize.width || 794;
          const c = await renderPageStandalone({ meta: s.meta, pages: s.pages }, i, 200 / width, vault.assets);
          if (!alive) return;
          out.push(c.toDataURL('image/webp', 0.8));
          setThumbs([...out]);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [open, picked, versioning, doc, vault]);

  const restore = async () => {
    if (!snap || !versioning) return;
    const when = new Date(snap.info.takenAt).toLocaleString();
    if (!(await askConfirm('Restore this version?', `The note goes back to how it was on ${when}. How it is now is kept in its history.`, 'Restore'))) return;
    // Always recorded (even if identical to an earlier version) so "Before restoring" is easy to find.
    await versioning.take('restore', true);
    doc.restoreVersion(snap.meta, snap.pages);
    await versioning.session.flush();
    toast({ text: `Restored the version from ${when}`, tone: 'success' });
    onClose();
  };

  const copyPage = (i: number) => {
    if (!snap) return;
    const at = copyPageInto(doc, snap.pages[i]!, currentPage + 1);
    toast({ text: `Copied page ${i + 1} of that version in as page ${at + 1}`, tone: 'success' });
  };

  const groups = new Map<string, SnapshotInfo[]>();
  for (const s of list ?? []) {
    const day = new Date(s.takenAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    groups.set(day, [...(groups.get(day) ?? []), s]);
  }

  return (
    <Dialog open={open} wide title="Version history" onClose={onClose} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      <button type="button" className="btn btn-primary" disabled={!snap || snap.info.id === list?.[0]?.id} onClick={() => void restore()}><RotateCcw size={16} /> Restore this version</button>
    </>}>
      {list && list.length === 0 && <p>No versions yet. They are saved automatically as you write.</p>}
      {list && list.length > 0 && (
        <div className="history">
          <ol className="history-list" aria-label="Versions">
            {[...groups].map(([day, items]) => (
              <li key={day}>
                <h3 className="history-day">{day}</h3>
                <ul>
                  {items.map((s) => (
                    <li key={s.id}>
                      <button type="button" className={cx('history-item', picked === s.id && 'is-on')} aria-pressed={picked === s.id} onClick={() => setPicked(s.id)}>
                        <History size={14} aria-hidden />
                        <span className="history-time">{new Date(s.takenAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                        <span className="history-why">{s.id === list[0]!.id ? 'Now' : SNAPSHOT_REASONS[s.reason]}</span>
                        <span className="history-pages">{s.pageCount} {s.pageCount === 1 ? 'page' : 'pages'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <div className="history-preview" aria-live="polite">
            {error && <p className="lock-error">{error}</p>}
            {snap && <p className="history-meta">{snap.meta.title}</p>}
            <div className="history-pages-grid">
              {thumbs.map((url, i) => (
                <figure key={i} className="history-page">
                  <img src={url} alt={`Page ${i + 1} of this version`} />
                  <figcaption>
                    <span>Page {i + 1}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyPage(i)} aria-label={`Copy page ${i + 1} into the note`}><CopyPlus size={14} /> Copy in</button>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Adds a page from an old version after `at` with fresh ids — a copy, like duplicating a page —
 * through `NoteDocument.commit`, so it undoes in one step and enters the authorship chain as copied.
 */
export function copyPageInto(doc: NoteDocument, page: PageInk, at: number): number {
  const i = doc.addPage(at, { paper: page.paper, size: page.size, background: page.background, layers: page.layers });
  const ids = new Map<string, string>();
  const fresh = <T extends { id: string }>(xs: T[] | undefined) => (xs ?? []).map((x, index) => { const id = newId(); ids.set(x.id, id); return { index, item: { ...x, id } }; });
  const strokes = fresh(page.strokes);
  const links = (page.links ?? []).map((l: InkLink, index) => ({ index, item: { ...l, id: newId(), strokeIds: l.strokeIds.map((s) => ids.get(s) ?? s) } }));
  doc.commit(i, { label: 'Copy page from history', strokes: { removed: [], added: strokes }, texts: { removed: [], added: fresh(page.texts) }, images: { removed: [], added: fresh(page.images) }, objects: { removed: [], added: fresh(page.objects) }, links: { removed: [], added: links } }, 'copy');
  if (page.recognizedText) doc.setRecognizedText(doc.pages[i]!.id, page.recognizedText, page.recognizedBy);
  return i;
}
