import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageUp, Plus, Trash2 } from 'lucide-react';
import { outlineToSvgPath, strokeOutline, type InkStroke } from '@inkwright/core';
import { drawStroke } from '../canvas/render.ts';
import { pickFiles } from '../platform/files.ts';
import { secrets } from '../lib/secrets.ts';
import { Dialog, IconButton, Popover, Segmented, cx } from '../ui/primitives.tsx';
import { SignatureLibrary, inkForPlacement, normalizeInk, removeBackground, tintInk, type SavedSignature, type SignatureKind } from './signatures.ts';
import { FORM_INK } from './marks.ts';

/** One library for the app session (it caches the decrypted list). */
let lib: SignatureLibrary | null = null;
export const signatureLibrary = () => (lib ??= new SignatureLibrary(secrets()));

/** Ink colours offered when placing: the two colours people sign forms with. */
export const SIGN_COLORS: { label: string; color: string }[] = [
  { label: 'Black', color: FORM_INK },
  { label: 'Blue', color: '#FF1D3F8F' },
];

const argbCss = (c: string) => `#${c.replace('#', '').slice(-6)}`;

/** Vector preview of a saved signature (ink) or the image itself. */
export function SignaturePreview({ sig, color = FORM_INK }: { sig: SavedSignature; color?: string }) {
  const paths = useMemo(() => (sig.ink ? inkForPlacement(sig, 0, 0, 100, color, 0, () => 'p').map((s) => outlineToSvgPath(strokeOutline(s))) : []), [sig, color]);
  if (sig.png) return <img className="sig-preview" src={`data:image/png;base64,${sig.png}`} alt={sig.text ? `Signature: ${sig.text}` : 'Signature'} style={{ aspectRatio: String(sig.aspect) }} />;
  return (
    <svg className="sig-preview" viewBox={`0 0 ${sig.aspect * 100} 100`} role="img" aria-label="Signature">
      {paths.map((d, i) => <path key={i} d={d} fill={argbCss(color)} />)}
    </svg>
  );
}

/** Pick a saved signature/initials (with ink colour), or make a new one. */
export function SignaturePicker({ anchor, open, kind, onClose, onPick }: { anchor: HTMLElement | null; open: boolean; kind: SignatureKind; onClose: () => void; onPick: (sig: SavedSignature, color: string) => void }) {
  const [list, setList] = useState<SavedSignature[] | null>(null);
  const [color, setColor] = useState(SIGN_COLORS[0]!.color);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void signatureLibrary().list().then((l) => alive && setList(l));
    return () => { alive = false; };
  }, [open]);
  const mine = (list ?? []).filter((s) => s.kind === kind);
  const noun = kind === 'initials' ? 'initials' : 'signature';
  return (
    <>
      <Popover anchor={anchor} open={open && !creating} onClose={onClose} title={kind === 'initials' ? 'Initials' : 'Signature'} placement="below" className="sig-pop">
        <div className="pop-section">
          <h3 className="pop-title">{kind === 'initials' ? 'Your initials' : 'Your signatures'}</h3>
          {list && !mine.length && <p className="muted small">No {noun} saved yet. Make one once and reuse it on any document. It stays on this device, encrypted.</p>}
          <ul className="sig-list">
            {mine.map((s) => (
              <li key={s.id}>
                <button type="button" className="sig-item" aria-label={`Use this ${noun}`} onClick={() => { onClose(); onPick(s, color); }}>
                  <SignaturePreview sig={s} color={color} />
                </button>
                <IconButton label={`Delete this ${noun}`} onClick={async () => { await signatureLibrary().remove(s.id); setList(await signatureLibrary().list()); }}><Trash2 size={15} /></IconButton>
              </li>
            ))}
          </ul>
          <div className="sig-row">
            <div className="sig-colors" role="radiogroup" aria-label="Ink colour">
              {SIGN_COLORS.map((c) => (
                <button key={c.color} type="button" role="radio" aria-checked={color === c.color} aria-label={c.label} className={cx('sig-color', color === c.color && 'is-on')} style={{ background: argbCss(c.color) }} onClick={() => setColor(c.color)} />
              ))}
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}><Plus size={15} /> New {noun}</button>
          </div>
        </div>
      </Popover>
      <SignatureCreator open={open && creating} kind={kind} onClose={() => { setCreating(false); onClose(); }}
        onSaved={(s) => { setCreating(false); onClose(); onPick(s, color); }} />
    </>
  );
}

type Tab = 'draw' | 'type' | 'image';

const TYPED_STYLES: { id: string; label: string; css: React.CSSProperties; font: (px: number) => string; skew: number }[] = [
  { id: 'script', label: 'Script', css: { fontFamily: 'var(--font-hand)', fontWeight: 560 }, font: (px) => `560 ${px}px 'Caveat Variable', 'Caveat', cursive`, skew: 0 },
  { id: 'bold', label: 'Bold', css: { fontFamily: 'var(--font-hand)', fontWeight: 720 }, font: (px) => `720 ${px}px 'Caveat Variable', 'Caveat', cursive`, skew: 0 },
  { id: 'slanted', label: 'Slanted', css: { fontFamily: 'var(--font-hand)', fontWeight: 480, transform: 'skewX(-14deg)' }, font: (px) => `480 ${px}px 'Caveat Variable', 'Caveat', cursive`, skew: -0.25 },
  { id: 'classic', label: 'Classic', css: { fontFamily: "'Newsreader Variable', Georgia, serif", fontStyle: 'italic', fontWeight: 450 }, font: (px) => `italic 450 ${px}px 'Newsreader Variable', Georgia, serif`, skew: 0 },
];

/** Draw (real ink), type (handwriting styles) or import (paper removed) a signature or initials. */
export function SignatureCreator({ open, kind, onClose, onSaved }: { open: boolean; kind: SignatureKind; onClose: () => void; onSaved: (s: SavedSignature) => void }) {
  const [tab, setTab] = useState<Tab>('draw');
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [typed, setTyped] = useState('');
  const [style, setStyle] = useState(TYPED_STYLES[0]!.id);
  const [image, setImage] = useState<{ png: string; aspect: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setStrokes([]); setTyped(''); setImage(null); setError(null); } }, [open]);
  const noun = kind === 'initials' ? 'initials' : 'signature';
  const canSave = tab === 'draw' ? strokes.length > 0 : tab === 'type' ? typed.trim().length > 0 : !!image;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let entry: SavedSignature;
      if (tab === 'draw') {
        const n = normalizeInk(strokes);
        if (!n) return;
        entry = await signatureLibrary().add({ kind, source: 'drawn', aspect: n.aspect, ink: n.ink });
      } else if (tab === 'type') {
        const st = TYPED_STYLES.find((s) => s.id === style)!;
        const r = await renderTyped(typed.trim(), st.font, st.skew);
        entry = await signatureLibrary().add({ kind, source: 'typed', aspect: r.aspect, png: r.png, text: typed.trim(), style });
      } else {
        entry = await signatureLibrary().add({ kind, source: 'image', aspect: image!.aspect, png: image!.png });
      }
      onSaved(entry);
    } catch (e) {
      setError(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const importImage = async () => {
    const [f] = await pickFiles('image/*', false);
    if (!f) return;
    setError(null);
    try {
      setImage(await signatureFromImage(f));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} title={kind === 'initials' ? 'New initials' : 'New signature'} onClose={onClose} wide
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!canSave || busy} onClick={() => void save()}>Save {noun}</button>
      </>}>
      <div className="sig-create">
        <Segmented<Tab> label="How to make it" value={tab} onChange={setTab} options={[{ value: 'draw', label: 'Draw' }, { value: 'type', label: 'Type' }, { value: 'image', label: 'Image' }]} />
        {tab === 'draw' && (
          <>
            <SignaturePad strokes={strokes} onChange={setStrokes} />
            <div className="sig-row">
              <span className="muted small">Write with your pen, finger or mouse.</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!strokes.length} onClick={() => setStrokes([])}>Clear</button>
            </div>
          </>
        )}
        {tab === 'type' && (
          <>
            <label className="field">
              <span className="field-label">{kind === 'initials' ? 'Your initials' : 'Your name'}</span>
              <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={kind === 'initials' ? 'A.L.' : 'Ada Lovelace'} autoFocus maxLength={60} />
            </label>
            <div className="sig-styles" role="radiogroup" aria-label="Style">
              {TYPED_STYLES.map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={style === s.id} className={cx('sig-style', style === s.id && 'is-on')} onClick={() => setStyle(s.id)}>
                  <span style={s.css}>{typed.trim() || (kind === 'initials' ? 'A.L.' : 'Ada Lovelace')}</span>
                  <span className="sig-style-name">{s.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {tab === 'image' && (
          <div className="sig-image">
            {image ? <img src={`data:image/png;base64,${image.png}`} alt="Imported signature" className="sig-preview" style={{ aspectRatio: String(image.aspect) }} /> : <p className="muted small">A photo or scan of your signature on white paper. The paper is removed, so it sits on any document.</p>}
            <button type="button" className="btn btn-sm" onClick={() => void importImage()}><ImageUp size={15} /> {image ? 'Choose another image' : 'Choose image'}</button>
          </div>
        )}
        {error && <p className="sig-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

/** A small writing surface that records real ink (pressure, timing). */
export function SignaturePad({ strokes, onChange }: { strokes: InkStroke[]; onChange: (s: InkStroke[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef<InkStroke | null>(null);
  const t0 = useRef(0);

  const redraw = (extra?: InkStroke | null) => {
    const c = ref.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Signing line, like on paper.
    ctx.strokeStyle = 'rgba(120,110,130,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(16, r.height * 0.74);
    ctx.lineTo(r.width - 16, r.height * 0.74);
    ctx.stroke();
    for (const s of [...strokes, ...(extra ? [extra] : [])]) drawStroke(ctx, s, { paperColor: '#ffffff' });
  };
  useEffect(() => { redraw(); });

  const pt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp - t0.current, p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : -1, tilt: -1, orient: -1 };
  };
  return (
    <canvas ref={ref} className="sig-pad" aria-label="Signature pad: write here"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        t0.current = e.timeStamp;
        live.current = { id: `s${strokes.length}`, pen: 'fountain', color: FORM_INK, size: 2.6, createdAt: Date.now(), points: [pt(e)] };
        redraw(live.current);
      }}
      onPointerMove={(e) => {
        const s = live.current;
        if (!s) return;
        const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []) as PointerEvent[];
        for (const ev of evs.length ? evs : [e.nativeEvent]) s.points.push(pt(ev as unknown as React.PointerEvent));
        redraw(s);
      }}
      onPointerUp={() => {
        const s = live.current;
        live.current = null;
        if (s && s.points.length) onChange([...strokes, s]);
      }}
      onPointerCancel={() => { live.current = null; redraw(); }}
    />
  );
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function canvasPng(c: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not encode the image');
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Crops a canvas to the given pixel box plus padding. */
function crop(src: HTMLCanvasElement, b: { minX: number; minY: number; maxX: number; maxY: number }, pad: number): HTMLCanvasElement {
  const x = Math.max(0, b.minX - pad), y = Math.max(0, b.minY - pad);
  const w = Math.min(src.width - x, b.maxX - b.minX + 1 + pad * 2), h = Math.min(src.height - y, b.maxY - b.minY + 1 + pad * 2);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

/** Renders typed words in a handwriting style as a transparent PNG, cropped to the ink. */
export async function renderTyped(text: string, font: (px: number) => string, skew: number): Promise<{ png: string; aspect: number }> {
  const px = 120;
  try { await document.fonts?.load(font(px), text); } catch { /* fall back to whatever is loaded */ }
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font(px);
  const w = Math.ceil(ctx.measureText(text).width + px * (1 + Math.abs(skew)));
  c.width = w;
  c.height = Math.ceil(px * 1.8);
  ctx.font = font(px);
  ctx.fillStyle = argbCss(FORM_INK);
  ctx.textBaseline = 'alphabetic';
  ctx.setTransform(1, 0, skew, 1, -skew * px, 0);
  ctx.fillText(text, px * 0.4, px * 1.2);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (data[(y * c.width + x) * 4 + 3]! > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) throw new Error('Nothing to save');
  const out = crop(c, { minX, minY, maxX, maxY }, 6);
  return { png: await canvasPng(out), aspect: out.width / out.height };
}

/** Loads a photo/scan, removes the paper and crops to the signature. */
export async function signatureFromImage(file: Blob): Promise<{ png: string; aspect: number }> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error("This browser can't open that image. Try a PNG or JPEG."); }
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const b = removeBackground(img.data, c.width, c.height);
  if (!b) throw new Error('No signature found in that image. Use a photo of dark ink on light paper.');
  ctx.putImageData(img, 0, 0);
  const out = crop(c, b, 8);
  return { png: await canvasPng(out), aspect: out.width / out.height };
}

/** Recolours a transparent signature PNG (bytes) and returns new PNG bytes. */
export async function recolorPng(bytes: Uint8Array, color: string): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  tintInk(img.data, color);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not encode the image');
  return new Uint8Array(await blob.arrayBuffer());
}
