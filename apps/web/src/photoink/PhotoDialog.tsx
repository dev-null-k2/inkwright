import { useRef, useState } from 'react';
import { Camera, ImageUp } from 'lucide-react';
import { create } from 'zustand';
import { pageSizeOf, type NoteDocument, type Quad, type Rgba } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { Dialog } from '../ui/primitives.tsx';
import { addTracedPage, decodePhoto, detectCorners, trace } from './photo.ts';

/**
 * Photo to ink: choose or take a photo, check the page corners (found automatically; drag a
 * handle, or focus it and use the arrow keys), and make ink. The result is a new page after the
 * current one.
 */

interface State { open: boolean; doc: NoteDocument | null; engine: InkEngine | null; vault: AppVault | null }
export const usePhotoDialog = create<State>(() => ({ open: false, doc: null, engine: null, vault: null }));
export function openPhotoToInk(vault: AppVault, doc: NoteDocument, engine: InkEngine | null) { usePhotoDialog.setState({ open: true, vault, doc, engine }); }

export function PhotoDialogHost() {
  const s = usePhotoDialog();
  if (!s.open || !s.doc || !s.vault) return null;
  return <PhotoDialog vault={s.vault} doc={s.doc} engine={s.engine} onClose={() => usePhotoDialog.setState({ open: false })} />;
}

const CORNER_NAMES = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];

function PhotoDialog({ vault, doc, engine, onClose }: { vault: AppVault; doc: NoteDocument; engine: InkEngine | null; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [photo, setPhoto] = useState<{ image: Rgba; url: string } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [found, setFound] = useState(true);
  const [busy, setBusy] = useState<'' | 'load' | 'trace'>('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);

  const choose = async (camera: boolean) => {
    const [f] = await pickFiles('image/*', false, camera ? 'environment' : undefined);
    if (!f) return;
    setBusy('load'); setError(null);
    try {
      const p = await decodePhoto(f);
      const c = detectCorners(p.image);
      setPhoto(p); setQuad(c.quad); setFound(c.found);
    } catch (e) {
      setError(`Couldn't open that photo: ${(e as Error).message}`);
    } finally { setBusy(''); }
  };

  const move = (i: number, x: number, y: number) => setQuad((q) => (q ? (q.map((p, k) => (k === i ? { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) } : p)) as Quad) : q));
  const onPointer = (e: React.PointerEvent) => {
    if (drag.current == null || !box.current) return;
    const r = box.current.getBoundingClientRect();
    move(drag.current, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };

  const make = async () => {
    if (!photo || !quad) return;
    setBusy('trace'); setError(null);
    try {
      const after = engine?.currentPageIndex ?? doc.pageCount - 1;
      const width = pageSizeOf(doc.meta, doc.page(after)).width || 794;
      const r = await trace(photo.image, quad, width);
      if (!r.strokes.length) throw new Error('No ink found in the photo. Try a sharper photo with darker ink.');
      const i = await addTracedPage(vault, doc, after, r);
      engine?.scrollToPage(i);
      toast({ text: `Traced ${r.strokes.length} strokes onto page ${i + 1}`, tone: 'success', action: { label: 'Undo', run: () => (engine ? engine.undo() : doc.undo()) } });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(''); }
  };

  return (
    <Dialog open title="Photo to ink" wide onClose={onClose} actions={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={!photo || !!busy} onClick={() => void make()}>{busy === 'trace' ? 'Tracing…' : 'Make ink'}</button>
    </>}>
      {!photo ? (
        <div className="ia-photo-pick">
          <p>A photo of handwriting or a diagram on paper becomes real ink on a new page, straightened and cleaned up. The photo stays with the page, hidden, to compare against.</p>
          <div className="ia-row">
            <button type="button" className="btn" disabled={!!busy} onClick={() => void choose(false)}><ImageUp size={16} aria-hidden /> Choose a photo</button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void choose(true)}><Camera size={16} aria-hidden /> Take a photo</button>
          </div>
          {busy === 'load' && <p role="status">Opening…</p>}
        </div>
      ) : (
        <div className="ia-photo">
          <p className="ia-muted" role="status">{found ? 'Found the page. Drag the corners if they are off.' : 'Couldn’t find the page’s edges; drag the corners onto them.'}</p>
          <div ref={box} className="ia-photo-stage" onPointerMove={onPointer} onPointerUp={() => (drag.current = null)} onPointerLeave={() => (drag.current = null)}>
            <img src={photo.url} alt="The photo" draggable={false} />
            {quad && (
              <svg className="ia-photo-quad" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
                <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} vectorEffect="non-scaling-stroke" />
              </svg>
            )}
            {quad?.map((p, i) => (
              <button key={i} type="button" className="ia-photo-handle" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                aria-label={`${CORNER_NAMES[i]} corner: use the arrow keys to move it`}
                onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = i; }}
                onPointerMove={onPointer} onPointerUp={() => (drag.current = null)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 0.02 : 0.004;
                  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
                  if (d) { e.preventDefault(); move(i, p.x + d[0]!, p.y + d[1]!); }
                }} />
            ))}
          </div>
        </div>
      )}
      {error && <p className="ia-error" role="alert">{error}</p>}
    </Dialog>
  );
}
