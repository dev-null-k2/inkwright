import type { ForceLayout } from '@inkwright/core';
import { clusterExtent, css, prefersReducedMotion, ringTexture, type DisplayGraph, type GraphRenderer, type GraphTheme } from './scene.ts';

/**
 * The graph flat, on a 2D canvas: the fallback where WebGL isn't available and the calmer view
 * for those who prefer it. Same ink drops, threads, notebook clouds and stone-eye as in 3D. Drag
 * to pan, wheel or pinch to zoom.
 */
export class Graph2D implements GraphRenderer {
  readonly kind = '2d' as const;
  frames = 0;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private g: DisplayGraph | null = null;
  private layout: ForceLayout | null = null;
  private alpha: Float32Array = new Float32Array(0);
  private target: Float32Array = new Float32Array(0);
  private selected = -1;
  private hovered = -1;
  private labelIds: string[] = [];
  private view = { x: 0, y: 0, k: 1 };
  private tween: { from: { x: number; y: number; k: number }; to: { x: number; y: number; k: number }; t0: number; ms: number } | null = null;
  private raf = 0;
  private clouds: HTMLCanvasElement[] = [];
  private reduced = prefersReducedMotion();
  private drag: { id: number; x: number; y: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; k: number } | null = null;
  private dirty = true;

  constructor(private host: HTMLElement, private theme: GraphTheme) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'graph-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.resize();
    const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); };
    this.raf = requestAnimationFrame(loop);
  }

  private onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: this.view.k };
      this.drag = null;
    } else this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.tween = null;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      this.view.k = Math.max(0.15, Math.min(8, (this.pinch.k * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / this.pinch.d));
      this.dirty = true;
      return;
    }
    if (this.drag && this.drag.id === e.pointerId) {
      this.view.x -= (e.clientX - this.drag.x) / this.view.k;
      this.view.y -= (e.clientY - this.drag.y) / this.view.k;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.dirty = true;
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.drag?.id === e.pointerId) this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const before = this.toWorld(e.clientX - r.left, e.clientY - r.top);
    this.view.k = Math.max(0.15, Math.min(8, this.view.k * Math.exp(-e.deltaY * 0.0015)));
    const after = this.toWorld(e.clientX - r.left, e.clientY - r.top);
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
    this.tween = null;
    this.dirty = true;
  };

  private toWorld(sx: number, sy: number) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (sx - w / 2) / this.view.k + this.view.x, y: (sy - h / 2) / this.view.k + this.view.y };
  }

  private toScreen(x: number, y: number) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (x - this.view.x) * this.view.k + w / 2, y: (y - this.view.y) * this.view.k + h / 2 };
  }

  setTheme(t: GraphTheme): void {
    this.theme = t;
    if (this.g) this.clouds = this.g.clusters.map((c, k) => ringTexture(c.color, 256, k * 7919 + c.id.length));
    this.dirty = true;
  }

  setGraph(g: DisplayGraph, layout: ForceLayout): void {
    const prev = this.alpha;
    this.g = g;
    this.layout = layout;
    this.alpha = new Float32Array(g.nodes.length);
    if (prev.length === g.nodes.length) this.alpha.set(prev);
    if (this.target.length !== g.nodes.length) this.target = new Float32Array(g.nodes.length).fill(1);
    this.clouds = g.clusters.map((c, k) => ringTexture(c.color, 256, k * 7919 + c.id.length));
    this.dirty = true;
  }

  setTargets(alpha: Float32Array, instant = false): void {
    this.target = alpha;
    if (instant || this.reduced) this.alpha = Float32Array.from(alpha);
    this.dirty = true;
  }

  setSelected(id: string | null): void { this.selected = id == null ? -1 : (this.g?.index.get(id) ?? -1); this.dirty = true; }
  setHovered(id: string | null): void { this.hovered = id == null ? -1 : (this.g?.index.get(id) ?? -1); this.dirty = true; }
  setLabels(ids: readonly string[]): void { this.labelIds = [...ids]; this.dirty = true; }

  focus(id: string, animate: boolean): void {
    const i = this.g?.index.get(id);
    if (i == null || !this.layout) return;
    const to = { x: this.layout.x[i]!, y: this.layout.y[i]!, k: Math.max(this.view.k, 1.6) };
    if (!animate || this.reduced) { this.view = to; this.dirty = true; return; }
    this.tween = { from: { ...this.view }, to, t0: performance.now(), ms: 600 };
  }

  fit(animate: boolean): void {
    if (!this.layout || !this.g) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < this.g.nodes.length; i++) {
      if (this.target[i]! < 0.05) continue;
      minX = Math.min(minX, this.layout.x[i]!); maxX = Math.max(maxX, this.layout.x[i]!);
      minY = Math.min(minY, this.layout.y[i]!); maxY = Math.max(maxY, this.layout.y[i]!);
    }
    if (!Number.isFinite(minX)) return;
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const k = Math.min(3, 0.85 * Math.min(w / Math.max(60, maxX - minX), h / Math.max(60, maxY - minY)));
    const to = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k };
    if (!animate || this.reduced) { this.view = to; this.dirty = true; return; }
    this.tween = { from: { ...this.view }, to, t0: performance.now(), ms: 700 };
  }

  pick(clientX: number, clientY: number): string | null {
    if (!this.g || !this.layout) return null;
    const r = this.canvas.getBoundingClientRect();
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.g.nodes.length; i++) {
      if (this.alpha[i]! < 0.25 || this.target[i]! < 0.25) continue;
      const p = this.toScreen(this.layout.x[i]!, this.layout.y[i]!);
      const d = Math.hypot(p.x + r.left - clientX, p.y + r.top - clientY);
      const radius = Math.max(9, this.g.nodes[i]!.size * this.view.k + 4);
      if (d < radius && d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? this.g.nodes[best]!.id : null;
  }

  screenPos(id: string): { x: number; y: number } | null {
    const i = this.g?.index.get(id);
    if (i == null || !this.layout) return null;
    const r = this.canvas.getBoundingClientRect();
    const p = this.toScreen(this.layout.x[i]!, this.layout.y[i]!);
    return { x: p.x + r.left, y: p.y + r.top };
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dirty = true;
  }

  private frame() {
    const l = this.layout;
    let active = this.dirty;
    if (l && !l.settled && !this.reduced) { l.tick(); active = true; }
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.t0) / this.tween.ms);
      const e = 1 - Math.pow(1 - k, 3);
      const { from, to } = this.tween;
      this.view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
      if (k >= 1) this.tween = null;
      active = true;
    }
    for (let i = 0; i < this.alpha.length; i++) {
      const a = this.alpha[i]!, t = this.target[i]!;
      if (Math.abs(a - t) > 0.004) { this.alpha[i] = a + (t - a) * 0.12; active = true; } else this.alpha[i] = t;
    }
    if (this.selected >= 0 && !this.reduced) active = true; // the stone-eye breathes
    if (!active && this.frames > 0) return;
    this.dirty = false;
    this.draw();
    this.frames++;
  }

  private draw() {
    const { ctx, canvas, theme: t } = this;
    const g = this.g, l = this.layout;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css(t.desk);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!g || !l) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = this.view.k;
    // Notebook clouds.
    g.clusters.forEach((c, ci) => {
      const vis = c.members.filter((i) => this.alpha[i]! > 0.05);
      if (!vis.length || !this.clouds[ci]) return;
      const ext = clusterExtent(l, vis);
      const p = this.toScreen(ext.x, ext.y);
      const r = (ext.r * 1.35 + 15) * k;
      ctx.globalAlpha = t.dark ? 0.5 : 0.7;
      ctx.drawImage(this.clouds[ci]!, p.x - r, p.y - r, r * 2, r * 2);
    });
    ctx.globalAlpha = 1;
    // Threads.
    ctx.lineWidth = Math.max(0.6, Math.min(1.4, 0.8 * Math.sqrt(k)));
    for (const e of g.edges) {
      const a = Math.min(this.alpha[e.s]!, this.alpha[e.t]!);
      if (a < 0.02) continue;
      const touch = this.selected >= 0 && (e.s === this.selected || e.t === this.selected);
      const p = this.toScreen(l.x[e.s]!, l.y[e.s]!), q = this.toScreen(l.x[e.t]!, l.y[e.t]!);
      ctx.strokeStyle = css(touch && e.kind === 'link' ? t.iron : e.color, Math.min(1, e.alpha * a * (touch ? 1.7 : this.selected >= 0 ? 0.55 : 1)));
      ctx.setLineDash(e.kind === 'related' ? [3, 4] : []);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Ink drops.
    g.nodes.forEach((n, i) => {
      const a = this.alpha[i]!;
      if (a < 0.02) return;
      const p = this.toScreen(l.x[i]!, l.y[i]!);
      const r = Math.max(1.6, n.size * k * (i === this.hovered ? 1.15 : 1));
      const seed = (n.id.charCodeAt(n.id.length - 1) * 31 + i * 7) % 97 / 97 * Math.PI * 2;
      ctx.beginPath();
      for (let s = 0; s <= 24; s++) {
        const ang = (s / 24) * Math.PI * 2;
        const w = r * (1 + 0.07 * Math.sin(ang * 3 + seed) + 0.04 * Math.sin(ang * 7 + seed * 2.7));
        const x = p.x + Math.cos(ang) * w, y = p.y + Math.sin(ang) * w;
        if (s) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.05);
      const rim = t.dark ? n.color.map((c) => Math.min(1, c * 1.18)) as typeof n.color : n.color.map((c) => c * 0.68) as typeof n.color;
      grad.addColorStop(0, css(n.color, a * 0.88));
      grad.addColorStop(0.7, css(n.color, a));
      grad.addColorStop(1, css(rim, a));
      ctx.fillStyle = grad;
      ctx.fill();
    });
    // The stone-eye on the selected note.
    if (this.selected >= 0 && this.alpha[this.selected]! > 0.05) {
      const n = g.nodes[this.selected]!;
      const p = this.toScreen(l.x[this.selected]!, l.y[this.selected]!);
      const r = Math.max(7, n.size * k * 2.1);
      const pulse = this.reduced ? 1 : 0.75 + 0.25 * Math.sin(performance.now() / 600);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.35, 0, Math.PI * 2);
      ctx.fillStyle = css(t.eye, 0.14 * pulse);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.84, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, r * 0.26);
      ctx.strokeStyle = css(t.eye);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = css(t.eyeCore, 0.92);
      ctx.fill();
    }
    // Titles.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const rootStyle = getComputedStyle(document.documentElement);
    const uiFont = rootStyle.getPropertyValue('--font-ui') || 'sans-serif';
    const titleFont = rootStyle.getPropertyValue('--font-title') || 'serif';
    for (const id of this.labelIds) {
      const i = g.index.get(id);
      if (i == null || this.alpha[i]! < 0.2) continue;
      const n = g.nodes[i]!;
      const p = this.toScreen(l.x[i]!, l.y[i]!);
      const notebook = n.kind === 'notebook';
      ctx.font = `${notebook ? '600 ' : i === this.selected ? '600 ' : ''}${notebook ? 13 : 12}px ${notebook ? titleFont : uiFont}`;
      ctx.fillStyle = css(notebook ? n.color : t.ink, this.alpha[i]! * (notebook ? 0.9 : 0.85));
      ctx.fillText(n.label.length > 42 ? n.label.slice(0, 41) + '…' : n.label, p.x, p.y + Math.max(4, n.size * k) + 5);
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.remove();
  }
}
