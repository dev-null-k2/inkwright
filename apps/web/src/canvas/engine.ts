import {
  erasePrecisely,
  hitStrokes,
  lassoSelect,
  newId,
  pagePaper,
  recognizeShape,
  scaleStroke,
  shapeToStroke,
  strokeOutline,
  outlineToSvgPath,
  centerlineSvgPath,
  translateStroke,
  argbToCss,
  nominalWidth,
  penLook,
  type AddResult,
  type ImageItem,
  type InkPoint,
  type InkStroke,
  type NoteDocument,
  type PageInk,
  type PenType,
  type Rect,
  type TextBox,
  type Vec2,
} from '@inkstone/core';
import { AssetCache, type AssetLoader } from './assets.ts';
import { drawPageObjectsFor } from '../smart/render.ts';
import { PAGE_GAP, Viewport, layoutPages, nearestSlot, slotAt, type DocLayout, type PageSlot } from './layout.ts';
import {
  cachedBounds,
  drawImageItem,
  drawPaper,
  drawStroke,
  drawStrokes,
  drawTextBox,
  imageRect,
  paperColorFor,
  textBoxRect,
  type DrawContext,
} from './render.ts';

export type Tool = 'pen' | 'eraser' | 'lasso' | 'text' | 'hand' | 'laser';
export type ButtonAction = 'eraser' | 'precise' | 'lasso' | 'highlighter' | 'none';

export interface PenPreset {
  id: string;
  pen: PenType;
  color: string;
  size: number;
}

export interface ToolState {
  tool: Tool;
  preset: PenPreset;
  eraserMode: 'stroke' | 'precise';
  /** Eraser diameter in screen px. */
  eraserSize: number;
}

export interface InputPrefs {
  fingerAction: 'scroll' | 'draw' | 'erase';
  buttonAction: ButtonAction;
  scratchToErase: boolean;
  holdToShape: boolean;
  tapGestures: boolean;
  /** Pressure response exponent: <1 softer pen, >1 firmer. */
  pressureCurve: number;
  /** Android: draw the newest part of each pen stroke natively, straight to the screen. */
  instantInk: boolean;
  highlighter: PenPreset;
}

/**
 * Native "instant ink tip" (Android app): while a pen stroke is down, native draws the newest few
 * milliseconds of it on a front-buffered overlay, directly from the stylus, so the ink keeps up
 * with the nib even though the WebView presents a frame or two later. Only for opaque pens: the
 * tip overlaps the web ink for a moment.
 */
export interface InkTipSink {
  begin(opts: { color: string; widthPx: number }): void;
  /** Stroke over. Cancelled (discarded, or snapped to a shape): clear at once; otherwise the tip lingers until the web ink is on screen. */
  end(cancelled?: boolean): void;
}

export type PointerKind = 'pen' | 'touch' | 'mouse';

export interface FeelSink {
  /** A stroke or erase starts: pen kind, input device and pen-down pressure (0..1, <0 unknown). */
  begin(kind: PenType | 'eraser', pointer?: PointerKind, pressure?: number): void;
  sample(x: number, y: number, t: number, pressure: number): void;
  end(): void;
  confirm(): void;
}

export interface SelectionInfo {
  pageIndex: number;
  count: number;
  strokes: number;
  texts: number;
  images: number;
  /** Selection bounds on screen (CSS px relative to the canvas). */
  screen: { x: number; y: number; w: number; h: number };
}

export interface EngineCallbacks {
  onViewport?(info: { zoom: number; pageIndex: number; pageCount: number }): void;
  onSelection?(sel: SelectionInfo | null): void;
  onCommitted?(pageIndex: number, result: AddResult | { kind: 'erased' | 'changed' }): void;
  onEditText?(req: { pageIndex: number; box: TextBox; isNew: boolean }): void;
  onButtonToggle?(): void;
  onSeek?(createdAt: number): void;
  onInteraction?(kind: 'pen' | 'touch' | 'mouse'): void;
  /** Ink is being laid down (true) or the stroke has ended (false): lets the chrome step back. */
  onWriting?(active: boolean): void;
  onViewportSaved?(v: { zoom: number; panX: number; panY: number }): void;
}

interface Selection {
  pageIndex: number;
  strokes: Set<string>;
  texts: Set<string>;
  images: Set<string>;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'stroke'; pointerId: number; pageIndex: number; slot: PageSlot; points: InkPoint[]; predicted: InkPoint[]; t0: number; wall: number; preset: PenPreset; shape: InkStroke | null; holdX: number; holdY: number; holdTimer: number; lastTs: number; pen: boolean; raw: boolean; input: PointerKind }
  | { kind: 'erase'; pointerId: number; pageIndex: number; slot: PageSlot; before: PageInk; working: PageInk; last: Vec2 | null; precise: boolean; t0: number }
  | { kind: 'lasso'; pointerId: number; pageIndex: number; slot: PageSlot; points: Vec2[] }
  | { kind: 'move'; pointerId: number; startX: number; startY: number; dx: number; dy: number; scale: number; mode: 'move' | 'scale'; anchor: Vec2; startDist: number }
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; vx: number; vy: number; lastT: number }
  | { kind: 'pinch' }
  | { kind: 'laser'; pointerId: number }
  | { kind: 'tap'; pointerId: number; x: number; y: number; t: number; tool: Tool };

const DPR_CAP = 3;
const DESK_FALLBACK = '#e8e5ea';

/**
 * The ink engine: a low-latency, palm-rejecting, pressure-aware canvas. Committed content is
 * drawn on a base canvas (redrawn only when content or view changes); the stroke being written is
 * drawn on a desynchronized "wet" canvas that the compositor can present without waiting for the
 * page — the same front-buffer technique native ink stacks use.
 */
export class InkEngine {
  readonly viewport = new Viewport();
  private base: HTMLCanvasElement;
  private wet: HTMLCanvasElement;
  private overlay: HTMLDivElement;
  private cursor: HTMLDivElement;
  private lassoSvg: SVGSVGElement;
  private bctx: CanvasRenderingContext2D;
  private wctx: CanvasRenderingContext2D;
  private dpr = 1;
  private layout: DocLayout;
  private gesture: Gesture = { kind: 'none' };
  private touches = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  private pinch: { dist: number; mx: number; my: number; zoom: number; panX: number; panY: number } | null = null;
  private tapCandidate: { count: number; start: number; moved: boolean } | null = null;
  private lastPenTime = -1e9;
  private penIsDown = false;
  private selection: Selection | null = null;
  private needsBase = true;
  private needsWet = false;
  private raf = 0;
  private resizeObs: ResizeObserver;
  private assets: AssetCache;
  private laserTrail: { x: number; y: number; t: number }[] = [];
  private flingRaf = 0;
  private externalButton = false;
  private hoverButton: { down: number; used: boolean } | null = null;
  private stickyButtonTool = false;
  private editingTextId: string | null = null;
  private playback: { start: number; position: number } | null = null;
  private unsubDoc: () => void;
  private fitted = false;
  private destroyed = false;
  private wetDirtyRect: { x: number; y: number; w: number; h: number } | null = null;

  tool: ToolState;
  prefs: InputPrefs;
  feel: FeelSink | null = null;
  inkTip: InkTipSink | null = null;
  callbacks: EngineCallbacks = {};

  constructor(
    private container: HTMLElement,
    private doc: NoteDocument,
    opts: { tool: ToolState; prefs: InputPrefs; loadAsset: AssetLoader; initialViewport?: { zoom: number; panX: number; panY: number } },
  ) {
    this.tool = opts.tool;
    this.prefs = opts.prefs;
    this.assets = new AssetCache(opts.loadAsset, () => this.bumpScene());
    container.classList.add('ink-surface');
    this.base = el('canvas', 'ink-base') as HTMLCanvasElement;
    this.wet = el('canvas', 'ink-wet') as HTMLCanvasElement;
    this.overlay = el('div', 'ink-overlay') as HTMLDivElement;
    this.cursor = el('div', 'ink-cursor') as HTMLDivElement;
    this.lassoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.lassoSvg.classList.add('ink-lasso');
    this.overlay.append(this.lassoSvg, this.cursor);
    container.append(this.base, this.wet, this.overlay);
    this.bctx = this.base.getContext('2d', { alpha: false })!;
    // Desynchronized: low-latency presentation path for the wet ink layer.
    this.wctx = (this.wet.getContext('2d', { desynchronized: true, alpha: true }) as CanvasRenderingContext2D | null) ?? this.wet.getContext('2d')!;
    this.layout = layoutPages(doc.meta, doc.pages);
    if (opts.initialViewport) {
      Object.assign(this.viewport, opts.initialViewport);
      this.fitted = true;
    }
    this.unsubDoc = doc.subscribe(() => this.onDocChanged());
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.bind();
    this.resize();
  }

  // ---- Public API ---------------------------------------------------------------------------

  setTool(t: ToolState) {
    const changedTool = t.tool !== this.tool.tool;
    this.tool = t;
    if (changedTool && t.tool !== 'lasso') this.clearSelection();
    this.updateCursorStyle();
  }

  setPrefs(p: InputPrefs) { this.prefs = p; }

  setExternalButton(pressed: boolean) {
    // Bluetooth/keycode stylus buttons (e.g. Moto Pen Ultra): hold = temporary, tap = toggle.
    if (pressed && !this.externalButton) this.hoverButton = { down: performance.now(), used: false };
    if (!pressed && this.externalButton) this.endButtonPress();
    this.externalButton = pressed;
  }

  /** Whether the stylus-button tool is latched on by a tap of the button. */
  get buttonLatched() { return this.stickyButtonTool; }
  setButtonLatched(on: boolean) { this.stickyButtonTool = on; this.updateCursorStyle(); }

  setEditingText(id: string | null) {
    this.editingTextId = id;
    this.bumpScene();
  }

  setPlayback(p: { start: number; position: number } | null) {
    this.playback = p;
    this.bumpScene();
  }

  undo() { const i = this.doc.undo(); this.afterHistory(i); }
  redo() { const i = this.doc.redo(); this.afterHistory(i); }

  zoomBy(factor: number) {
    this.viewport.zoomAt(factor, this.viewport.width / 2, this.viewport.height / 2);
    this.clampView();
    this.invalidate();
  }

  fitWidth() {
    const vw = this.viewport.width;
    if (!vw) return;
    if (this.layout.infinite) {
      this.viewport.zoom = 1;
      this.viewport.panX = 40;
      this.viewport.panY = 40;
    } else {
      const margin = vw < 600 ? 10 : 48;
      // Phones/foldables fill the width; big screens stop near physical size so a page isn't huge.
      const z = Math.min(vw >= 1000 ? 1.25 : 2.2, (vw - margin * 2) / this.layout.width);
      const cur = nearestSlot(this.layout, this.viewport.toDoc(0, this.viewport.height / 3).y);
      this.viewport.zoom = z;
      this.viewport.panX = (vw - this.layout.width * z) / 2;
      this.viewport.panY = this.fitted ? -cur.y * z + 16 : 16;
    }
    this.fitted = true;
    this.clampView();
    this.invalidate();
  }

  scrollToPage(index: number) {
    const s = this.layout.slots[index];
    if (!s || this.layout.infinite) return;
    this.viewport.panY = -s.y * this.viewport.zoom + 16;
    this.clampView();
    this.invalidate();
  }

  get currentPageIndex(): number {
    if (this.layout.infinite) return 0;
    const c = this.viewport.toDoc(this.viewport.width / 2, this.viewport.height / 3);
    return nearestSlot(this.layout, c.y).index;
  }

  /** Centre of the visible area of the current page, in page coordinates. */
  visibleCenter(pageIndex = this.currentPageIndex): Vec2 {
    const slot = this.layout.slots[pageIndex] ?? this.layout.slots[0]!;
    const c = this.viewport.toDoc(this.viewport.width / 2, this.viewport.height / 2);
    return { x: c.x - (slot.infinite ? 0 : slot.x), y: c.y - (slot.infinite ? 0 : slot.y) };
  }

  /** Screen rectangle (CSS px) of a page-space rectangle. */
  pageRectToScreen(pageIndex: number, r: Rect) {
    const slot = this.layout.slots[pageIndex] ?? this.layout.slots[0]!;
    const ox = slot.infinite ? 0 : slot.x, oy = slot.infinite ? 0 : slot.y;
    const a = this.viewport.toScreen(r.minX + ox, r.minY + oy);
    const b = this.viewport.toScreen(r.maxX + ox, r.maxY + oy);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  get zoom() { return this.viewport.zoom; }

  hasSelection() { return !!this.selection; }

  selectAll() {
    const i = this.currentPageIndex;
    const p = this.doc.page(i);
    this.setSelection({ pageIndex: i, strokes: new Set(p.strokes.map((s) => s.id)), texts: new Set((p.texts ?? []).map((t) => t.id)), images: new Set((p.images ?? []).map((m) => m.id)) });
  }

  selectItems(pageIndex: number, sel: { strokes?: Iterable<string>; texts?: Iterable<string>; images?: Iterable<string> }) {
    this.setSelection({ pageIndex, strokes: new Set(sel.strokes ?? []), texts: new Set(sel.texts ?? []), images: new Set(sel.images ?? []) });
  }

  getSelectionItems(): { pageIndex: number; strokes: InkStroke[]; texts: TextBox[]; images: ImageItem[] } | null {
    if (!this.selection) return null;
    const p = this.doc.page(this.selection.pageIndex);
    return {
      pageIndex: this.selection.pageIndex,
      strokes: p.strokes.filter((s) => this.selection!.strokes.has(s.id)),
      texts: (p.texts ?? []).filter((t) => this.selection!.texts.has(t.id)),
      images: (p.images ?? []).filter((m) => this.selection!.images.has(m.id)),
    };
  }

  deleteSelection() {
    if (!this.selection) return;
    this.doc.deleteItems(this.selection.pageIndex, this.selection);
    this.clearSelection();
  }

  recolorSelection(color: string) {
    const s = this.selection;
    if (!s) return;
    const res = this.doc.transform(s.pageIndex, { strokes: s.strokes, texts: s.texts }, 'Recolor', {
      stroke: (x) => ({ ...x, color }),
      text: (t) => ({ ...t, color }),
    });
    this.setSelection({ pageIndex: s.pageIndex, strokes: res.strokes, texts: res.texts, images: s.images });
  }

  duplicateSelection() {
    const items = this.getSelectionItems();
    if (!items) return;
    const off = 24;
    const res = this.doc.paste(items.pageIndex, {
      strokes: items.strokes.map((s) => translateStroke(s, off, off)),
      texts: items.texts.map((t) => ({ ...t, x: t.x + off, y: t.y + off })),
      images: items.images.map((m) => ({ ...m, x: m.x + off, y: m.y + off })),
    }, 'Duplicate');
    this.setSelection({ pageIndex: items.pageIndex, ...res });
  }

  /** Pastes items centred in view on the current page and selects them. */
  pasteItems(items: { strokes: InkStroke[]; texts: TextBox[]; images: ImageItem[] }) {
    const i = this.currentPageIndex;
    const b = itemsBounds(this.bctx, items);
    const c = this.visibleCenter(i);
    const dx = c.x - (b.minX + b.maxX) / 2, dy = c.y - (b.minY + b.maxY) / 2;
    const res = this.doc.paste(i, {
      strokes: items.strokes.map((s) => translateStroke(s, dx, dy)),
      texts: items.texts.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy })),
      images: items.images.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy })),
    });
    this.setSelection({ pageIndex: i, ...res });
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.callbacks.onSelection?.(null);
    this.bumpScene();
  }

  invalidate() {
    this.needsBase = true;
    this.schedule();
  }

  /** Renders one page (paper, background, ink, text) into a canvas for export and thumbnails. */
  async renderPageToCanvas(pageIndex: number, scale: number, opts: { paper?: boolean } = {}): Promise<HTMLCanvasElement> {
    return renderPageStandalone(this.doc, pageIndex, scale, this.assets, opts);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.flingRaf);
    this.resizeObs.disconnect();
    this.unsubDoc();
    this.unbind();
    this.assets.clear();
    this.base.remove();
    this.wet.remove();
    this.overlay.remove();
  }

  // ---- Layout & rendering ---------------------------------------------------------------------

  private onDocChanged() {
    this.layout = layoutPages(this.doc.meta, this.doc.pages);
    if (this.selection) {
      // Drop ids that no longer exist (undo, erase).
      const p = this.doc.pages[this.selection.pageIndex];
      if (!p) this.clearSelection();
      else {
        const has = (set: Set<string>, list: { id: string }[]) => new Set([...set].filter((id) => list.some((x) => x.id === id)));
        this.selection = { pageIndex: this.selection.pageIndex, strokes: has(this.selection.strokes, p.strokes), texts: has(this.selection.texts, p.texts ?? []), images: has(this.selection.images, p.images ?? []) };
        if (!this.selection.strokes.size && !this.selection.texts.size && !this.selection.images.size) this.clearSelection();
        else this.emitSelection();
      }
    }
    this.invalidate();
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    for (const c of [this.base, this.wet]) {
      c.width = Math.round(r.width * this.dpr);
      c.height = Math.round(r.height * this.dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
    }
    const oldW = this.viewport.width;
    this.viewport.width = r.width;
    this.viewport.height = r.height;
    if (!this.fitted) this.fitWidth();
    else if (oldW && Math.abs(oldW - r.width) > 1 && !this.layout.infinite) {
      // Fold/unfold or rotation: keep the same content width ratio.
      this.viewport.zoomAt(r.width / oldW, 0, 0);
      this.clampView();
    }
    this.needsBase = true;
    this.renderNow();
  }

  private schedule() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderNow();
    });
  }

  private renderNow() {
    if (this.needsBase) {
      this.needsBase = false;
      this.renderBase();
      this.updateSelectionOverlay();
      this.emitViewport();
    }
    if (this.needsWet) {
      this.needsWet = false;
      this.renderWet();
      this.lastWetAt = performance.now();
    }
  }

  private deskColor() {
    return getComputedStyle(this.container).getPropertyValue('--desk').trim() || DESK_FALLBACK;
  }

  // ---- Scene buffer -------------------------------------------------------------------------------
  // Committed content is rendered once into an offscreen buffer a little larger than the view.
  // Panning blits it; pinching stretches it until the zoom settles; a new stroke is drawn into it
  // incrementally. Only content, selection or zoom changes trigger a full redraw.
  private buffer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; rect: Rect; scale: number; key: string } | null = null;
  private sceneVersion = 0;
  private prevScale = 0;
  private lastZoomAt = 0;
  private settleTimer = 0;

  private sceneKey() {
    return `${this.doc.version}|${this.sceneVersion}|${this.gesture.kind === 'move' ? 'mv' : ''}`;
  }

  private bumpScene() {
    this.sceneVersion++;
    this.invalidate();
  }

  private renderBase() {
    const v = this.viewport;
    const scale = this.dpr * v.zoom;
    const vis = v.visible();
    const now = performance.now();
    if (scale !== this.prevScale) { this.prevScale = scale; this.lastZoomAt = now; }
    const b = this.buffer;
    const key = this.sceneKey();
    const fresh = !!b && b.key === key && Math.abs(b.scale - scale) / scale < 1e-3 &&
      b.rect.minX <= vis.minX && b.rect.minY <= vis.minY && b.rect.maxX >= vis.maxX && b.rect.maxY >= vis.maxY;
    if (!fresh) {
      const zooming = !!b && b.key === key && (this.gesture.kind === 'pinch' || now - this.lastZoomAt < 150);
      if (zooming) {
        clearTimeout(this.settleTimer);
        this.settleTimer = window.setTimeout(() => { this.lastZoomAt = 0; this.invalidate(); }, 170);
      } else this.renderBuffer(vis, scale, key);
    }
    this.blit();
    if (this.gesture.kind === 'move') this.drawMovingOverlay(this.gesture);
  }

  private renderBuffer(vis: Rect, scale: number, key: string) {
    const w = vis.maxX - vis.minX, h = vis.maxY - vis.minY;
    const MAX_PX = 14e6;
    let m = 0.35;
    while (m > 0 && w * (1 + 2 * m) * scale * h * (1 + 2 * m) * scale > MAX_PX) m -= 0.05;
    m = Math.max(0, m);
    const rect: Rect = { minX: vis.minX - w * m, minY: vis.minY - h * m, maxX: vis.maxX + w * m, maxY: vis.maxY + h * m };
    const pw = Math.max(1, Math.ceil((rect.maxX - rect.minX) * scale));
    const ph = Math.max(1, Math.ceil((rect.maxY - rect.minY) * scale));
    let b = this.buffer;
    if (!b) {
      const canvas = document.createElement('canvas');
      b = this.buffer = { canvas, ctx: canvas.getContext('2d', { alpha: false })!, rect, scale, key };
    }
    if (b.canvas.width !== pw || b.canvas.height !== ph) { b.canvas.width = pw; b.canvas.height = ph; }
    b.rect = rect;
    b.scale = scale;
    b.key = key;
    this.drawScene(b.ctx, scale, -rect.minX * scale, -rect.minY * scale, rect, pw, ph);
  }

  private blit() {
    const ctx = this.bctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.deskColor();
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const b = this.buffer;
    if (!b) return;
    const v = this.viewport;
    const k = (this.dpr * v.zoom) / b.scale;
    const dx = (b.rect.minX * v.zoom + v.panX) * this.dpr;
    const dy = (b.rect.minY * v.zoom + v.panY) * this.dpr;
    ctx.imageSmoothingEnabled = k !== 1;
    ctx.drawImage(b.canvas, Math.round(dx), Math.round(dy), b.canvas.width * k, b.canvas.height * k);
  }

  /** Draws pages and their content; doc point (x, y) lands at device pixel (x*scale+offX, y*scale+offY). */
  private drawScene(ctx: CanvasRenderingContext2D, scale: number, offX: number, offY: number, vis: Rect, pw: number, ph: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.deskColor();
    ctx.fillRect(0, 0, pw, ph);
    const moving = this.gesture.kind === 'move' ? this.gesture : null;
    for (const slot of this.layout.slots) {
      if (!slot.infinite && (slot.y > vis.maxY || slot.y + slot.h < vis.minY || slot.x > vis.maxX || slot.x + slot.w < vis.minX)) continue;
      const page = this.doc.pages[slot.index];
      if (!page) continue;
      const ox = slot.infinite ? 0 : slot.x, oy = slot.infinite ? 0 : slot.y;
      if (!slot.infinite) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.shadowColor = 'rgba(20,30,40,0.28)';
        ctx.shadowBlur = 16 * this.dpr;
        ctx.shadowOffsetY = 5 * this.dpr;
        ctx.fillStyle = '#fff';
        ctx.fillRect(slot.x * scale + offX, slot.y * scale + offY, slot.w * scale, slot.h * scale);
        ctx.restore();
      }
      ctx.setTransform(scale, 0, 0, scale, offX + ox * scale, offY + oy * scale);
      const pageRect: Rect | null = slot.infinite ? null : { minX: 0, minY: 0, maxX: slot.w, maxY: slot.h };
      const region: Rect = { minX: vis.minX - ox, minY: vis.minY - oy, maxX: vis.maxX - ox, maxY: vis.maxY - oy };
      const dc: DrawContext = { ctx, scale, visible: region };
      ctx.save();
      if (pageRect) {
        ctx.beginPath();
        ctx.rect(0, 0, slot.w, slot.h);
        ctx.clip();
      }
      this.drawPageContent(dc, slot.index, page, pageRect, region, moving);
      ctx.restore();
    }
  }

  /** The selection being dragged, drawn live over the blitted scene (no geometry rebuilds). */
  private drawMovingOverlay(g: Extract<Gesture, { kind: 'move' }>) {
    const sel = this.selection;
    if (!sel) return;
    const slot = this.layout.slots[sel.pageIndex];
    const page = this.doc.pages[sel.pageIndex];
    if (!slot || !page) return;
    const v = this.viewport;
    const ctx = this.bctx;
    const scale = this.dpr * v.zoom;
    const ox = slot.infinite ? 0 : slot.x, oy = slot.infinite ? 0 : slot.y;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, this.dpr * (v.panX + ox * v.zoom), this.dpr * (v.panY + oy * v.zoom));
    if (!slot.infinite) { ctx.beginPath(); ctx.rect(0, 0, slot.w, slot.h); ctx.clip(); }
    const a = g.anchor;
    ctx.translate(g.dx, g.dy);
    ctx.translate(a.x, a.y);
    ctx.scale(g.scale, g.scale);
    ctx.translate(-a.x, -a.y);
    const note = this.doc.meta;
    for (const im of page.images ?? []) if (sel.images.has(im.id)) drawImageItem(ctx, im, this.assets.image(note.id, im.asset));
    drawStrokes({ ctx, scale, visible: { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 } }, page.strokes.filter((s) => sel.strokes.has(s.id)), { paperColor: paperColorFor(note, page) });
    for (const t of page.texts ?? []) if (sel.texts.has(t.id)) drawTextBox(ctx, t);
    ctx.restore();
  }

  /** Re-renders only a page-space region of the scene buffer (live erasing on dense pages). */
  private refreshBufferRegion(pageIndex: number, r: Rect, prevKey: string) {
    const b = this.buffer;
    const slot = this.layout.slots[pageIndex];
    if (!b || b.key !== prevKey || !slot) return;
    const ox = slot.infinite ? 0 : slot.x, oy = slot.infinite ? 0 : slot.y;
    const pad = 4;
    const docR: Rect = { minX: r.minX + ox - pad, minY: r.minY + oy - pad, maxX: r.maxX + ox + pad, maxY: r.maxY + oy + pad };
    const x = Math.floor((docR.minX - b.rect.minX) * b.scale), y = Math.floor((docR.minY - b.rect.minY) * b.scale);
    const w = Math.ceil((docR.maxX - docR.minX) * b.scale) + 2, h = Math.ceil((docR.maxY - docR.minY) * b.scale) + 2;
    const ctx = b.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    this.drawScene(ctx, b.scale, -b.rect.minX * b.scale, -b.rect.minY * b.scale, docR, b.canvas.width, b.canvas.height);
    ctx.restore();
    b.key = this.sceneKey();
  }

  /** Draws one just-committed stroke into the scene buffer instead of re-rendering everything. */
  private appendToBuffer(pageIndex: number, stroke: InkStroke, prevKey: string) {
    const b = this.buffer;
    if (!b || b.key !== prevKey || penLook(stroke.pen).underlay) return;
    const slot = this.layout.slots[pageIndex];
    const page = this.doc.pages[pageIndex];
    if (!slot || !page) return;
    const ox = slot.infinite ? 0 : slot.x, oy = slot.infinite ? 0 : slot.y;
    const ctx = b.ctx;
    ctx.save();
    ctx.setTransform(b.scale, 0, 0, b.scale, (ox - b.rect.minX) * b.scale, (oy - b.rect.minY) * b.scale);
    if (!slot.infinite) { ctx.beginPath(); ctx.rect(0, 0, slot.w, slot.h); ctx.clip(); }
    drawStroke(ctx, stroke, { paperColor: paperColorFor(this.doc.meta, page) });
    ctx.restore();
    b.key = this.sceneKey();
  }

  private drawPageContent(dc: DrawContext, index: number, page: PageInk, pageRect: Rect | null, region: Rect, moving: Extract<Gesture, { kind: 'move' }> | null) {
    const { ctx } = dc;
    const note = this.doc.meta;
    const paper = pagePaper(note, page);
    if (page.background && pageRect) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pageRect.maxX, pageRect.maxY);
      const bmp = this.assets.background(note, page.background, dc.scale);
      if (bmp) ctx.drawImage(bmp, 0, 0, pageRect.maxX, pageRect.maxY);
    } else {
      drawPaper(dc, paper, pageRect, region);
    }
    const sel = this.selection && this.selection.pageIndex === index ? this.selection : null;
    const hidden = moving && sel ? sel : null;
    for (const im of page.images ?? []) {
      if (hidden?.images.has(im.id)) continue;
      drawImageItem(ctx, im, this.assets.image(note.id, im.asset));
    }
    drawPageObjectsFor(ctx, note, page);
    const playback = this.playback;
    drawStrokes(dc, page.strokes, {
      paperColor: paperColorFor(note, page),
      hidden: hidden?.strokes,
      selected: sel && !moving ? sel.strokes : undefined,
      alphaFor: playback ? (s) => (s.createdAt >= playback.start && s.createdAt > playback.start + playback.position ? 0.18 : 1) : undefined,
    });
    for (const t of page.texts ?? []) {
      if (hidden?.texts.has(t.id)) continue;
      drawTextBox(ctx, t, { editing: t.id === this.editingTextId, selected: !!sel?.texts.has(t.id) && !moving });
    }
  }

  /** Draws the in-progress stroke (plus prediction), the laser trail, or nothing. */
  private renderWet() {
    const ctx = this.wctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.wetDirtyRect) {
      const r = this.wetDirtyRect;
      ctx.clearRect(r.x, r.y, r.w, r.h);
    } else ctx.clearRect(0, 0, this.wet.width, this.wet.height);
    this.wetDirtyRect = null;
    const g = this.gesture;
    const v = this.viewport;
    if (g.kind === 'stroke') {
      const ox = g.slot.infinite ? 0 : g.slot.x, oy = g.slot.infinite ? 0 : g.slot.y;
      const scale = dpr * v.zoom;
      ctx.setTransform(scale, 0, 0, scale, dpr * (v.panX + ox * v.zoom), dpr * (v.panY + oy * v.zoom));
      const s = g.shape ?? this.wetStroke(g);
      const look = penLook(s.pen);
      const path = new Path2D(look.dashed ? centerlineSvgPath(s.points) : outlineToSvgPath(strokeOutline(s, false)));
      if (look.dashed) {
        ctx.strokeStyle = argbToCss(s.color, look.opacity);
        ctx.lineWidth = s.size;
        ctx.lineCap = 'round';
        ctx.setLineDash([s.size * 3, s.size * 2.2]);
        ctx.stroke(path);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = argbToCss(s.color, look.opacity);
        ctx.fill(path);
      }
      const b = cachedBounds(s);
      const a = v.toScreen(b.minX + ox, b.minY + oy);
      const z = v.toScreen(b.maxX + ox, b.maxY + oy);
      const pad = 8;
      this.wetDirtyRect = { x: Math.floor((a.x - pad) * dpr), y: Math.floor((a.y - pad) * dpr), w: Math.ceil((z.x - a.x + pad * 2) * dpr), h: Math.ceil((z.y - a.y + pad * 2) * dpr) };
    } else if (this.laserTrail.length) {
      const now = performance.now();
      this.laserTrail = this.laserTrail.filter((p) => now - p.t < 650);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < this.laserTrail.length; i++) {
        const a = this.laserTrail[i - 1]!, b = this.laserTrail[i]!;
        const age = (now - b.t) / 650;
        ctx.strokeStyle = `rgba(232,64,52,${(1 - age) * 0.9})`;
        ctx.lineWidth = 6 * (1 - age * 0.6);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const head = this.laserTrail[this.laserTrail.length - 1];
      if (head && this.gesture.kind === 'laser') {
        ctx.fillStyle = 'rgba(255,90,70,0.95)';
        ctx.shadowColor = 'rgba(255,60,40,0.8)';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      if (this.laserTrail.length) { this.needsWet = true; this.schedule(); }
    }
  }

  private wetStroke(g: Extract<Gesture, { kind: 'stroke' }>): InkStroke {
    return { id: 'wet', pen: g.preset.pen, color: g.preset.color, size: g.preset.size, points: g.predicted.length ? g.points.concat(g.predicted) : g.points, createdAt: g.wall };
  }

  private emitViewport() {
    this.callbacks.onViewport?.({ zoom: this.viewport.zoom, pageIndex: this.currentPageIndex, pageCount: this.doc.pageCount });
  }

  private clampView() {
    const v = this.viewport;
    if (this.layout.infinite) return;
    const docW = this.layout.width * v.zoom;
    const docH = this.layout.height * v.zoom;
    if (docW <= v.width) v.panX = (v.width - docW) / 2;
    else v.panX = Math.min(48, Math.max(v.width - docW - 48, v.panX));
    const top = 24, bottom = v.height * 0.5;
    v.panY = Math.min(top, Math.max(v.height - docH - bottom, v.panY));
  }

  private afterHistory(pageIndex: number) {
    this.clearSelection();
    if (pageIndex >= 0 && !this.layout.infinite) {
      const s = this.layout.slots[pageIndex];
      const vis = this.viewport.visible();
      if (s && (s.y > vis.maxY || s.y + s.h < vis.minY)) this.scrollToPage(pageIndex);
    }
    this.callbacks.onCommitted?.(pageIndex, { kind: 'changed' });
  }

  // ---- Selection ------------------------------------------------------------------------------

  private setSelection(s: Selection) {
    if (!s.strokes.size && !s.texts.size && !s.images.size) return this.clearSelection();
    this.selection = s;
    this.emitSelection();
    this.bumpScene();
  }

  private selectionBounds(): Rect | null {
    const s = this.selection;
    if (!s) return null;
    const p = this.doc.page(s.pageIndex);
    return itemsBounds(this.bctx, {
      strokes: p.strokes.filter((x) => s.strokes.has(x.id)),
      texts: (p.texts ?? []).filter((x) => s.texts.has(x.id)),
      images: (p.images ?? []).filter((x) => s.images.has(x.id)),
    });
  }

  private emitSelection() {
    const s = this.selection;
    const b = this.selectionBounds();
    if (!s || !b) return this.callbacks.onSelection?.(null);
    const g = this.gesture.kind === 'move' ? this.gesture : null;
    let r = b;
    if (g) {
      const a = g.anchor;
      r = { minX: a.x + (b.minX - a.x) * g.scale + g.dx, minY: a.y + (b.minY - a.y) * g.scale + g.dy, maxX: a.x + (b.maxX - a.x) * g.scale + g.dx, maxY: a.y + (b.maxY - a.y) * g.scale + g.dy };
    }
    this.callbacks.onSelection?.({ pageIndex: s.pageIndex, count: s.strokes.size + s.texts.size + s.images.size, strokes: s.strokes.size, texts: s.texts.size, images: s.images.size, screen: this.pageRectToScreen(s.pageIndex, r) });
  }

  private updateSelectionOverlay() {
    if (this.selection) this.emitSelection();
  }

  // ---- Input ----------------------------------------------------------------------------------

  private handlers: [string, EventListener, AddEventListenerOptions?][] = [];

  private bind() {
    const on = (type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      const h = fn.bind(this) as EventListener;
      this.container.addEventListener(type, h, opts);
      this.handlers.push([type, h, opts]);
    };
    on('pointerdown', this.onDown, { passive: false });
    on('pointermove', this.onMove, { passive: false });
    // Raw pen samples as the OS delivers them (Chromium/Android WebView with unbuffered dispatch):
    // ink and sound follow the nib without waiting for the next frame's coalesced pointermove.
    if (typeof window !== 'undefined' && 'onpointerrawupdate' in window) on('pointerrawupdate', this.onRawUpdate, { passive: true });
    on('pointerup', this.onUp);
    on('pointercancel', this.onCancel);
    on('pointerleave', this.onLeave);
    on('wheel', this.onWheel, { passive: false });
    on('contextmenu', (e: Event) => e.preventDefault());
    on('gesturestart', (e: Event) => { e.preventDefault(); this.safariScale = 1; });
    on('gesturechange', this.onSafariGesture as (e: any) => void);
    on('touchstart', (e: TouchEvent) => { if (e.touches.length > 1 || this.penIsDown) e.preventDefault(); }, { passive: false });
  }

  private unbind() {
    for (const [t, h, o] of this.handlers) this.container.removeEventListener(t, h, o);
    this.handlers = [];
  }

  private local(e: PointerEvent | { clientX: number; clientY: number }) {
    const r = this.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pagePoint(slot: PageSlot, sx: number, sy: number) {
    const d = this.viewport.toDoc(sx, sy);
    return slot.infinite ? d : { x: d.x - slot.x, y: d.y - slot.y };
  }

  private pressure(e: PointerEvent): number {
    if (e.pointerType !== 'pen') return -1;
    const p = e.pressure;
    if (!(p > 0)) return -1;
    return Math.pow(Math.min(1, p), this.prefs.pressureCurve || 1);
  }

  private tilt(e: PointerEvent): { tilt: number; orient: number } {
    if (e.pointerType !== 'pen') return { tilt: -1, orient: -1 };
    const anyE = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    if (typeof anyE.altitudeAngle === 'number' && typeof anyE.azimuthAngle === 'number' && anyE.altitudeAngle < Math.PI / 2 - 1e-3) {
      return { tilt: Math.max(0, Math.PI / 2 - anyE.altitudeAngle), orient: anyE.azimuthAngle };
    }
    if (e.tiltX || e.tiltY) {
      const tx = Math.tan((e.tiltX * Math.PI) / 180), ty = Math.tan((e.tiltY * Math.PI) / 180);
      let orient = Math.atan2(ty, tx);
      if (orient < 0) orient += Math.PI * 2;
      return { tilt: Math.atan(Math.hypot(tx, ty)), orient };
    }
    return { tilt: -1, orient: -1 };
  }

  private buttonTool(): Tool | 'highlighter' | null {
    switch (this.prefs.buttonAction) {
      case 'eraser': case 'precise': return 'eraser';
      case 'lasso': return 'lasso';
      case 'highlighter': return 'highlighter';
      default: return null;
    }
  }

  /** Tool for a contact, honouring eraser end, barrel button, latch and finger settings. */
  private resolveTool(e: PointerEvent): { tool: Tool; preset: PenPreset; precise: boolean } {
    const t = this.tool;
    const base = { tool: t.tool, preset: t.preset, precise: t.eraserMode === 'precise' };
    if (e.pointerType === 'pen') {
      if ((e.buttons & 32) !== 0 || e.button === 5) return { ...base, tool: 'eraser' };
      const barrel = (e.buttons & 2) !== 0 || this.externalButton || this.stickyButtonTool;
      if (barrel) {
        if (this.hoverButton) this.hoverButton.used = true;
        const bt = this.buttonTool();
        if (bt === 'highlighter') return { ...base, tool: 'pen', preset: this.prefs.highlighter };
        if (bt === 'eraser') return { ...base, tool: 'eraser', precise: this.prefs.buttonAction === 'precise' };
        if (bt) return { ...base, tool: bt };
      }
      return base;
    }
    if (e.pointerType === 'touch') {
      if (this.prefs.fingerAction === 'draw') return base.tool === 'hand' ? base : base;
      if (this.prefs.fingerAction === 'erase') return { ...base, tool: 'eraser' };
      return { ...base, tool: 'hand' };
    }
    // Mouse / trackpad.
    if (e.button === 1) return { ...base, tool: 'hand' };
    return base;
  }

  private onDown(e: PointerEvent) {
    const now = performance.now();
    const p = this.local(e);
    this.callbacks.onInteraction?.(e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse');
    cancelAnimationFrame(this.flingRaf);

    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: p.x, y: p.y, startX: p.x, startY: p.y });
      // Palm rejection first: while the pen is down or was just near the screen, touches do
      // nothing at all — no ink, no pinch, no undo taps. Contacts the OS flags as palms too.
      const penNear = this.penIsDown || now - this.lastPenTime < 1200;
      if (penNear || (e as PointerEvent & { width: number }).width > 60) {
        this.tapCandidate = null;
        return;
      }
      if (this.touches.size === 1) this.tapCandidate = { count: 1, start: now, moved: false };
      else if (this.tapCandidate && now - this.tapCandidate.start < 220) this.tapCandidate.count = this.touches.size;
      if (this.touches.size >= 2) {
        // A second finger turns a just-started finger action into a pinch.
        this.cancelGesture();
        this.startPinch();
        return;
      }
    }
    if (e.pointerType === 'pen') {
      this.lastPenTime = now;
      this.penIsDown = true;
      this.hideCursor();
      // The pen wins: anything a finger or palm started is cancelled (finger ink is discarded).
      if (this.touches.size || this.gesture.kind === 'pan' || this.gesture.kind === 'pinch') {
        this.cancelGesture();
        this.pinch = null;
      }
      this.tapCandidate = null;
    }
    if (this.gesture.kind !== 'none') return;
    if (e.pointerType === 'mouse' && e.button === 2) return;

    try { this.container.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Low-latency input: deliver every pen sample as it arrives (Chrome).
    (this.container as any).requestUnbufferedDispatch?.(e);

    const resolved = this.resolveTool(e);

    // Selection handles take priority.
    if (this.selection && resolved.tool !== 'hand') {
      const hit = this.hitSelection(p.x, p.y);
      if (hit) {
        const b = this.selectionBounds()!;
        const sb = this.pageRectToScreen(this.selection.pageIndex, b);
        const anchor = { x: b.minX, y: b.minY };
        this.gesture = { kind: 'move', pointerId: e.pointerId, startX: p.x, startY: p.y, dx: 0, dy: 0, scale: 1, mode: hit, anchor, startDist: Math.hypot(p.x - sb.x, p.y - sb.y) };
        e.preventDefault();
        return;
      }
      if (resolved.tool !== 'lasso' || true) this.clearSelection();
    }

    const d = this.viewport.toDoc(p.x, p.y);
    const slot = slotAt(this.layout, d.x, d.y);

    switch (resolved.tool) {
      case 'hand':
        this.gesture = { kind: 'pan', pointerId: e.pointerId, lastX: p.x, lastY: p.y, vx: 0, vy: 0, lastT: now };
        this.container.classList.add('is-panning');
        return;
      case 'laser':
        this.gesture = { kind: 'laser', pointerId: e.pointerId };
        this.laserTrail.push({ ...p, t: now });
        this.needsWet = true;
        this.schedule();
        return;
      case 'text':
        this.gesture = { kind: 'tap', pointerId: e.pointerId, x: p.x, y: p.y, t: now, tool: 'text' };
        return;
    }
    if (!slot) {
      // Started in the gap between pages: treat as a pan with a finger/mouse, ignore with a pen.
      if (e.pointerType !== 'pen') this.gesture = { kind: 'pan', pointerId: e.pointerId, lastX: p.x, lastY: p.y, vx: 0, vy: 0, lastT: now };
      return;
    }
    e.preventDefault();
    const pp = this.pagePoint(slot, p.x, p.y);
    if (resolved.tool === 'eraser') {
      const page = this.doc.page(slot.index);
      this.gesture = { kind: 'erase', pointerId: e.pointerId, pageIndex: slot.index, slot, before: page, working: page, last: null, precise: resolved.precise, t0: e.timeStamp };
      this.feel?.begin('eraser', pointerKind(e), this.pressure(e));
      this.eraseTo(pp, e.timeStamp);
      this.showEraserCursor(p.x, p.y);
      return;
    }
    if (resolved.tool === 'lasso') {
      this.gesture = { kind: 'lasso', pointerId: e.pointerId, pageIndex: slot.index, slot, points: [pp] };
      this.drawLasso();
      return;
    }
    // Pen.
    const { tilt, orient } = this.tilt(e);
    const first: InkPoint = { x: pp.x, y: pp.y, t: 0, p: this.pressure(e), tilt, orient };
    this.gesture = {
      kind: 'stroke', pointerId: e.pointerId, pageIndex: slot.index, slot, points: [first], predicted: [], t0: e.timeStamp, wall: Date.now(), preset: resolved.preset,
      shape: null, holdX: p.x, holdY: p.y, holdTimer: 0, lastTs: e.timeStamp, pen: e.pointerType === 'pen', raw: false, input: pointerKind(e),
    };
    this.armHold();
    this.feel?.begin(resolved.preset.pen, pointerKind(e), first.p);
    this.callbacks.onWriting?.(true);
    if (e.pointerType === 'pen' && this.prefs.instantInk && this.inkTip && INSTANT_INK_PENS.has(resolved.preset.pen)) {
      // A touch thinner than the live line so the tip hides under the web ink once it catches up.
      const w = nominalWidth(resolved.preset.pen, resolved.preset.size, first.p) * 0.9;
      this.inkTip.begin({ color: resolved.preset.color, widthPx: w * this.viewport.zoom });
    }
    this.feel?.sample(pp.x, pp.y, 0, first.p);
    this.renderWetSoon();
  }

  private onMove(e: PointerEvent) {
    const p = this.local(e);
    const now = performance.now();
    if (e.pointerType === 'pen') this.lastPenTime = now;

    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      const t = this.touches.get(e.pointerId)!;
      t.x = p.x; t.y = p.y;
      if (this.tapCandidate && Math.hypot(p.x - t.startX, p.y - t.startY) > 12) this.tapCandidate.moved = true;
      if (this.gesture.kind === 'pinch') { this.updatePinch(); return; }
    }

    // Hover: cursor preview and barrel-button taps while hovering.
    if (e.pointerType === 'pen' && e.buttons === 0 && this.gesture.kind === 'none') {
      if (this.hoverButton && !this.externalButton) this.endButtonPress();
      this.showHoverCursor(p.x, p.y);
      return;
    }
    if (e.pointerType === 'pen' && this.gesture.kind === 'none' && (e.buttons & 2) && !this.penIsDown) {
      if (!this.hoverButton) this.hoverButton = { down: now, used: false };
      return;
    }

    const g = this.gesture;
    if (g.kind === 'none' || ('pointerId' in g && g.pointerId !== e.pointerId)) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const samples = events.length ? events : [e];

    switch (g.kind) {
      case 'stroke': {
        if (g.shape) return;
        // With raw updates flowing, they already delivered these samples one by one.
        if (!g.raw) this.appendSamples(g, samples);
        // Prediction hides the remaining pipeline latency; it is redrawn every frame.
        const pred = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
        g.predicted = pred.length ? pred.slice(0, 2).map((pe) => {
          const q = this.local(pe);
          const pp = this.pagePoint(g.slot, q.x, q.y);
          const last = g.points[g.points.length - 1]!;
          return { x: pp.x, y: pp.y, t: last.t + 8, p: last.p, tilt: last.tilt, orient: last.orient };
        }) : extrapolate(g.points, 10, 10 / this.viewport.zoom);
        if (Math.hypot(p.x - g.holdX, p.y - g.holdY) > 4) {
          g.holdX = p.x; g.holdY = p.y;
          this.armHold();
        }
        this.renderWetSoon();
        return;
      }
      case 'erase':
        for (const ce of samples) {
          const q = this.local(ce);
          this.eraseTo(this.pagePoint(g.slot, q.x, q.y), ce.timeStamp);
        }
        this.showEraserCursor(p.x, p.y);
        return;
      case 'lasso':
        for (const ce of samples) {
          const q = this.local(ce);
          g.points.push(this.pagePoint(g.slot, q.x, q.y));
        }
        this.drawLasso();
        return;
      case 'move': {
        if (g.mode === 'move') {
          g.dx = (p.x - g.startX) / this.viewport.zoom;
          g.dy = (p.y - g.startY) / this.viewport.zoom;
        } else {
          const sb = this.pageRectToScreen(this.selection!.pageIndex, this.selectionBounds()!);
          g.scale = Math.max(0.1, Math.min(10, Math.hypot(p.x - sb.x, p.y - sb.y) / Math.max(1, g.startDist)));
        }
        this.invalidate();
        return;
      }
      case 'pan': {
        const dx = p.x - g.lastX, dy = p.y - g.lastY;
        const dt = Math.max(1, now - g.lastT);
        g.vx = g.vx * 0.6 + (dx / dt) * 0.4;
        g.vy = g.vy * 0.6 + (dy / dt) * 0.4;
        g.lastX = p.x; g.lastY = p.y; g.lastT = now;
        this.viewport.panX += this.layout.infinite || this.layout.width * this.viewport.zoom > this.viewport.width ? dx : 0;
        this.viewport.panY += dy;
        this.clampView();
        this.invalidate();
        return;
      }
      case 'laser':
        for (const ce of samples) this.laserTrail.push({ ...this.local(ce), t: ce.timeStamp > 1e12 ? now : performance.now() });
        this.needsWet = true;
        this.schedule();
        return;
      case 'tap':
        if (Math.hypot(p.x - g.x, p.y - g.y) > 10) this.gesture = { kind: 'none' };
        return;
    }
  }

  private onRawUpdate(e: PointerEvent) {
    const g = this.gesture;
    if (g.kind !== 'stroke' || g.pointerId !== e.pointerId || g.shape || !g.pen) return;
    g.raw = true;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    if (this.appendSamples(g, events.length ? events : [e])) {
      g.predicted = [];
      this.renderWetSoon();
    }
  }

  /** Appends pen samples in order, skipping repeats of the same position. */
  private appendSamples(g: Extract<Gesture, { kind: 'stroke' }>, samples: PointerEvent[]): boolean {
    let added = false;
    for (const ce of samples) {
      if (ce.timeStamp < g.lastTs) continue;
      g.lastTs = ce.timeStamp;
      const q = this.local(ce);
      const pp = this.pagePoint(g.slot, q.x, q.y);
      const last = g.points[g.points.length - 1]!;
      if (pp.x === last.x && pp.y === last.y) continue;
      const { tilt, orient } = this.tilt(ce);
      const t = Math.max(last.t, Math.round(ce.timeStamp - g.t0));
      const pt: InkPoint = { x: pp.x, y: pp.y, t, p: this.pressure(ce), tilt, orient };
      g.points.push(pt);
      this.feel?.sample(pp.x, pp.y, t, pt.p);
      added = true;
    }
    return added;
  }

  private lastWetAt = 0;
  private wetCost = 0;

  /**
   * Draws wet ink right away (the wet canvas is desynchronized, so it reaches the screen without
   * waiting for the next frame), throttled by how long a draw takes so long strokes never starve
   * the input thread. Otherwise falls back to the next animation frame.
   */
  private renderWetSoon() {
    const now = performance.now();
    if (now - this.lastWetAt >= Math.max(3, this.wetCost * 1.5)) {
      this.needsWet = false;
      this.renderWet();
      const done = performance.now();
      this.wetCost = this.wetCost * 0.7 + (done - now) * 0.3;
      this.lastWetAt = done;
    } else {
      this.needsWet = true;
      this.schedule();
    }
  }

  private onUp(e: PointerEvent) {
    const now = performance.now();
    if (e.pointerType === 'pen') {
      this.penIsDown = false;
      this.lastPenTime = now;
    }
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size === 0 && this.tapCandidate) {
        const tc = this.tapCandidate;
        this.tapCandidate = null;
        if (this.prefs.tapGestures && !tc.moved && now - tc.start < 320 && tc.count >= 2 && !this.penIsDown) {
          if (tc.count === 2) this.undo(); else this.redo();
          this.cancelGesture();
          return;
        }
      }
      if (this.gesture.kind === 'pinch') {
        if (this.touches.size < 2) { this.gesture = { kind: 'none' }; this.pinch = null; this.saveViewport(); }
        return;
      }
    }
    const g = this.gesture;
    if (g.kind === 'none' || ('pointerId' in g && g.pointerId !== e.pointerId)) return;
    switch (g.kind) {
      case 'stroke': this.finishStroke(g); break;
      case 'erase': this.finishErase(g); break;
      case 'lasso': this.finishLasso(g); break;
      case 'move': this.finishMove(g); break;
      case 'pan': this.finishPan(g); break;
      case 'laser': this.gesture = { kind: 'none' }; this.needsWet = true; this.schedule(); break;
      case 'tap': this.finishTap(g); break;
      default: this.gesture = { kind: 'none' };
    }
    if (e.pointerType === 'pen' && e.pointerType === 'pen') this.showHoverCursorLater();
  }

  private onCancel(e: PointerEvent) {
    if (e.pointerType === 'touch') { this.touches.delete(e.pointerId); this.tapCandidate = null; }
    if (e.pointerType === 'pen') this.penIsDown = false;
    const g = this.gesture;
    if ('pointerId' in g && g.pointerId === e.pointerId) this.cancelGesture();
    if (g.kind === 'pinch' && this.touches.size < 2) { this.gesture = { kind: 'none' }; this.pinch = null; }
  }

  private onLeave(e: PointerEvent) {
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') this.hideCursor();
  }

  private cancelGesture() {
    const g = this.gesture;
    if (g.kind === 'stroke') { clearTimeout(g.holdTimer); this.feel?.end(); this.inkTip?.end(true); this.callbacks.onWriting?.(false); }
    if (g.kind === 'erase') { this.doc.clearPreview(g.pageIndex); this.feel?.end(); }
    if (g.kind === 'lasso') this.lassoSvg.innerHTML = '';
    if (g.kind === 'move') this.invalidate();
    this.container.classList.remove('is-panning');
    this.gesture = { kind: 'none' };
    this.needsWet = true;
    this.schedule();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch (Chrome/Edge/Firefox report it as ctrl+wheel) or ⌘+scroll.
      this.viewport.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), p.x, p.y);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.viewport.panX -= dx * k;
      this.viewport.panY -= dy * k;
    }
    this.clampView();
    this.invalidate();
    this.saveViewportSoon();
  }

  private safariScale = 1;
  private onSafariGesture(e: Event & { scale?: number; clientX?: number; clientY?: number }) {
    e.preventDefault();
    const s = e.scale ?? 1;
    const p = this.local({ clientX: e.clientX ?? 0, clientY: e.clientY ?? 0 });
    this.viewport.zoomAt(s / this.safariScale, p.x, p.y);
    this.safariScale = s;
    this.clampView();
    this.invalidate();
  }

  private startPinch() {
    const pts = [...this.touches.values()];
    if (pts.length < 2) return;
    const a = pts[0]!, b = pts[1]!;
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, zoom: this.viewport.zoom, panX: this.viewport.panX, panY: this.viewport.panY };
    this.gesture = { kind: 'pinch' };
  }

  private updatePinch() {
    const pts = [...this.touches.values()];
    if (pts.length < 2 || !this.pinch) return;
    const a = pts[0]!, b = pts[1]!;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const p0 = this.pinch;
    const z = Math.max(0.15, Math.min(12, p0.zoom * (dist / Math.max(1, p0.dist))));
    // Keep the document point under the initial midpoint under the current midpoint.
    const docX = (p0.mx - p0.panX) / p0.zoom, docY = (p0.my - p0.panY) / p0.zoom;
    this.viewport.zoom = z;
    this.viewport.panX = mx - docX * z;
    this.viewport.panY = my - docY * z;
    if (this.tapCandidate && Math.abs(dist - p0.dist) > 14) this.tapCandidate.moved = true;
    this.clampView();
    this.invalidate();
  }

  // ---- Gesture completion -------------------------------------------------------------------------

  private armHold() {
    const g = this.gesture;
    if (g.kind !== 'stroke' || !this.prefs.holdToShape) return;
    clearTimeout(g.holdTimer);
    g.holdTimer = window.setTimeout(() => {
      if (this.gesture !== g || g.shape) return;
      const shape = recognizeShape(g.points);
      if (!shape) return;
      g.shape = shapeToStroke({ id: 'wet', pen: g.preset.pen, color: g.preset.color, size: g.preset.size, points: g.points, createdAt: g.wall }, shape);
      g.predicted = [];
      this.inkTip?.end(true);
      this.feel?.confirm();
      this.needsWet = true;
      this.schedule();
    }, 480);
  }

  private finishStroke(g: Extract<Gesture, { kind: 'stroke' }>) {
    clearTimeout(g.holdTimer);
    this.feel?.end();
    this.callbacks.onWriting?.(false);
    if (!g.shape) this.inkTip?.end(false);
    this.gesture = { kind: 'none' };
    // `input` records how the stroke was written (authorship certificates count handwriting by it).
    const stroke: InkStroke = g.shape
      ? { ...g.shape, id: newId(), input: g.input }
      : { id: newId(), pen: g.preset.pen, color: g.preset.color, size: g.preset.size, points: g.points, createdAt: g.wall, input: g.input };
    // Audio playback: a tap on ink seeks to when it was written.
    if (this.playback && !g.shape && g.points.length < 4) {
      const last = g.points[g.points.length - 1]!;
      const hit = hitStrokes(this.doc.page(g.pageIndex).strokes, [last], 6 / this.viewport.zoom);
      const target = this.doc.page(g.pageIndex).strokes.find((s) => hit.has(s.id));
      if (target) {
        this.callbacks.onSeek?.(target.createdAt);
        this.needsWet = true;
        this.schedule();
        return;
      }
    }
    const prevKey = this.sceneKey();
    const beforeStrokes = this.doc.page(g.pageIndex).strokes;
    // Tolerance is in screen terms: zoomed in, handwriting is smaller on the page, and so is the slack.
    const res = this.doc.addStroke(g.pageIndex, stroke, this.prefs.scratchToErase && !g.shape ? { overInkTolerance: Math.max(1.5, 5 / this.viewport.zoom) } : false);
    if (res.kind === 'added') this.appendToBuffer(g.pageIndex, stroke, prevKey);
    else if (res.kind === 'scratched') {
      const remaining = new Set(this.doc.page(g.pageIndex).strokes);
      let dirty: Rect | null = null;
      for (const st of beforeStrokes) {
        if (remaining.has(st)) continue;
        const b = cachedBounds(st);
        dirty = dirty ? { minX: Math.min(dirty.minX, b.minX), minY: Math.min(dirty.minY, b.minY), maxX: Math.max(dirty.maxX, b.maxX), maxY: Math.max(dirty.maxY, b.maxY) } : b;
      }
      if (dirty) this.refreshBufferRegion(g.pageIndex, dirty, prevKey);
    }
    if (res.kind === 'scratched') this.feel?.confirm();
    // Base redraw happens via doc listener this frame; clear the wet layer on the next frame so
    // the stroke never blinks out between the two canvases.
    this.renderNow();
    requestAnimationFrame(() => { this.needsWet = true; this.schedule(); });
    this.callbacks.onCommitted?.(g.pageIndex, res);
  }

  private eraseTo(pp: Vec2, _t: number) {
    const g = this.gesture;
    if (g.kind !== 'erase') return;
    const radius = this.tool.eraserSize / 2 / this.viewport.zoom;
    const path = g.last ? [g.last, pp] : [pp];
    g.last = pp;
    this.feel?.sample(pp.x, pp.y, Math.round(performance.now()), -1);
    let next = g.working;
    if (g.precise) {
      const out = erasePrecisely(next.strokes, path.map((v) => ({ x: v.x, y: v.y, t: 0, p: -1, tilt: -1, orient: -1 })), radius, () => newId());
      if (!out.removed.length) return;
      const strokes: InkStroke[] = [];
      for (const s of next.strokes) {
        const rep = out.replacements.get(s.id);
        if (rep) strokes.push(...rep);
        else strokes.push(s);
      }
      next = { ...next, strokes };
    } else {
      const hits = hitStrokes(next.strokes, path, radius);
      if (!hits.size) return;
      next = { ...next, strokes: next.strokes.filter((s) => !hits.has(s.id)) };
    }
    // Region touched by this step: the erased strokes (fragments lie within their bounds).
    const gone = new Set(next.strokes);
    let dirty: Rect | null = null;
    for (const st of g.working.strokes) {
      if (gone.has(st)) continue;
      const b = cachedBounds(st);
      dirty = dirty ? { minX: Math.min(dirty.minX, b.minX), minY: Math.min(dirty.minY, b.minY), maxX: Math.max(dirty.maxX, b.maxX), maxY: Math.max(dirty.maxY, b.maxY) } : b;
    }
    g.working = next;
    const prevKey = this.sceneKey();
    this.doc.preview(g.pageIndex, next);
    if (dirty) this.refreshBufferRegion(g.pageIndex, dirty, prevKey);
  }

  private finishErase(g: Extract<Gesture, { kind: 'erase' }>) {
    this.feel?.end();
    this.gesture = { kind: 'none' };
    this.hideCursor();
    const prevKey = this.sceneKey();
    const committed = this.doc.commitBetween(g.pageIndex, g.before, g.working, 'Erase');
    // The buffer already shows the final state; only its key needs to catch up.
    if (this.buffer && this.buffer.key === prevKey) this.buffer.key = this.sceneKey();
    if (committed) this.callbacks.onCommitted?.(g.pageIndex, { kind: 'erased' });
  }

  private drawLasso() {
    const g = this.gesture;
    if (g.kind !== 'lasso') return;
    const ox = g.slot.infinite ? 0 : g.slot.x, oy = g.slot.infinite ? 0 : g.slot.y;
    const pts = g.points.map((q) => this.viewport.toScreen(q.x + ox, q.y + oy));
    const d = pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join('') + (pts.length > 2 ? 'Z' : '');
    this.lassoSvg.innerHTML = `<path d="${d}" />`;
  }

  private finishLasso(g: Extract<Gesture, { kind: 'lasso' }>) {
    this.gesture = { kind: 'none' };
    this.lassoSvg.innerHTML = '';
    if (g.points.length < 3) return;
    const poly = g.points;
    const page = this.doc.page(g.pageIndex);
    const strokes = lassoSelect(page.strokes, poly);
    const inPoly = (r: Rect) => {
      const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!, b = poly[j]!;
        if (a.y > cy !== b.y > cy && cx < ((b.x - a.x) * (cy - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const texts = new Set((page.texts ?? []).filter((t) => inPoly(textBoxRect(this.bctx, t))).map((t) => t.id));
    const images = new Set((page.images ?? []).filter((m) => inPoly(imageRect(m))).map((m) => m.id));
    this.setSelection({ pageIndex: g.pageIndex, strokes, texts, images });
  }

  private hitSelection(sx: number, sy: number): 'move' | 'scale' | null {
    const b = this.selectionBounds();
    if (!b || !this.selection) return null;
    const r = this.pageRectToScreen(this.selection.pageIndex, b);
    const pad = 14;
    if (Math.hypot(sx - (r.x + r.w), sy - (r.y + r.h)) < 22) return 'scale';
    if (sx >= r.x - pad && sx <= r.x + r.w + pad && sy >= r.y - pad && sy <= r.y + r.h + pad) return 'move';
    return null;
  }

  private finishMove(g: Extract<Gesture, { kind: 'move' }>) {
    this.gesture = { kind: 'none' };
    const s = this.selection;
    if (!s) return this.invalidate();
    if (Math.abs(g.dx) < 0.01 && Math.abs(g.dy) < 0.01 && Math.abs(g.scale - 1) < 0.001) return this.invalidate();
    const a = g.anchor;
    const k = g.scale;
    const tp = (x: number, y: number) => ({ x: a.x + (x - a.x) * k + g.dx, y: a.y + (y - a.y) * k + g.dy });
    const res = this.doc.transform(s.pageIndex, s, k === 1 ? 'Move' : 'Resize', {
      stroke: (st) => translateStroke(scaleStroke(st, k, a.x, a.y), g.dx, g.dy),
      text: (t) => { const q = tp(t.x, t.y); return { ...t, x: q.x, y: q.y, width: t.width * k, fontSize: t.fontSize * k }; },
      image: (m) => { const q = tp(m.x, m.y); return { ...m, x: q.x, y: q.y, width: m.width * k, height: m.height * k }; },
    });
    this.setSelection({ pageIndex: s.pageIndex, ...res });
    this.callbacks.onCommitted?.(s.pageIndex, { kind: 'changed' });
  }

  private finishPan(g: Extract<Gesture, { kind: 'pan' }>) {
    this.gesture = { kind: 'none' };
    this.container.classList.remove('is-panning');
    let vx = g.vx * 16, vy = g.vy * 16;
    if (Math.hypot(vx, vy) < 2) return this.saveViewport();
    const step = () => {
      vx *= 0.94; vy *= 0.94;
      if (this.layout.infinite || this.layout.width * this.viewport.zoom > this.viewport.width) this.viewport.panX += vx;
      this.viewport.panY += vy;
      this.clampView();
      this.invalidate();
      if (Math.hypot(vx, vy) > 0.5) this.flingRaf = requestAnimationFrame(step);
      else this.saveViewport();
    };
    this.flingRaf = requestAnimationFrame(step);
  }

  private finishTap(g: Extract<Gesture, { kind: 'tap' }>) {
    this.gesture = { kind: 'none' };
    if (g.tool !== 'text') return;
    const d = this.viewport.toDoc(g.x, g.y);
    const slot = slotAt(this.layout, d.x, d.y);
    if (!slot) return;
    const pp = this.pagePoint(slot, g.x, g.y);
    const page = this.doc.page(slot.index);
    for (const t of [...(page.texts ?? [])].reverse()) {
      const r = textBoxRect(this.bctx, t);
      if (pp.x >= r.minX - 6 && pp.x <= r.maxX + 6 && pp.y >= r.minY - 6 && pp.y <= r.maxY + 6) {
        this.callbacks.onEditText?.({ pageIndex: slot.index, box: t, isNew: false });
        return;
      }
    }
    const width = slot.infinite ? 420 : Math.max(160, Math.min(520, slot.w - pp.x - 32));
    const box: TextBox = { id: newId(), x: pp.x, y: pp.y - 12, width, text: '', fontSize: 18, color: this.tool.preset.pen === 'highlighter' ? '#FF1B1F24' : this.tool.preset.color, font: 'sans', createdAt: Date.now() };
    this.callbacks.onEditText?.({ pageIndex: slot.index, box, isNew: true });
  }

  private endButtonPress() {
    const hb = this.hoverButton;
    this.hoverButton = null;
    if (!hb) return;
    // A quick press that did not ink toggles the button tool on/off ("tap to switch to eraser").
    if (!hb.used && performance.now() - hb.down < 400 && this.prefs.buttonAction !== 'none') {
      this.stickyButtonTool = !this.stickyButtonTool;
      this.feel?.confirm();
      this.callbacks.onButtonToggle?.();
      this.updateCursorStyle();
    }
  }

  // ---- Cursor ---------------------------------------------------------------------------------

  private hoverTimer = 0;
  private showHoverCursorLater() {
    clearTimeout(this.hoverTimer);
  }

  private showHoverCursor(x: number, y: number) {
    const t = this.tool;
    const eraser = t.tool === 'eraser' || (this.stickyButtonTool && (this.prefs.buttonAction === 'eraser' || this.prefs.buttonAction === 'precise'));
    const d = eraser ? t.eraserSize : t.tool === 'pen' ? Math.max(4, t.preset.size * this.viewport.zoom) : 0;
    if (!d) return this.hideCursor();
    this.cursor.style.display = 'block';
    this.cursor.style.width = this.cursor.style.height = `${d}px`;
    this.cursor.style.transform = `translate(${x - d / 2}px, ${y - d / 2}px)`;
    this.cursor.dataset.kind = eraser ? 'eraser' : 'pen';
    this.cursor.style.setProperty('--cursor-color', eraser ? 'transparent' : argbToCss(t.preset.color, 0.35));
  }

  private showEraserCursor(x: number, y: number) {
    const d = this.tool.eraserSize;
    this.cursor.style.display = 'block';
    this.cursor.style.width = this.cursor.style.height = `${d}px`;
    this.cursor.style.transform = `translate(${x - d / 2}px, ${y - d / 2}px)`;
    this.cursor.dataset.kind = 'eraser';
  }

  private hideCursor() {
    this.cursor.style.display = 'none';
  }

  private updateCursorStyle() {
    this.container.dataset.tool = this.stickyButtonTool ? 'button' : this.tool.tool;
  }

  // ---- Viewport persistence ----------------------------------------------------------------------

  private saveTimer = 0;
  private saveViewportSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveViewport(), 400);
  }

  private saveViewport() {
    const v = this.viewport;
    this.callbacks.onViewportSaved?.({ zoom: v.zoom, panX: v.panX, panY: v.panY });
  }
}

/**
 * Pens the native ink tip can stand in for: fully opaque with an even enough width. Pencil
 * (see-through grain), marker (95 % opacity: an opaque tip would read as a darker band),
 * highlighter, dashed and brush (width swings with pressure) are left to the web layer.
 */
const INSTANT_INK_PENS = new Set<PenType>(['fountain', 'ballpoint']);

function pointerKind(e: PointerEvent): PointerKind {
  return e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse';
}

/**
 * Where the pen will be [ms] from now, from its recent velocity — for browsers without
 * getPredictedEvents. Capped so a sudden stop never draws a visible hook.
 */
export function extrapolate(points: InkPoint[], ms: number, maxDist: number): InkPoint[] {
  const n = points.length;
  if (n < 3) return [];
  const a = points[n - 3]!, b = points[n - 1]!;
  const dt = b.t - a.t;
  if (dt <= 0 || dt > 60) return [];
  let dx = ((b.x - a.x) / dt) * ms, dy = ((b.y - a.y) / dt) * ms;
  const d = Math.hypot(dx, dy);
  if (d < 0.2) return [];
  if (d > maxDist) { dx *= maxDist / d; dy *= maxDist / d; }
  return [{ ...b, x: b.x + dx, y: b.y + dy, t: b.t + ms }];
}

function el(tag: string, cls: string) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

export function itemsBounds(ctx: CanvasRenderingContext2D, items: { strokes: InkStroke[]; texts: TextBox[]; images: ImageItem[] }): Rect {
  let r: Rect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (b: Rect) => { r = { minX: Math.min(r.minX, b.minX), minY: Math.min(r.minY, b.minY), maxX: Math.max(r.maxX, b.maxX), maxY: Math.max(r.maxY, b.maxY) }; };
  for (const s of items.strokes) if (s.points.length) add(cachedBounds(s));
  for (const t of items.texts) add(textBoxRect(ctx, t));
  for (const m of items.images) add(imageRect(m));
  return r;
}

/** Renders a page off-screen (export, thumbnails, AI vision). */
export async function renderPageStandalone(doc: Pick<NoteDocument, 'meta' | 'pages'>, pageIndex: number, scale: number, assets: AssetCache | null, opts: { paper?: boolean } = {}): Promise<HTMLCanvasElement> {
  const layout = layoutPages(doc.meta, doc.pages);
  const slot = layout.slots[pageIndex] ?? layout.slots[0]!;
  const page = doc.pages[pageIndex]!;
  const ctx0 = document.createElement('canvas').getContext('2d')!;
  let rect: Rect;
  if (slot.infinite) {
    const b = itemsBounds(ctx0, { strokes: page.strokes, texts: page.texts ?? [], images: page.images ?? [] });
    rect = Number.isFinite(b.minX) ? { minX: b.minX - 40, minY: b.minY - 40, maxX: b.maxX + 40, maxY: b.maxY + 40 } : { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  } else rect = { minX: 0, minY: 0, maxX: slot.w, maxY: slot.h };
  const w = rect.maxX - rect.minX, h = rect.maxY - rect.minY;
  const k = Math.min(scale, 8192 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(k, 0, 0, k, -rect.minX * k, -rect.minY * k);
  const dc: DrawContext = { ctx, scale: k, visible: rect };
  const note = doc.meta;
  if (page.background && assets) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(rect.minX, rect.minY, w, h);
    // Wait for a sharp render.
    for (let i = 0; i < 40; i++) {
      const bmp = assets.background(note, page.background, k, true);
      if (bmp) { ctx.drawImage(bmp, 0, 0, w, h); break; }
      await new Promise((r) => setTimeout(r, 100));
    }
  } else if (opts.paper !== false) drawPaper(dc, pagePaper(note, page), slot.infinite ? null : rect, rect);
  for (const im of page.images ?? []) {
    let bmp = assets?.image(note.id, im.asset) ?? null;
    for (let i = 0; !bmp && assets && i < 30; i++) { await new Promise((r) => setTimeout(r, 60)); bmp = assets.image(note.id, im.asset); }
    drawImageItem(ctx, im, bmp);
  }
  drawPageObjectsFor(ctx, note, page);
  drawStrokes(dc, page.strokes, { paperColor: paperColorFor(note, page) });
  for (const t of page.texts ?? []) drawTextBox(ctx, t);
  return canvas;
}

export { PAGE_GAP, drawStroke };
