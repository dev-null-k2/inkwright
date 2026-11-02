import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, FileDown, PenLine, Signature, Type, X } from 'lucide-react';
import { newId, pageSizeOf, type FormFieldValue, type ImageItem, type InkStroke, type NoteDocument, type TextBox } from '@inkstone/core';
import type { InkEngine, SelectionInfo, Tool } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import type { EditorSession } from '../lib/session.ts';
import { recognizeLocally } from '../lib/recognition.ts';
import { useApp } from '../state/app.ts';
import { safeStorage } from '../platform/env.ts';
import { Dialog, IconButton, Switch, cx } from '../ui/primitives.tsx';
import { coerce, clampText, effectiveValue, missingRequired, pdfAssetsOf, placeWidgets, readPdfFormFromDoc, withFormValue, type PdfField, type PdfFormInfo, type PlacedWidget } from './pdfForm.ts';
import { grayFromRGBA, placeMark, placeText, type GrayImage } from './snap.ts';
import { FORM_INK, checkmark, cross, formDate } from './marks.ts';
import { SignaturePicker, SIGN_COLORS, recolorPng } from './SignatureDialogs.tsx';
import { inkForPlacement, type SavedSignature, type SignatureKind } from './signatures.ts';
import { saveDocument } from '../platform/saveAs.ts';

/**
 * Fill & sign: the calm layer over a PDF note that turns it into a form you can complete.
 *  - AcroForm fields show as tappable fields exactly over the page at any zoom (HTML positioned
 *    from the engine's viewport). Finger/mouse taps type into them; the pen writes ink as usual,
 *    and ink written inside a text field becomes its value when on-device recognition is there.
 *  - Flat PDFs: text, checkmark, cross, date, initials and signature are placed with a tap, snapped
 *    to the printed line or box under it, and are ordinary ink/text/images afterwards (move,
 *    resize, recolour with the lasso).
 *  - Values are stored in the note (NoteMeta.forms) and the canvas draws them into the page.
 */

type Arm = 'text' | 'check' | 'cross' | 'date' | 'initials' | 'signature';
type Rect = { minX: number; minY: number; maxX: number; maxY: number };

/** Form info per PDF asset, read once per note with pdf.js (shared with page rendering). */
export function useFormInfo(vault: AppVault | null, doc: NoteDocument | null): Map<string, PdfFormInfo> {
  const assets = doc ? pdfAssetsOf(doc.pages) : [];
  const key = doc ? `${doc.meta.id}:${assets.join(',')}` : '';
  const [infos, setInfos] = useState<Map<string, PdfFormInfo>>(new Map());
  useEffect(() => {
    if (!vault || !doc || !assets.length) { setInfos(new Map()); return; }
    let alive = true;
    void (async () => {
      const out = new Map<string, PdfFormInfo>();
      for (const a of assets) {
        try {
          out.set(a, await readPdfFormFromDoc(await vault.assets.pdfDocument(doc.meta.id, a)));
        } catch (e) {
          console.warn('Could not read form fields', e);
        }
      }
      if (alive) setInfos(out);
    })();
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return infos;
}

export function noteHasPdf(doc: NoteDocument | null): boolean {
  return !!doc && doc.pages.some((p) => p.background?.kind === 'pdf');
}

const fieldCount = (infos: Map<string, PdfFormInfo>) => [...infos.values()].reduce((n, i) => n + i.fields.filter((f) => f.kind !== 'signature').length, 0);

export interface FillLayerProps {
  doc: NoteDocument;
  engine: InkEngine;
  vault: AppVault;
  session: EditorSession;
  host: HTMLElement;
  active: boolean;
  onActive: (on: boolean) => void;
  sel: SelectionInfo | null;
  onTool: (t: Tool) => void;
  onExport: () => void;
  /** Re-render trigger: the editor's viewport state (zoom/scroll). */
  view: unknown;
}

export function FillLayer({ doc, engine, vault, host, active, onActive, sel, onTool, onExport }: FillLayerProps) {
  const { toast } = useApp();
  const infos = useFormInfo(vault, doc);
  const [arm, setArm] = useState<Arm | null>(null);
  const [picker, setPicker] = useState<{ kind: SignatureKind; anchor: HTMLElement | null; target?: { pageIndex: number; rect: Rect } } | null>(null);
  const [armedSig, setArmedSig] = useState<{ sig: SavedSignature; color: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [chipGone, setChipGone] = useState(() => safeStorage.get(`inkstone.fillchip.${doc.meta.id}`) === '1');
  const grays = useRef(new Map<string, Promise<GrayImage | null>>());
  const btns = { sig: useRef<HTMLButtonElement>(null), ini: useRef<HTMLButtonElement>(null) };

  const placed = useMemo(() => {
    const out: (PlacedWidget & { asset: string })[] = [];
    for (const [asset, info] of infos) for (const w of placeWidgets(info, asset, doc.pages)) out.push({ ...w, asset });
    return out.sort((a, b) => a.pageIndex - b.pageIndex || a.rect.minY - b.rect.minY || a.rect.minX - b.rect.minX);
  }, [infos, doc.pages]);

  const count = fieldCount(infos);

  // ---- Values -------------------------------------------------------------------------------------
  const valueOf = (asset: string, f: PdfField) => effectiveValue(f, doc.meta.forms?.[asset]);
  const setValue = useCallback((asset: string, f: PdfField, v: FormFieldValue) => {
    const next = coerce(f, v);
    const cur = doc.meta.forms?.[asset]?.[f.name];
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    doc.updateMeta((m) => withFormValue(m, asset, f.name, next));
  }, [doc]);

  // ---- Handwriting into fields --------------------------------------------------------------------
  // Ink written inside a text field becomes its value once the pen rests, when an on-device
  // recognizer is available; otherwise it simply stays as ink on the page.
  useEffect(() => {
    if (!active) return;
    const seen = new Set(doc.pages.flatMap((p) => p.strokes.map((s) => s.id)));
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const textWidgets = placed.filter((w) => w.field.kind === 'text' && !w.field.readOnly);
    const inside = (s: InkStroke, r: Rect) => {
      const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      return cx >= r.minX && cx <= r.maxX && cy >= r.minY - 6 && cy <= r.maxY + 6;
    };
    const unsub = doc.subscribe(() => {
      doc.pages.forEach((p, pageIndex) => {
        for (const s of p.strokes) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          const w = textWidgets.find((x) => x.pageIndex === pageIndex && inside(s, x.rect));
          if (!w) continue;
          const key = `${w.asset}|${w.field.name}|${pageIndex}`;
          clearTimeout(timers.get(key));
          timers.set(key, setTimeout(() => void recognizeInto(w), 1400));
        }
      });
    });
    const recognizeInto = async (w: PlacedWidget & { asset: string }) => {
      const strokes = doc.page(w.pageIndex).strokes.filter((s) => inside(s, w.rect));
      if (!strokes.length) return;
      const res = await recognizeLocally(strokes).catch(() => null);
      const text = res?.text.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const before = valueOf(w.asset, w.field);
      const prev = typeof before === 'string' ? before : '';
      setValue(w.asset, w.field, clampText(w.field, prev ? `${prev} ${text}` : text));
      doc.deleteStrokes(w.pageIndex, new Set(strokes.map((s) => s.id)), 'Write into field');
      toast({ text: `Wrote “${text}” into ${w.field.label}`, action: { label: 'Keep ink', run: () => { engine.undo(); setValue(w.asset, w.field, prev); } } });
    };
    return () => { unsub(); for (const t of timers.values()) clearTimeout(t); };
  }, [active, placed, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Page pixels for snapping ---------------------------------------------------------------------
  const grayFor = (pageIndex: number): Promise<GrayImage | null> => {
    const bg = doc.page(pageIndex).background;
    if (!bg || bg.kind !== 'pdf') return Promise.resolve(null);
    const key = `${bg.asset}#${bg.pageNumber ?? 1}@${bg.rotation ?? 0}`;
    let p = grays.current.get(key);
    if (!p) {
      p = (async () => {
        try {
          const pdf = await vault.assets.pdfDocument(doc.meta.id, bg.asset);
          const page = await pdf.getPage(bg.pageNumber ?? 1);
          const scale = 1.5;
          const viewport = page.getViewport({ scale: (96 / 72) * scale, rotation: ((page.rotate ?? 0) + (bg.rotation ?? 0)) % 360 });
          const c = document.createElement('canvas');
          c.width = Math.ceil(viewport.width);
          c.height = Math.ceil(viewport.height);
          const ctx = c.getContext('2d', { willReadFrequently: true })!;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, canvas: c, viewport }).promise;
          return grayFromRGBA(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, scale);
        } catch (e) {
          console.warn('Line detection unavailable for this page', e);
          return null;
        }
      })();
      grays.current.set(key, p);
    }
    return p;
  };

  // ---- Placing things -------------------------------------------------------------------------------
  const selectPlaced = (pageIndex: number, sel: { strokes?: string[]; texts?: string[]; images?: string[] }) => {
    onTool('lasso');
    engine.selectItems(pageIndex, sel);
  };

  const addStrokes = (pageIndex: number, strokes: InkStroke[], label: string) => {
    const page = doc.page(pageIndex);
    doc.commit(pageIndex, { label, strokes: { removed: [], added: strokes.map((s, k) => ({ index: page.strokes.length + k, item: s })) } });
    selectPlaced(pageIndex, { strokes: strokes.map((s) => s.id) });
  };

  const placeSignature = async (sig: SavedSignature, color: string, pageIndex: number, at: { x: number; y: number } | { rect: Rect }) => {
    const kind = sig.kind;
    let height = kind === 'initials' ? 30 : 44;
    let x: number, y: number;
    if ('rect' in at) {
      // A signature field: fit inside it, centred.
      const r = at.rect;
      height = Math.min((r.maxY - r.minY) * 0.9, ((r.maxX - r.minX) * 0.95) / sig.aspect);
      x = (r.minX + r.maxX) / 2 - (height * sig.aspect) / 2;
      y = (r.minY + r.maxY) / 2 - height / 2;
    } else {
      const g = await grayFor(pageIndex);
      const size = pageSizeOf(doc.meta, doc.page(pageIndex));
      const pl = placeText(g, at.x, at.y, size.width || 800);
      if (pl.snapped === 'line') {
        // Sit on the printed line, the way a signature does (the tail dips a little below it).
        const lineY = pl.y + 3 + pl.fontSize * 1.02;
        x = pl.x;
        y = lineY - height * 0.82;
      } else if (pl.snapped === 'box') {
        const bh = pl.fontSize * 1.25 / 0.62;
        height = Math.min(height, bh * 0.9);
        x = pl.x;
        y = pl.y + pl.fontSize * 0.625 - height / 2;
      } else {
        x = at.x - (height * sig.aspect) / 2;
        y = at.y - height / 2;
      }
    }
    if (sig.ink) {
      addStrokes(pageIndex, inkForPlacement(sig, x, y, height, color), kind === 'initials' ? 'Add initials' : 'Sign');
      return;
    }
    let bytes: Uint8Array = Uint8Array.from(atob(sig.png!), (c) => c.charCodeAt(0));
    if (color !== FORM_INK) bytes = await recolorPng(bytes, color);
    const asset = `sig-${newId()}.png`;
    await vault.vault.writeAsset(doc.meta.id, asset, bytes);
    const im: ImageItem = { id: newId(), x, y, width: height * sig.aspect, height, asset, rotation: 0, createdAt: Date.now() };
    doc.addImage(pageIndex, im);
    selectPlaced(pageIndex, { images: [im.id] });
  };

  const placeAt = async (kind: Arm, pageIndex: number, pt: { x: number; y: number }) => {
    const g = await grayFor(pageIndex);
    const size = pageSizeOf(doc.meta, doc.page(pageIndex));
    if (kind === 'text' || kind === 'date') {
      const pl = placeText(g, pt.x, pt.y, size.width || 800);
      const box: TextBox = { id: newId(), x: pl.x, y: pl.y, width: kind === 'date' ? Math.min(pl.width, 160) : pl.width, text: kind === 'date' ? formDate() : '', fontSize: pl.fontSize, color: FORM_INK, font: 'sans', createdAt: Date.now() };
      if (kind === 'date') {
        doc.upsertText(pageIndex, box, 'Add date');
        selectPlaced(pageIndex, { texts: [box.id] });
      } else engine.callbacks.onEditText?.({ pageIndex, box, isNew: true });
      return;
    }
    if (kind === 'check' || kind === 'cross') {
      const b = placeMark(g, pt.x, pt.y);
      addStrokes(pageIndex, kind === 'check' ? checkmark(b) : cross(b), kind === 'check' ? 'Add checkmark' : 'Add cross');
      return;
    }
    if (armedSig) await placeSignature(armedSig.sig, armedSig.color, pageIndex, pt);
  };

  /** Page and page-unit point under a screen point (CSS px relative to the canvas). */
  const pageAt = (sx: number, sy: number): { pageIndex: number; x: number; y: number } | null => {
    for (let i = 0; i < doc.pageCount; i++) {
      const size = pageSizeOf(doc.meta, doc.page(i));
      const r = engine.pageRectToScreen(i, { minX: 0, minY: 0, maxX: size.width || 1, maxY: size.height || 1 });
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
        const k = (size.width || 1) / r.w;
        return { pageIndex: i, x: (sx - r.x) * k, y: (sy - r.y) * k };
      }
    }
    return null;
  };

  useEffect(() => {
    if (!arm) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setArm(null); setArmedSig(null); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [arm]);

  useEffect(() => { if (!active) { setArm(null); setArmedSig(null); } }, [active]);

  // ---- Recolouring placed signatures ----------------------------------------------------------------
  const selItems = sel ? engine.getSelectionItems() : null;
  const sigImages = selItems?.images.filter((m) => m.asset.startsWith('sig-')) ?? [];
  const recolor = async (color: string) => {
    if (!selItems) return;
    if (selItems.strokes.length || selItems.texts.length) engine.recolorSelection(color);
    if (!sigImages.length) return;
    const assets = new Map<string, string>();
    for (const m of sigImages) {
      const bytes = await vault.vault.readAsset(doc.meta.id, m.asset);
      if (!bytes) continue;
      const name = `sig-${newId()}.png`;
      await vault.vault.writeAsset(doc.meta.id, name, await recolorPng(bytes, color));
      assets.set(m.id, name);
    }
    const res = doc.transform(selItems.pageIndex, { images: new Set(assets.keys()) }, 'Recolor', { image: (m) => ({ ...m, asset: assets.get(m.id) ?? m.asset }) });
    const after = engine.getSelectionItems();
    engine.selectItems(selItems.pageIndex, { strokes: after?.strokes.map((s) => s.id), texts: after?.texts.map((t) => t.id), images: [...res.images, ...(after?.images.map((m) => m.id) ?? [])] });
  };

  // ---- Render ---------------------------------------------------------------------------------------
  const W = host.clientWidth, H = host.clientHeight;
  const box = { left: host.offsetLeft, top: host.offsetTop, width: W, height: H };
  const zoom = engine.zoom;

  const chip = !active && count > 0 && !chipGone && (
    <div className="fill-chip" role="status">
      <span>This PDF has {count} {count === 1 ? 'field' : 'fields'} to fill in</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => onActive(true)}>Fill in</button>
      <IconButton label="Dismiss" onClick={() => { setChipGone(true); safeStorage.set(`inkstone.fillchip.${doc.meta.id}`, '1'); }}><X size={15} /></IconButton>
    </div>
  );

  if (!active) return chip || null;

  const tools: { id: Arm; label: string; icon: React.ReactNode; ref?: React.RefObject<HTMLButtonElement | null> }[] = [
    { id: 'text', label: 'Text', icon: <Type size={17} /> },
    { id: 'check', label: 'Check', icon: <Check size={17} /> },
    { id: 'cross', label: 'Cross', icon: <X size={17} /> },
    { id: 'date', label: 'Date', icon: <CalendarDays size={17} /> },
    { id: 'initials', label: 'Initials', icon: <PenLine size={17} />, ref: btns.ini },
    { id: 'signature', label: 'Sign', icon: <Signature size={17} />, ref: btns.sig },
  ];

  const missing = [...infos.entries()].flatMap(([a, info]) => missingRequired(info.fields, doc.meta.forms?.[a]));

  return (
    <>
      <div className="fill-bar" role="toolbar" aria-label="Fill and sign">
        {tools.map((t) => (
          <button key={t.id} ref={t.ref} type="button" className={cx('fill-tool', arm === t.id && 'is-on')} aria-pressed={arm === t.id}
            onClick={() => {
              if (arm === t.id) { setArm(null); setArmedSig(null); return; }
              if (t.id === 'signature' || t.id === 'initials') setPicker({ kind: t.id, anchor: t.ref?.current ?? null });
              else { setArmedSig(null); setArm(t.id); }
            }}>
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
        <span className="fill-sep" aria-hidden />
        {(sigImages.length > 0 || (sel && (sel.strokes > 0 || sel.texts > 0))) && SIGN_COLORS.map((c) => (
          <button key={c.color} type="button" className="sig-color fill-color" aria-label={`Make it ${c.label.toLowerCase()}`} title={`Make it ${c.label.toLowerCase()}`} style={{ background: `#${c.color.slice(3)}` }} onClick={() => void recolor(c.color)} />
        ))}
        <button type="button" className="fill-tool" onClick={onExport} title={missing.length ? `${missing.length} required ${missing.length === 1 ? 'field is' : 'fields are'} empty` : undefined}>
          <FileDown size={17} /><span>Export</span>
        </button>
        <button type="button" className="fill-tool is-done" onClick={() => onActive(false)}><span>Done</span></button>
      </div>
      {arm && <div className="fill-hint" role="status">{arm === 'text' ? 'Tap where the text goes' : arm === 'date' ? 'Tap where the date goes' : arm === 'check' ? 'Tap a box to check it' : arm === 'cross' ? 'Tap a box to cross it' : 'Tap where to sign'}</div>}
      <div className="fill-layer" style={box} aria-label="Form fields">
        {placed.map((w) => {
          const r = engine.pageRectToScreen(w.pageIndex, w.rect);
          if (r.x > W + 40 || r.y > H + 40 || r.x + r.w < -40 || r.y + r.h < -40) return null;
          const key = `${w.asset}|${w.field.name}|${w.widget.id}|${w.pageIndex}`;
          return (
            <FieldView key={key} w={w} rect={r} zoom={zoom} value={valueOf(w.asset, w.field)} draft={drafts[key]} host={host}
              onDraft={(t) => setDrafts((d) => ({ ...d, [key]: t }))}
              onCommit={(v) => { setDrafts((d) => { const { [key]: _, ...rest } = d; return rest; }); setValue(w.asset, w.field, v); }}
              onSign={(el) => setPicker({ kind: 'signature', anchor: el, target: { pageIndex: w.pageIndex, rect: w.rect } })} />
          );
        })}
        {arm && (arm !== 'signature' && arm !== 'initials' || armedSig) && (
          <div className="fill-catcher" aria-label="Tap to place"
            onPointerDown={(e) => {
              e.preventDefault();
              const hr = host.getBoundingClientRect();
              const hit = pageAt(e.clientX - hr.left, e.clientY - hr.top);
              if (!hit) return;
              const kind = arm;
              setArm(null);
              void placeAt(kind, hit.pageIndex, hit).finally(() => setArmedSig(null));
            }} />
        )}
      </div>
      {picker && (
        <SignaturePicker anchor={picker.anchor} open kind={picker.kind} onClose={() => setPicker(null)}
          onPick={(sig, color) => {
            const target = picker.target;
            setPicker(null);
            if (target) void placeSignature(sig, color, target.pageIndex, { rect: target.rect });
            else { setArmedSig({ sig, color }); setArm(sig.kind === 'initials' ? 'initials' : 'signature'); }
          }} />
      )}
    </>
  );
}

/** Re-dispatches a pen contact to the canvas, so writing over a field lays down ink. */
function forwardPen(e: React.PointerEvent, host: HTMLElement): boolean {
  if (e.pointerType !== 'pen') return false;
  const n = e.nativeEvent as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
  e.preventDefault();
  e.stopPropagation();
  host.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: n.pointerId, pointerType: n.pointerType, isPrimary: n.isPrimary, bubbles: true, cancelable: true, composed: true,
    clientX: n.clientX, clientY: n.clientY, screenX: n.screenX, screenY: n.screenY, pressure: n.pressure, tangentialPressure: n.tangentialPressure,
    tiltX: n.tiltX, tiltY: n.tiltY, twist: n.twist, width: n.width, height: n.height, button: n.button, buttons: n.buttons,
    ctrlKey: n.ctrlKey, shiftKey: n.shiftKey, altKey: n.altKey, metaKey: n.metaKey,
    ...(n.altitudeAngle != null ? { altitudeAngle: n.altitudeAngle, azimuthAngle: n.azimuthAngle } : {}),
  } as PointerEventInit));
  return true;
}

function FieldView({ w, rect, zoom, value, draft, host, onDraft, onCommit, onSign }: {
  w: PlacedWidget; rect: { x: number; y: number; w: number; h: number }; zoom: number; value: FormFieldValue; draft: string | undefined; host: HTMLElement;
  onDraft: (t: string) => void; onCommit: (v: FormFieldValue) => void; onSign: (el: HTMLElement) => void;
}) {
  const f = w.field;
  const units = w.rect.maxY - w.rect.minY;
  // The field's own font size (points → page units), else fit the box like viewers do.
  const fontUnits = f.fontSize > 0 ? f.fontSize * (96 / 72) : f.multiline ? 16 : Math.max(8, Math.min(16, units * 0.68));
  const fontPx = fontUnits * zoom;
  const style: React.CSSProperties = { left: rect.x, top: rect.y, width: rect.w, height: rect.h, fontSize: fontPx, textAlign: f.align };
  const common = { 'data-field': f.name, 'aria-label': f.label, title: f.label + (f.required ? ' (required)' : '') };
  const onPointerDown = (e: React.PointerEvent) => { forwardPen(e, host); };
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);

  if (f.kind === 'text') {
    const text = draft ?? (typeof value === 'string' ? value : '');
    if (f.comb && f.maxLen > 0) {
      const cell = rect.w / f.maxLen;
      const ch = fontPx * 0.6;
      Object.assign(style, { fontFamily: 'var(--font-mono)', letterSpacing: Math.max(0, cell - ch), paddingLeft: Math.max(0, (cell - ch) / 2), textAlign: 'left' });
    }
    const props = {
      ...common,
      className: cx('fill-field', 'is-text', f.readOnly && 'is-readonly', f.required && 'is-required', f.comb && 'is-comb'),
      style,
      value: text,
      readOnly: f.readOnly,
      required: f.required,
      'aria-required': f.required || undefined,
      maxLength: f.maxLen || undefined,
      onPointerDown,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const t = clampText(f, e.target.value);
        onDraft(t);
        // Saved as you type (debounced), so nothing is lost if the app closes mid-field.
        if (commitTimer.current) clearTimeout(commitTimer.current);
        commitTimer.current = setTimeout(() => onCommit(t), 700);
      },
      onBlur: () => { if (commitTimer.current) clearTimeout(commitTimer.current); if (draft !== undefined) onCommit(draft); },
    };
    return f.multiline ? <textarea {...props} /> : <input type={f.password ? 'password' : 'text'} {...props} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); }} />;
  }
  if (f.kind === 'checkbox' || f.kind === 'radio') {
    const on = f.kind === 'checkbox' ? value === true : value !== 'Off' && value === w.widget.onValue;
    return (
      <button type="button" role={f.kind} aria-checked={on} disabled={f.readOnly} {...common}
        aria-label={f.kind === 'radio' ? `${f.label}: ${w.widget.onValue}` : f.label}
        className={cx('fill-field', 'is-toggle', f.kind === 'radio' && 'is-radio', on && 'is-on')} style={style}
        onPointerDown={onPointerDown}
        onClick={() => onCommit(f.kind === 'checkbox' ? !on : on ? 'Off' : (w.widget.onValue ?? 'Off'))}>
        {on && (f.kind === 'checkbox'
          ? <svg viewBox="0 0 20 20" aria-hidden><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          : <span className="fill-dot" aria-hidden />)}
      </button>
    );
  }
  if (f.kind === 'choice') {
    if (f.multiSelect || !f.combo) {
      const list = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      return (
        <select multiple={f.multiSelect} size={Math.max(2, f.options.length)} {...common} className={cx('fill-field', 'is-list')} style={{ ...style, fontSize: Math.min(fontPx, rect.h / Math.max(2, f.options.length) * 0.8) }}
          disabled={f.readOnly} value={f.multiSelect ? list : (list[0] ?? '')} onPointerDown={onPointerDown}
          onChange={(e) => onCommit(f.multiSelect ? [...e.target.selectedOptions].map((o) => o.value) : e.target.value)}>
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    return (
      <select {...common} className={cx('fill-field', 'is-select')} style={style} disabled={f.readOnly} value={typeof value === 'string' ? value : ''}
        onPointerDown={onPointerDown} onChange={(e) => onCommit(e.target.value)}>
        <option value="">{''}</option>
        {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  // Signature field: tap to sign into it.
  return (
    <button type="button" {...common} className="fill-field is-sign" style={style} onPointerDown={onPointerDown} onClick={(e) => onSign(e.currentTarget)}>
      <Signature size={Math.min(18, rect.h * 0.6)} aria-hidden /> <span>Sign here</span>
    </button>
  );
}

/** "Export filled PDF": the original PDF with the form filled in, ink on top, optionally flattened. */
export function FilledExportDialog({ open, onClose, doc, vault, session }: { open: boolean; onClose: () => void; doc: NoteDocument; vault: AppVault; session: EditorSession }) {
  const { toast } = useApp();
  const infos = useFormInfo(vault, open ? doc : null);
  const [flatten, setFlatten] = useState(false);
  const [busy, setBusy] = useState(false);
  const missing = [...infos.entries()].flatMap(([a, info]) => missingRequired(info.fields, doc.meta.forms?.[a]));
  const run = async () => {
    setBusy(true);
    try {
      await session.flush();
      // pdf-lib loads on demand: it's large and only needed here.
      const { exportFilledPdf } = await import('./exportFilled.ts');
      const { bytes, report } = await exportFilledPdf(doc.meta, [...doc.pages], (name) => vault.vault.readAsset(doc.meta.id, name), { flatten });
      const name = `${(doc.meta.title.trim() || 'Document').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}.pdf`;
      const saved = await saveDocument(name, bytes, 'application/pdf', '.pdf');
      onClose();
      if (saved) toast({ text: report.skipped.length ? `Saved ${name}. ${report.skipped.length} field ${report.skipped.length === 1 ? 'value' : 'values'} didn't fit the form.` : `Saved ${name}`, tone: report.skipped.length ? 'info' : 'success' });
    } catch (e) {
      console.error(e);
      toast({ text: `Export failed: ${(e as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} title="Export filled PDF" onClose={onClose}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run()}>{busy ? 'Exporting…' : 'Export PDF'}</button>
      </>}>
      <p>Your original PDF with the fields filled in and your ink, text and signatures on top.</p>
      <Switch checked={flatten} onChange={setFlatten} label="Lock the answers" hint="Flattens the form, so the values become part of the page and can't be changed." />
      {missing.length > 0 && <p className="fill-missing">Still empty: {missing.slice(0, 4).map((f) => f.label).join(', ')}{missing.length > 4 ? ` and ${missing.length - 4} more` : ''}.</p>}
    </Dialog>
  );
}
