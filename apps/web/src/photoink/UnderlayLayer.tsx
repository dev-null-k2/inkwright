import { useEffect, useState } from 'react';
import { pageSizeOf, type NoteDocument } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { useUnderlayView } from './photo.ts';

/**
 * Shows each visible page's original photo faintly over its traced ink while "Show the original
 * photo" is on, to check the tracing. Never drawn into the page itself or its exports.
 */
export function UnderlayLayer({ doc, engine, vault, view }: { doc: NoteDocument; engine: InkEngine; vault: AppVault; view: unknown }) {
  void view;
  const shown = useUnderlayView((s) => s.shown);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const pages = doc.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.underlay);
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    const made: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const { p } of pages) {
        const bytes = await vault.vault.readAsset(doc.meta.id, p.underlay!.asset);
        if (!bytes) continue;
        const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
        made.push(u);
        next[p.id] = u;
      }
      if (alive) setUrls(next);
    })();
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [shown, doc.meta.id, pages.map(({ p }) => p.underlay!.asset).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  return (
    <div className="ia-underlays" aria-hidden>
      {pages.map(({ p, i }) => {
        const size = pageSizeOf(doc.meta, p);
        const r = engine.pageRectToScreen(i, { minX: 0, minY: 0, maxX: size.width, maxY: size.height });
        return urls[p.id] ? <img key={p.id} src={urls[p.id]} alt="" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} /> : null;
      })}
    </div>
  );
}
