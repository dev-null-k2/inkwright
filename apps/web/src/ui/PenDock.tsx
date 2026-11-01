import { useMemo, useRef, useState } from 'react';
import { Eraser, Hand, Lasso, Plus, Redo2, Type, Undo2, Wand2, Trash2, Crosshair } from 'lucide-react';
import { PEN_INFO, PEN_TYPES, newId, outlineToSvgPath, strokeOutline, type InkPoint, type PenType } from '@inkstone/core';
import type { PenPreset, Tool } from '../canvas/engine.ts';
import { PenNib, argbToCss } from './PenNib.tsx';
import { IconButton, Popover, Segmented, Slider, cx } from './primitives.tsx';
import { HIGHLIGHT_PALETTE, INK_PALETTE, useSettings } from '../state/settings.ts';
import { modKey } from '../platform/env.ts';

export interface DockProps {
  tool: Tool;
  activePresetId: string;
  latched: boolean;
  canUndo: boolean;
  canRedo: boolean;
  vertical: boolean;
  /** Undo/redo live in the top bar on phones to leave room for pens. */
  compact?: boolean;
  onTool: (t: Tool) => void;
  onPreset: (id: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearPage: () => void;
}

export function PenDock(p: DockProps) {
  const s = useSettings();
  const [editing, setEditing] = useState<string | null>(null);
  const [eraserOpen, setEraserOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const eraserBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);

  const editingPreset = s.tray.find((x) => x.id === editing) ?? null;

  const choosePen = (id: string) => {
    if (p.tool === 'pen' && p.activePresetId === id) setEditing(id);
    else p.onPreset(id);
  };

  const addPen = () => {
    const preset: PenPreset = { id: newId(), pen: 'fountain', color: '#FF1B1F24', size: 2.6 };
    s.update((x) => ({ tray: [...x.tray, preset], activePresetId: preset.id }));
    p.onPreset(preset.id);
    setTimeout(() => setEditing(preset.id), 50);
  };

  return (
    <div className={cx('dock', p.vertical ? 'is-vertical' : 'is-horizontal', p.compact && 'is-compact')} role="toolbar" aria-label="Writing tools" aria-orientation={p.vertical ? 'vertical' : 'horizontal'}>
      {!p.compact && (
        <>
          <div className="dock-group">
            <IconButton label="Undo" shortcut={`${modKey}Z`} onClick={p.onUndo} disabled={!p.canUndo}><Undo2 size={19} /></IconButton>
            <IconButton label="Redo" shortcut={`${modKey}⇧Z`} onClick={p.onRedo} disabled={!p.canRedo}><Redo2 size={19} /></IconButton>
          </div>
          <div className="dock-sep" />
        </>
      )}
      <div className="tray" role="radiogroup" aria-label="Pens">
        {s.tray.map((preset, i) => {
          const on = p.tool === 'pen' && p.activePresetId === preset.id && !p.latched;
          return (
            <button
              key={preset.id}
              ref={(el) => { if (el) refs.current.set(preset.id, el); }}
              type="button"
              role="radio"
              aria-checked={on}
              className={cx('pen', on && 'is-on')}
              title={`${PEN_INFO[preset.pen].name}${i < 9 ? ` (${i + 1})` : ''}${on ? ' — tap again to adjust' : ''}`}
              aria-label={`${PEN_INFO[preset.pen].name}, ${colorName(preset.color)}`}
              onClick={() => choosePen(preset.id)}
            >
              <PenNib pen={preset.pen} color={preset.color} size={p.vertical ? 0.78 : 0.66} />
              <span className="pen-size" style={{ width: Math.min(14, 3 + preset.size * 0.8), height: Math.min(14, 3 + preset.size * 0.8), background: argbToCss(preset.color, preset.pen === 'highlighter' ? 0.6 : 1) }} />
            </button>
          );
        })}
        <IconButton label="Add a pen" onClick={addPen} className="tray-add"><Plus size={17} /></IconButton>
      </div>
      <div className="dock-sep" />
      <div className="dock-group">
        <button ref={eraserBtn} type="button" className={cx('icon-btn', (p.tool === 'eraser' || (p.latched && s.input.buttonAction !== 'lasso')) && 'is-active', p.latched && 'is-latched')}
          aria-label="Eraser" title={`Eraser (E)${p.tool === 'eraser' ? ' — tap again for options' : ''}`}
          onClick={() => (p.tool === 'eraser' ? setEraserOpen(true) : p.onTool('eraser'))}>
          <Eraser size={20} />
          {s.eraserMode === 'precise' && <span className="tool-badge" aria-hidden>·</span>}
        </button>
        <IconButton label="Lasso select" shortcut="L" active={p.tool === 'lasso'} onClick={() => p.onTool('lasso')}><Lasso size={20} /></IconButton>
        <IconButton label="Text" shortcut="T" active={p.tool === 'text'} onClick={() => p.onTool('text')}><Type size={20} /></IconButton>
        <button ref={moreBtn} type="button" className={cx('icon-btn', (p.tool === 'hand' || p.tool === 'laser') && 'is-active')} aria-label="More tools" title="More tools" onClick={() => setMoreOpen(true)}>
          {p.tool === 'laser' ? <Crosshair size={20} /> : p.tool === 'hand' ? <Hand size={20} /> : <Wand2 size={20} />}
        </button>
      </div>

      {editingPreset && (
        <Popover anchor={refs.current.get(editingPreset.id) ?? null} open onClose={() => setEditing(null)} title="Pen settings" placement={p.vertical ? 'right' : 'above'}>
          <PenEditor preset={editingPreset} onClose={() => setEditing(null)} />
        </Popover>
      )}
      <Popover anchor={eraserBtn.current} open={eraserOpen} onClose={() => setEraserOpen(false)} title="Eraser" placement={p.vertical ? 'right' : 'above'}>
        <div className="pop-section">
          <Segmented label="Eraser mode" value={s.eraserMode} onChange={(v) => s.update(() => ({ eraserMode: v }))} options={[
            { value: 'stroke', label: 'Whole strokes' },
            { value: 'precise', label: 'Precise' },
          ]} />
          <Slider label="Size" value={s.eraserSize} min={8} max={80} step={1} onChange={(v) => s.update(() => ({ eraserSize: v }))} format={(v) => `${v}px`} />
          <button type="button" className="btn btn-danger-ghost" onClick={() => { setEraserOpen(false); p.onClearPage(); }}><Trash2 size={16} /> Clear page</button>
        </div>
      </Popover>
      <Popover anchor={moreBtn.current} open={moreOpen} onClose={() => setMoreOpen(false)} title="More tools" placement={p.vertical ? 'right' : 'above'}>
        <div className="menu">
          <button type="button" className={cx('menu-item', p.tool === 'hand' && 'is-on')} onClick={() => { p.onTool('hand'); setMoreOpen(false); }}><span className="menu-icon"><Hand size={16} /></span><span className="menu-label">Pan and zoom</span><span className="menu-hint">H</span></button>
          <button type="button" className={cx('menu-item', p.tool === 'laser' && 'is-on')} onClick={() => { p.onTool('laser'); setMoreOpen(false); }}><span className="menu-icon"><Crosshair size={16} /></span><span className="menu-label">Laser pointer</span><span className="menu-hint">K</span></button>
        </div>
      </Popover>
    </div>
  );
}

function colorName(c: string) {
  const map: Record<string, string> = { '#FF1B1F24': 'ink black', '#FF1F3A93': 'navy', '#FF4A4F57': 'graphite', '#FFC0392B': 'red', '#FFFFD54A': 'yellow' };
  return map[c] ?? c;
}

const SAMPLE: InkPoint[] = Array.from({ length: 60 }, (_, i) => {
  const f = i / 59;
  return { x: 12 + f * 196, y: 30 + Math.sin(f * Math.PI * 2.2) * 12, t: i * 10, p: 0.25 + 0.7 * Math.sin(f * Math.PI), tilt: -1, orient: -1 };
});

export function PenEditor({ preset, onClose }: { preset: PenPreset; onClose: () => void }) {
  const s = useSettings();
  const set = (patch: Partial<PenPreset>) => s.update((x) => ({ tray: x.tray.map((p) => (p.id === preset.id ? { ...p, ...patch } : p)) }));
  const palette = preset.pen === 'highlighter' ? HIGHLIGHT_PALETTE : INK_PALETTE;
  const sample = useMemo(() => outlineToSvgPath(strokeOutline({ pen: preset.pen, size: preset.size * 1.6, points: SAMPLE })), [preset.pen, preset.size]);
  const remove = () => {
    if (s.tray.length <= 1) return;
    s.update((x) => {
      const tray = x.tray.filter((p) => p.id !== preset.id);
      return { tray, activePresetId: x.activePresetId === preset.id ? tray[0]!.id : x.activePresetId };
    });
    onClose();
  };
  const css = '#' + preset.color.slice(3);
  return (
    <div className="pen-editor">
      <svg className="pen-sample" viewBox="0 0 220 60" aria-hidden>
        <path d={sample} fill={argbToCss(preset.color, preset.pen === 'highlighter' ? 0.45 : 1)} strokeDasharray={preset.pen === 'dashed' ? '6 4' : undefined} />
      </svg>
      <div className="pen-types" role="radiogroup" aria-label="Pen type">
        {PEN_TYPES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={preset.pen === t} className={cx('pen-type', preset.pen === t && 'is-on')} onClick={() => set({ pen: t, size: preset.pen === t ? preset.size : PEN_INFO[t].defaultSize, color: t === 'highlighter' && preset.pen !== 'highlighter' ? HIGHLIGHT_PALETTE[0]! : preset.color })} title={PEN_INFO[t].name}>
            <PenNib pen={t} color={preset.color} size={0.5} />
            <span>{PEN_INFO[t].name.replace(' pen', '').replace(' line', '')}</span>
          </button>
        ))}
      </div>
      <div className="swatches is-ink" role="radiogroup" aria-label="Colour">
        {palette.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={preset.color === c} aria-label={c} className={cx('swatch', preset.color === c && 'is-on', c === '#FFFFFFFF' && 'is-white')} style={{ background: '#' + c.slice(3) }} onClick={() => set({ color: c })} />
        ))}
        <label className="swatch is-custom" title="Custom colour">
          <input type="color" value={css} onChange={(e) => set({ color: ('#FF' + e.target.value.slice(1)).toUpperCase() })} aria-label="Custom colour" />
        </label>
      </div>
      <Slider label="Size" value={preset.size} min={preset.pen === 'highlighter' ? 6 : 0.6} max={preset.pen === 'highlighter' ? 40 : preset.pen === 'brush' || preset.pen === 'marker' ? 24 : 12} step={0.1} onChange={(v) => set({ size: v })} format={(v) => `${(v * 0.2646).toFixed(2)} mm`} />
      <div className="pen-editor-foot">
        {useSettings.getState().highlighterId !== preset.id && preset.pen === 'highlighter' && (
          <button type="button" className="btn btn-ghost" onClick={() => s.update(() => ({ highlighterId: preset.id }))}>Use for pen button</button>
        )}
        <button type="button" className="btn btn-danger-ghost" disabled={s.tray.length <= 1} onClick={remove}><Trash2 size={15} /> Remove pen</button>
      </div>
    </div>
  );
}
