import { useLayoutEffect, useRef, useState } from 'react';
import { Copy, CopyPlus, Link2, Link2Off, Palette, Pencil, Scissors, Sparkles, Trash2, Type } from 'lucide-react';
import type { SelectionInfo } from '../canvas/engine.ts';
import { INK_PALETTE } from '../state/settings.ts';
import { Popover, cx } from './primitives.tsx';

export function SelectionBar({ sel, onDelete, onDuplicate, onCopy, onCut, onRecolor, onAsk, onConvert, onEditText, aiReady, links = [], onOpenLink, onLink, onUnlink, extra }: {
  sel: SelectionInfo;
  onDelete: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onCut: () => void;
  onRecolor: (c: string) => void;
  onAsk: () => void;
  onConvert: () => void;
  onEditText?: () => void;
  aiReady: boolean;
  /** [[Wiki links]] found in selected text; tapping opens (or creates) that note. */
  links?: string[];
  onOpenLink?: (title: string) => void;
  /** Turn the selected ink into a link to a note ("Link to note…"). */
  onLink?: () => void;
  /** Remove the links riding on the selected ink. */
  onUnlink?: () => void;
  /** More actions for the selection (smart ink: Solve, Dates & links, Table). */
  extra?: React.ReactNode;
}) {
  const [colors, setColors] = useState(false);
  const colorBtn = useRef<HTMLButtonElement>(null);
  const top = sel.screen.y > 70 ? sel.screen.y - 56 : sel.screen.y + sel.screen.h + 12;
  const center = sel.screen.x + sel.screen.w / 2;
  // Centred on the selection, but never past the edges of the page area: a selection near a side
  // (or wider than the screen) would otherwise push half the bar off screen.
  const bar = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(center);
  useLayoutEffect(() => {
    const el = bar.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return;
    const half = el.offsetWidth / 2, room = host.clientWidth, pad = 8;
    const next = room < 2 * (half + pad) ? room / 2 : Math.min(room - half - pad, Math.max(half + pad, center));
    if (Math.abs(next - left) > 0.5) setLeft(next);
  });
  return (
    <>
      <div className="sel-box" style={{ left: sel.screen.x - 8, top: sel.screen.y - 8, width: sel.screen.w + 16, height: sel.screen.h + 16 }} aria-hidden>
        <span className="sel-handle" />
      </div>
      <div ref={bar} className="sel-bar" style={{ left, top }} role="toolbar" aria-label={`${sel.count} selected`}>
        {sel.texts === 1 && sel.count === 1 && onEditText && <button type="button" className="sel-btn" onClick={onEditText}><Pencil size={16} /><span>Edit</span></button>}
        {links.slice(0, 2).map((l) => <button key={l} type="button" className="sel-btn" onClick={() => onOpenLink?.(l)} title={`Open “${l}”`}><Link2 size={16} /><span>{l.length > 18 ? l.slice(0, 17) + '…' : l}</span></button>)}
        {sel.strokes > 0 && <button type="button" className="sel-btn" onClick={onConvert} title="Turn handwriting into typed text"><Type size={16} /><span>To text</span></button>}
        {onLink && <button type="button" className="sel-btn" onClick={onLink} title="Link to note…"><Link2 size={16} /><span>Link</span></button>}
        {onUnlink && <button type="button" className="sel-icon" aria-label="Remove link" title="Remove link" onClick={onUnlink}><Link2Off size={17} /></button>}
        {extra}
        <button type="button" className={cx('sel-btn', !aiReady && 'is-dim')} onClick={onAsk} title="Ask AI about this"><Sparkles size={16} /><span>Ask AI</span></button>
        <span className="sel-sep" />
        <button ref={colorBtn} type="button" className="sel-icon" aria-label="Change colour" onClick={() => setColors(true)}><Palette size={17} /></button>
        <button type="button" className="sel-icon" aria-label="Duplicate" onClick={onDuplicate}><CopyPlus size={17} /></button>
        <button type="button" className="sel-icon" aria-label="Copy" onClick={onCopy}><Copy size={17} /></button>
        <button type="button" className="sel-icon" aria-label="Cut" onClick={onCut}><Scissors size={17} /></button>
        <button type="button" className="sel-icon is-danger" aria-label="Delete" onClick={onDelete}><Trash2 size={17} /></button>
      </div>
      <Popover anchor={colorBtn.current} open={colors} onClose={() => setColors(false)} title="Colour" placement="below">
        <div className="swatches is-ink">
          {INK_PALETTE.map((c) => <button key={c} type="button" className={cx('swatch', c === '#FFFFFFFF' && 'is-white')} aria-label={c} style={{ background: '#' + c.slice(3) }} onClick={() => { onRecolor(c); setColors(false); }} />)}
        </div>
      </Popover>
    </>
  );
}
