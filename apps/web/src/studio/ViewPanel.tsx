import { useState } from 'react';
import { Eye, EyeOff, Lock, LockOpen } from 'lucide-react';
import { layerState, type NoteDocument, type StrokeLayer } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import { useSettings } from '../state/settings.ts';
import { Segmented, Switch, cx } from '../ui/primitives.tsx';

/**
 * ••• › View: one page or two side by side, the page's layers (which one you write on, hide,
 * lock), study mode for tape, and snapping.
 */
export function ViewPanel({ doc, engine, pageIndex, layer, onLayer }: { doc: NoteDocument; engine: InkEngine; pageIndex: number; layer: StrokeLayer; onLayer: (l: StrokeLayer) => void }) {
  const s = useSettings();
  const [reveal, setReveal] = useState(engine.tapeRevealAll);
  const page = doc.page(pageIndex);
  const hasTape = doc.pages.some((p) => p.objects?.some((o) => o.type === 'tape'));
  const set = (l: StrokeLayer, patch: { hidden?: boolean; locked?: boolean }) => {
    doc.setLayerState(pageIndex, l, patch);
    // Writing can't go on a layer you just hid or locked: switch to the other one.
    if ((patch.hidden || patch.locked) && l === layer) onLayer(l === 'writing' ? 'drawing' : 'writing');
  };
  const row = (l: StrokeLayer, name: string, hint: string) => {
    const st = page ? layerState(page, l) : { hidden: false, locked: false };
    return (
      <div className={cx('layer-row', layer === l && 'is-on')}>
        <button type="button" role="radio" aria-checked={layer === l} className="layer-pick" onClick={() => onLayer(l)} disabled={st.hidden || st.locked}>
          <span className="layer-name">{name}</span><span className="layer-hint">{layer === l ? 'You’re writing here' : hint}</span>
        </button>
        <button type="button" className="icon-btn" aria-label={`${st.hidden ? 'Show' : 'Hide'} ${name.toLowerCase()}`} aria-pressed={st.hidden} onClick={() => set(l, { hidden: !st.hidden })}>{st.hidden ? <EyeOff size={17} /> : <Eye size={17} />}</button>
        <button type="button" className="icon-btn" aria-label={`${st.locked ? 'Unlock' : 'Lock'} ${name.toLowerCase()}`} aria-pressed={st.locked} onClick={() => set(l, { locked: !st.locked })}>{st.locked ? <Lock size={16} /> : <LockOpen size={16} />}</button>
      </div>
    );
  };
  return (
    <div className="pop-section view-panel">
      {doc.meta.kind === 'paged' && (
        <>
          <h3 className="pop-title">Pages</h3>
          <Segmented label="Page view" value={s.pageView} onChange={(v) => s.update(() => ({ pageView: v }))} options={[
            { value: 'auto', label: 'Auto' },
            { value: 'single', label: 'One page' },
            { value: 'spread', label: 'Two pages' },
          ]} />
        </>
      )}
      <h3 className="pop-title">Layers on this page</h3>
      <div className="layer-rows" role="radiogroup" aria-label="Layer to write on">
        {row('writing', 'Writing layer', 'On top')}
        {row('drawing', 'Drawing layer', 'Underneath — for diagrams')}
      </div>
      {hasTape && <Switch label="Reveal all tape" hint="Study mode: tap a strip to reveal just that one" checked={reveal} onChange={(v) => { engine.setRevealAll(v); setReveal(v); }} />}
      <Switch label="Snap to guides" hint="Moving and resizing line things up. Hold Alt or rest a second finger to place freely." checked={s.input.snapping !== false} onChange={(v) => s.update((x) => ({ input: { ...x.input, snapping: v } }))} />
    </div>
  );
}
