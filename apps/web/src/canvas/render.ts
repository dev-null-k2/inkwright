import {
  stripWikiLinks,
  parseWikiLinks,
  linkLabel,
  PAPER_TINTS,
  argbToCss,
  centerlineSvgPath,
  outlineToSvgPath,
  paperElements,
  paperRoleColor,
  penLook,
  strokeBounds,
  strokeOutline,
  type InkStroke,
  type NoteMeta,
  type PageInk,
  type PaperSpec,
  type Rect,
  type TextBox,
  type ImageItem,
} from '@inkwright/core';

/** Path2D per stroke object; strokes are immutable, so identity is a perfect cache key. */
const pathCache = new WeakMap<InkStroke, Path2D>();
const boundsCache = new WeakMap<InkStroke, Rect>();

export function strokePath(s: InkStroke): Path2D {
  let p = pathCache.get(s);
  if (!p) {
    p = new Path2D(penLook(s.pen).dashed ? centerlineSvgPath(s.points) : outlineToSvgPath(strokeOutline(s)));
    pathCache.set(s, p);
  }
  return p;
}

export function cachedBounds(s: InkStroke): Rect {
  let b = boundsCache.get(s);
  if (!b) {
    b = strokeBounds(s);
    boundsCache.set(s, b);
  }
  return b;
}

/** A tile of graphite "tooth": specks of paper showing through pencil strokes. */
const grainCanvases = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
function grainSource(color: string) {
  const cached = grainCanvases.get(color);
  if (cached) return cached;
  const size = 96;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (g) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 700; i++) {
      g.globalAlpha = 0.25 + rnd() * 0.6;
      g.fillStyle = color;
      const r = 0.35 + rnd() * 0.8;
      g.fillRect(rnd() * size, rnd() * size, r, r * (0.6 + rnd()));
    }
  }
  grainCanvases.set(color, c);
  return c;
}

/** Faint fibre noise for paper surfaces. */
const paperNoise = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
function paperNoiseSource(dark: boolean, strength: number) {
  const key = `${dark}-${strength}`;
  let c = paperNoise.get(key);
  if (c) return c;
  const size = 192;
  c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d') as CanvasRenderingContext2D | null;
  if (g) {
    let seed = 99;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let i = 0; i < 2400 * strength; i++) {
      const a = (0.02 + rnd() * 0.05) * (dark ? 1.4 : 1);
      g.fillStyle = dark ? `rgba(255,255,255,${a})` : `rgba(60,50,30,${a})`;
      const w = 0.5 + rnd() * 2.2;
      g.save();
      g.translate(rnd() * size, rnd() * size);
      g.rotate(rnd() * Math.PI);
      g.fillRect(0, 0, w, 0.5);
      g.restore();
    }
  }
  paperNoise.set(key, c);
  return c;
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  /** Device pixels per page unit at the current zoom. */
  scale: number;
  /** Visible region in page coordinates (for culling). */
  visible: Rect;
}

const intersects = (a: Rect, b: Rect) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/** Paper colour, template lines and fibre texture for a page rectangle. */
export function drawPaper(dc: DrawContext, paper: PaperSpec, page: Rect | null, region: Rect) {
  const { ctx } = dc;
  const tint = PAPER_TINTS[paper.tint] ?? PAPER_TINTS.ivory;
  const area = page ?? region;
  ctx.fillStyle = argbToCss(tint.color);
  ctx.fillRect(area.minX, area.minY, area.maxX - area.minX, area.maxY - area.minY);
  // Texture: subtle, scale-independent fibres.
  const strength = paper.texture === 'smooth' ? 0.35 : paper.texture === 'toothy' ? 1.4 : 0.8;
  const src = paperNoiseSource(tint.dark, strength);
  const pat = ctx.createPattern(src as CanvasImageSource, 'repeat');
  if (pat) {
    pat.setTransform(new DOMMatrix().scale(0.5, 0.5));
    ctx.fillStyle = pat;
    const r = page ? clip(region, page) : region;
    ctx.fillRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
  }
  const els = paperElements(paper, region, page);
  if (!els.length) return;
  const px = 1 / dc.scale; // one device pixel in page units
  ctx.lineCap = 'butt';
  // Batch by style: thousands of dots/lines become a handful of draw calls.
  const lineGroups = new Map<string, Path2D>();
  const dotGroups = new Map<string, Path2D>();
  for (const e of els) {
    const color = paperRoleColor(e.role, paper.tint);
    if (e.kind === 'line') {
      const key = `${color}|${Math.max(e.width * 0.75, px)}`;
      let p = lineGroups.get(key);
      if (!p) lineGroups.set(key, (p = new Path2D()));
      p.moveTo(e.x1, e.y1);
      p.lineTo(e.x2, e.y2);
    } else if (e.kind === 'dot') {
      let p = dotGroups.get(color);
      if (!p) dotGroups.set(color, (p = new Path2D()));
      const r = Math.max(e.radius, px);
      p.moveTo(e.x + r, e.y);
      p.arc(e.x, e.y, r, 0, Math.PI * 2);
    } else if (e.kind === 'box') {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(e.width, px);
      ctx.beginPath();
      ctx.roundRect(e.x, e.y, e.w, e.h, 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.font = `600 ${e.size}px ${FONT_FAMILIES.sans}`;
      ctx.fillText(e.text.charAt(0) + e.text.slice(1).toLowerCase(), e.x, e.y);
    }
  }
  for (const [key, p] of lineGroups) {
    const [color, w] = key.split('|');
    ctx.strokeStyle = color!;
    ctx.lineWidth = Number(w);
    ctx.stroke(p);
  }
  for (const [color, p] of dotGroups) {
    ctx.fillStyle = color;
    ctx.fill(p);
  }
}

function clip(a: Rect, b: Rect): Rect {
  return { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) };
}

export interface StrokeDrawOptions {
  /** Paper colour, used for pencil grain specks. */
  paperColor: string;
  /** Opacity multiplier per stroke (audio playback dims "future" strokes). */
  alphaFor?: (s: InkStroke) => number;
  /** Strokes to skip (being moved by a selection drag, etc.). */
  hidden?: Set<string>;
  /** Selected strokes get a soft iron-blue halo. */
  selected?: Set<string>;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: InkStroke, opts: StrokeDrawOptions, alphaMul = 1) {
  const look = penLook(s.pen);
  const path = strokePath(s);
  const color = argbToCss(s.color, look.opacity * alphaMul);
  if (look.dashed) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([s.size * 3, s.size * 2.2]);
    ctx.stroke(path);
    ctx.restore();
    return;
  }
  ctx.fillStyle = color;
  ctx.fill(path);
  if (look.grain) {
    // Paper tooth showing through graphite.
    const pat = ctx.createPattern(grainSource(opts.paperColor) as CanvasImageSource, 'repeat');
    if (pat) {
      ctx.save();
      ctx.clip(path);
      ctx.globalAlpha = 0.55 * alphaMul;
      pat.setTransform(new DOMMatrix().scale(0.45, 0.45));
      ctx.fillStyle = pat;
      const b = cachedBounds(s);
      ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      ctx.restore();
    }
  }
}

/** Draws all strokes of a page: highlighters first (multiplied into the paper), then ink. */
export function drawStrokes(dc: DrawContext, strokes: readonly InkStroke[], opts: StrokeDrawOptions) {
  const { ctx } = dc;
  const vis = dc.visible;
  const under: InkStroke[] = [];
  const over: InkStroke[] = [];
  for (const s of strokes) {
    if (opts.hidden?.has(s.id) || s.points.length === 0) continue;
    if (!intersects(cachedBounds(s), vis)) continue;
    (penLook(s.pen).underlay ? under : over).push(s);
  }
  if (opts.selected?.size) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    for (const s of [...under, ...over]) {
      if (!opts.selected.has(s.id)) continue;
      ctx.strokeStyle = '#5b8fd0';
      ctx.lineWidth = 4 / dc.scale + 3;
      ctx.lineJoin = 'round';
      ctx.stroke(strokePath(s));
    }
    ctx.restore();
  }
  if (under.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (const s of under) drawStroke(ctx, s, opts, opts.alphaFor?.(s) ?? 1);
    ctx.restore();
  }
  for (const s of over) drawStroke(ctx, s, opts, opts.alphaFor?.(s) ?? 1);
}

// ---- Text boxes ---------------------------------------------------------------------------

export const FONT_FAMILIES: Record<string, string> = {
  sans: "'Hanken Grotesk Variable', system-ui, sans-serif",
  serif: "'Newsreader Variable', Georgia, serif",
  mono: "'JetBrains Mono Variable', Menlo, monospace",
  hand: "'Caveat Variable', 'Segoe Print', cursive",
};

export interface TextLine {
  text: string;
  x: number;
  size: number;
  weight: number;
  check?: boolean | null;
  bullet?: boolean;
}

/** Lightweight Markdown-aware layout for canvas: headings, bullets, checkboxes, wrapping. */
export function layoutText(ctx: CanvasRenderingContext2D, t: TextBox): { lines: TextLine[]; height: number; lineHeights: number[] } {
  const lines: TextLine[] = [];
  const heights: number[] = [];
  const fam = FONT_FAMILIES[t.font] ?? FONT_FAMILIES.sans;
  for (const raw of t.text.split('\n')) {
    let text = raw;
    let size = t.fontSize;
    let weight = 400;
    let indent = 0;
    let check: boolean | null = null;
    let bullet = false;
    const h = /^(#{1,3})\s+(.*)$/.exec(text);
    if (h) {
      size = t.fontSize * (h[1]!.length === 1 ? 1.6 : h[1]!.length === 2 ? 1.3 : 1.12);
      weight = 650;
      text = h[2]!;
    }
    const c = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(text);
    if (c) { check = c[1] !== ' '; text = c[2]!; indent = size * 1.4; }
    else {
      const b = /^\s*[-*•]\s+(.*)$/.exec(text);
      if (b) { bullet = true; text = b[1]!; indent = size * 1.1; }
    }
    // [[Links]] show their label (alias, or "Title › Page 2").
    text = stripWikiLinks(text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1'));
    ctx.font = `${weight} ${size}px ${fam}`;
    const maxW = Math.max(20, t.width - indent);
    const words = text.split(/(\s+)/);
    let line = '';
    let first = true;
    const push = (s: string) => {
      lines.push({ text: s, x: indent, size, weight, check: first ? check : null, bullet: first && bullet });
      heights.push(size * 1.35);
      first = false;
    };
    for (const w of words) {
      const next = line + w;
      if (ctx.measureText(next).width > maxW && line.trim()) {
        push(line.trimEnd());
        line = w.trimStart();
        // Break words that alone exceed the width.
        while (ctx.measureText(line).width > maxW && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut--;
          push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else line = next;
    }
    push(line);
  }
  return { lines, height: heights.reduce((a, b) => a + b, 0), lineHeights: heights };
}

export function drawTextBox(ctx: CanvasRenderingContext2D, t: TextBox, opts: { selected?: boolean; editing?: boolean } = {}) {
  if (opts.editing) return;
  const fam = FONT_FAMILIES[t.font] ?? FONT_FAMILIES.sans;
  const { lines, lineHeights } = layoutText(ctx, t);
  ctx.fillStyle = argbToCss(t.color);
  ctx.textBaseline = 'alphabetic';
  let y = t.y;
  lines.forEach((l, i) => {
    const lh = lineHeights[i]!;
    ctx.font = `${l.weight} ${l.size}px ${fam}`;
    const baseline = y + l.size * 1.02;
    if (l.check != null) {
      const s = l.size * 0.78;
      ctx.save();
      ctx.strokeStyle = argbToCss(t.color, 0.8);
      ctx.lineWidth = Math.max(1, l.size / 14);
      ctx.beginPath();
      ctx.roundRect(t.x, baseline - s, s, s, s * 0.2);
      ctx.stroke();
      if (l.check) {
        ctx.beginPath();
        ctx.moveTo(t.x + s * 0.2, baseline - s * 0.5);
        ctx.lineTo(t.x + s * 0.42, baseline - s * 0.22);
        ctx.lineTo(t.x + s * 0.85, baseline - s * 0.85);
        ctx.stroke();
      }
      ctx.restore();
    } else if (l.bullet) {
      ctx.beginPath();
      ctx.arc(t.x + l.size * 0.32, baseline - l.size * 0.32, l.size * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillText(l.text, t.x + l.x, baseline);
    y += lh;
  });
  if (opts.selected) {
    ctx.save();
    ctx.strokeStyle = 'rgba(47,93,138,0.6)';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(t.x - 4, t.y - 4, t.width + 8, Math.max(lineHeights.reduce((a, b) => a + b, 0), t.fontSize) + 8);
    ctx.restore();
  }
}

export function textBoxRect(ctx: CanvasRenderingContext2D, t: TextBox): Rect {
  const { height } = layoutText(ctx, t);
  return { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + Math.max(height, t.fontSize * 1.35) };
}

export function imageRect(im: ImageItem): Rect {
  return { minX: im.x, minY: im.y, maxX: im.x + im.width, maxY: im.y + im.height };
}

export function drawImageItem(ctx: CanvasRenderingContext2D, im: ImageItem, bmp: CanvasImageSource | null) {
  ctx.save();
  if (im.rotation) {
    const cx = im.x + im.width / 2, cy = im.y + im.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(im.rotation);
    ctx.translate(-cx, -cy);
  }
  if (bmp) ctx.drawImage(bmp, im.x, im.y, im.width, im.height);
  else {
    ctx.fillStyle = 'rgba(125,138,150,0.12)';
    ctx.fillRect(im.x, im.y, im.width, im.height);
  }
  ctx.restore();
}

export function paperColorFor(note: NoteMeta, page: PageInk | undefined): string {
  const tint = (page?.paper ?? note.paper).tint;
  return argbToCss((PAPER_TINTS[tint] ?? PAPER_TINTS.ivory).color);
}

/**
 * Where each `[[link]]` of a text box sits on the page (one rect per link, on the line where its
 * label starts), for the link chips the editor lays over the canvas.
 */
export function textLinkRects(ctx: CanvasRenderingContext2D, t: TextBox): { target: string; label: string; rect: Rect }[] {
  const links = parseWikiLinks(t.text);
  if (!links.length) return [];
  const fam = FONT_FAMILIES[t.font] ?? FONT_FAMILIES.sans;
  const { lines, lineHeights } = layoutText(ctx, t);
  const out: { target: string; label: string; rect: Rect }[] = [];
  let li = 0;
  let from = 0;
  let y = t.y;
  const ys = lineHeights.map((h) => { const top = y; y += h; return top; });
  for (const l of links) {
    const label = linkLabel(l);
    // Labels appear in order; search from where the previous one was found. A label split over
    // two lines isn't found; the search then resumes where it was for the next link.
    const [li0, from0] = [li, from];
    for (; li < lines.length; li++, from = 0) {
      const line = lines[li]!;
      const at = line.text.indexOf(label, from);
      if (at < 0) continue;
      ctx.font = `${line.weight} ${line.size}px ${fam}`;
      const x0 = t.x + line.x + ctx.measureText(line.text.slice(0, at)).width;
      const w = ctx.measureText(label).width;
      const top = ys[li]!;
      out.push({ target: l.target, label, rect: { minX: x0, minY: top, maxX: x0 + w, maxY: top + line.size * 1.25 } });
      from = at + label.length;
      break;
    }
    if (li >= lines.length) [li, from] = [li0, from0];
  }
  return out;
}
