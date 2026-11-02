import { useEffect, useMemo, useRef } from 'react';
import { Play } from 'lucide-react';
import type { PaperTexture } from '@inkwright/core';
import { PaperFeel } from '../platform/feel.ts';
import { hasNativePlugin } from '../platform/native.ts';
import { useSettings } from '../state/settings.ts';
import { Segmented, Switch } from './primitives.tsx';

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Writing sound and paper grain, adjustable while writing (editor popover) or in Settings.
 * Letting go of a slider plays a short sample stroke so you hear and feel the change at once.
 */
export function FeelPanel({ feel, texture, onTexture }: { feel?: PaperFeel | null; texture?: PaperTexture; onTexture?: (t: PaperTexture) => void }) {
  const s = useSettings();
  const f = s.feel;
  const setFeel = (p: Partial<typeof f>) => s.update((x) => ({ feel: { ...x.feel, ...p } }));
  // Settings has no editor running: use a private engine just for previews.
  const own = useMemo(() => (feel ? null : new PaperFeel(useSettings.getState().feel)), [feel]);
  useEffect(() => () => own?.dispose(), [own]);
  const engine = feel ?? own;
  const pending = useRef(0);
  const preview = () => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => engine?.preview(useSettings.getState().feel), 60);
  };

  return (
    <div className="feel-panel">
      <Switch label="Writing sound" hint="Soft nib-on-paper sound that follows speed and pressure" checked={f.sound} onChange={(v) => { setFeel({ sound: v }); if (v) preview(); }} />
      <label className={`row-slider${f.sound ? '' : ' is-dim'}`}>
        <span className="row-label">Volume</span>
        <input type="range" min={0.05} max={1} step={0.05} value={f.soundVolume} aria-label="Writing sound volume" disabled={!f.sound}
          onChange={(e) => setFeel({ soundVolume: Number(e.target.value) })} onPointerUp={preview} onKeyUp={preview} />
        <output>{f.sound ? pct(f.soundVolume) : 'Off'}</output>
      </label>
      {hasNativePlugin ? (
        <>
          <Switch label="Paper grain" hint="Fine haptic ticks as the nib crosses paper fibres" checked={f.haptics} onChange={(v) => { setFeel({ haptics: v }); if (v) preview(); }} />
          <label className={`row-slider${f.haptics ? '' : ' is-dim'}`}>
            <span className="row-label">Grain strength</span>
            <input type="range" min={0.1} max={1} step={0.05} value={f.hapticStrength} aria-label="Paper grain strength" disabled={!f.haptics}
              onChange={(e) => setFeel({ hapticStrength: Number(e.target.value) })} onPointerUp={preview} onKeyUp={preview} />
            <output>{f.haptics ? pct(f.hapticStrength) : 'Off'}</output>
          </label>
        </>
      ) : null}
      {texture && onTexture && (
        <div className="feel-surface">
          <span className="row-label">Paper surface</span>
          <Segmented label="Paper surface" value={texture} onChange={(v) => { onTexture(v as PaperTexture); preview(); }}
            options={[{ value: 'smooth', label: 'Smooth' }, { value: 'standard', label: 'Standard' }, { value: 'toothy', label: 'Toothy' }]} />
        </div>
      )}
      <button type="button" className="btn btn-ghost btn-sm feel-try" onClick={() => engine?.preview(useSettings.getState().feel)}>
        <Play size={14} /> Try it
      </button>
    </div>
  );
}
