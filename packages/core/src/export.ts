import { argbToHexOpacity } from './ids.ts';
import { boundsOfStrokes } from './gestures.ts';
import { rect, rectExpand, rectHeight, rectIsEmpty, rectUnion, rectWidth, type Rect } from './geometry.ts';
import { PAPER_TINTS, isInfinite, pagePaper, pageSizeOf, type ImageItem, type NoteMeta, type PageInk, type TextBox } from './model.ts';
import { centerlineSvgPath, formatNumber as f, outlineToSvgPath, penLook, strokeOutline } from './outline.ts';
import { paperElements, paperRoleColor } from './paper.ts';
import { liveInkLinks } from './links.ts';
import { objectsSvg } from './objectsvg.ts';
import { overlaysSvg } from './overlays.ts';
import { visibleStrokes } from './layers.ts';
import { objectsText, objectRect } from './objects.ts';

export const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FONT_STACK: Record<string, string> = {
  sans: "Inter, 'Helvetica Neue', Arial, sans-serif",
  serif: "'Source Serif 4', Georgia, serif",
  mono: "'JetBrains Mono', Menlo, monospace",
  hand: "'Caveat', 'Segoe Print', cursive",
};

/** Approximate line wrapping for SVG text (SVG has no native wrapping). */
export function wrapText(text: string, width: number, fontSize: number): string[] {
  const maxChars = Math.max(4, Math.floor(width / (fontSize * 0.52)));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.length <= maxChars) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > maxChars && line) { out.push(line); line = word; }
      else line = (line + ' ' + word).trim();
    }
    if (line) out.push(line);
  }
  return out;
}

export function textBoxHeight(t: TextBox): number {
  return Math.max(t.fontSize * 1.4, wrapText(t.text, t.width, t.fontSize).length * t.fontSize * 1.35);
}

export function contentBounds(page: PageInk): Rect {
  let r = boundsOfStrokes(page.strokes);
  for (const t of page.texts ?? []) r = rectUnion(r, rect(t.x, t.y, t.x + t.width, t.y + textBoxHeight(t)));
  for (const im of page.images ?? []) r = rectUnion(r, rect(im.x, im.y, im.x + im.width, im.y + im.height));
  for (const o of page.objects ?? []) r = rectUnion(r, objectRect(o));
  return r;
}

/** Page bounds: the sheet for fixed pages, ink bounds (+margin) for boards. */
export function exportBounds(note: NoteMeta, page: PageInk): Rect {
  const size = pageSizeOf(note, page);
  if (note.kind === 'board' || isInfinite(size)) {
    const b = contentBounds(page);
    return rectIsEmpty(b) ? rect(0, 0, 800, 600) : rectExpand(b, 48);
  }
  return rect(0, 0, size.width, size.height);
}

export interface SvgOptions {
  includePaper?: boolean;
  /** Resolves an image/background asset to an href (data URL or relative path). */
  assetHref?: (name: string) => string;
}

/** Standalone SVG of a page (paper, background, images, ink, text) for any viewer or agent. */
export function exportPageSvg(note: NoteMeta, page: PageInk, opts: SvgOptions = {}): string {
  const includePaper = opts.includePaper ?? true;
  const href = opts.assetHref ?? ((name: string) => `../assets/${name}`);
  const b = exportBounds(note, page);
  const w = rectWidth(b), h = rectHeight(b);
  const paper = pagePaper(note, page);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${f(b.minX)} ${f(b.minY)} ${f(w)} ${f(h)}" width="${f(w)}" height="${f(h)}">`);
  parts.push(`<title>${xmlEscape(note.title)}</title>`);
  if (includePaper) {
    const tint = argbToHexOpacity(PAPER_TINTS[paper.tint]?.color ?? '#FFFFFFFF');
    parts.push(`<rect x="${f(b.minX)}" y="${f(b.minY)}" width="${f(w)}" height="${f(h)}" fill="${tint.rgb}"/>`);
  }
  if (page.background?.kind === 'image' || page.background?.kind === 'pdf') {
    // PDF backgrounds are rasterized by the app into `<asset>.p<n>.png` previews when exported.
    const name = page.background.kind === 'pdf' ? `${page.background.asset}.p${page.background.pageNumber ?? 1}.png` : page.background.asset;
    parts.push(`<image x="${f(b.minX)}" y="${f(b.minY)}" width="${f(w)}" height="${f(h)}" href="${xmlEscape(href(name))}" preserveAspectRatio="xMidYMid meet"/>`);
  }
  if (includePaper && !page.background) {
    const els = paperElements(paper, b, note.kind === 'board' ? null : b);
    if (els.length) {
      parts.push('<g id="paper">');
      for (const e of els) {
        const c = paperRoleColor(e.role, paper.tint);
        if (e.kind === 'line') parts.push(`<line x1="${f(e.x1)}" y1="${f(e.y1)}" x2="${f(e.x2)}" y2="${f(e.y2)}" stroke="${c}" stroke-width="${f(e.width)}"/>`);
        else if (e.kind === 'dot') parts.push(`<circle cx="${f(e.x)}" cy="${f(e.y)}" r="${f(e.radius)}" fill="${c}"/>`);
        else if (e.kind === 'box') parts.push(`<rect x="${f(e.x)}" y="${f(e.y)}" width="${f(e.w)}" height="${f(e.h)}" rx="2" fill="none" stroke="${c}" stroke-width="${f(e.width)}"/>`);
        else parts.push(`<text x="${f(e.x)}" y="${f(e.y)}" font-family="${FONT_STACK.sans}" font-size="${f(e.size)}" letter-spacing="1" fill="${c}">${xmlEscape(e.text)}</text>`);
      }
      parts.push('</g>');
    }
  }
  for (const im of page.images ?? []) parts.push(imageElement(im, href));
  // Tables, solved results and graphs sit under the ink (handwriting in table cells is on top).
  if (page.objects?.length) parts.push(objectsSvg(page.objects));
  // Highlighters under ink, like on paper.
  // Hidden layers are left out; the drawing layer comes before the writing layer.
  const shown = visibleStrokes(page);
  const under = shown.filter((s) => penLook(s.pen).underlay);
  const over = shown.filter((s) => !penLook(s.pen).underlay);
  parts.push('<g id="ink" stroke-linejoin="round" stroke-linecap="round">');
  for (const s of [...under, ...over]) {
    const look = penLook(s.pen);
    const c = argbToHexOpacity(s.color);
    const op = f(Math.min(1, c.opacity * look.opacity));
    const blend = look.multiply ? ' style="mix-blend-mode:multiply"' : '';
    if (look.dashed) {
      parts.push(`<path d="${centerlineSvgPath(s.points)}" fill="none" stroke="${c.rgb}" stroke-opacity="${op}" stroke-width="${f(s.size)}" stroke-dasharray="${f(s.size * 3)} ${f(s.size * 2.2)}"/>`);
    } else {
      parts.push(`<path d="${outlineToSvgPath(strokeOutline(s))}" fill="${c.rgb}" fill-opacity="${op}"${blend}/>`);
    }
  }
  parts.push('</g>');
  for (const t of page.texts ?? []) parts.push(textElement(t));
  // Sticky notes and tape lie on top of everything.
  if (page.objects?.length) parts.push(overlaysSvg(page.objects));
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

function imageElement(im: ImageItem, href: (n: string) => string): string {
  const cx = im.x + im.width / 2, cy = im.y + im.height / 2;
  const rot = im.rotation ? ` transform="rotate(${f((im.rotation * 180) / Math.PI)} ${f(cx)} ${f(cy)})"` : '';
  return `<image x="${f(im.x)}" y="${f(im.y)}" width="${f(im.width)}" height="${f(im.height)}" href="${xmlEscape(href(im.asset))}"${rot} preserveAspectRatio="xMidYMid meet"/>`;
}

function textElement(t: TextBox): string {
  const c = argbToHexOpacity(t.color);
  const lines = wrapText(t.text, t.width, t.fontSize);
  const lh = t.fontSize * 1.35;
  const spans = lines.map((l, i) => `<tspan x="${f(t.x)}" dy="${i === 0 ? f(t.fontSize) : f(lh)}">${xmlEscape(l) || ' '}</tspan>`).join('');
  return `<text font-family="${FONT_STACK[t.font] ?? FONT_STACK.sans}" font-size="${f(t.fontSize)}" fill="${c.rgb}" fill-opacity="${f(c.opacity)}" x="${f(t.x)}" y="${f(t.y)}">${spans}</text>`;
}

function yaml(s: string): string {
  const needs = s === '' || /[:#[\]{},&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s);
  return needs ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : s;
}

/** Plain text of a page: typed text boxes, then recognized handwriting. */
export function pageText(page: PageInk): string {
  const parts: string[] = [];
  const texts = [...(page.texts ?? [])].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of texts) if (t.text.trim()) parts.push(t.text.trim());
  if (page.recognizedText?.trim()) parts.push(page.recognizedText.trim());
  const objs = objectsText(page.objects);
  if (objs) parts.push(objs);
  return parts.join('\n\n');
}

/**
 * `note.md`: YAML front matter, then every page's typed and recognized text with a link to the
 * page SVG. This is the file search, Obsidian and AI agents read.
 */
export function exportMarkdown(note: NoteMeta, pages: PageInk[]): string {
  const out: string[] = ['---'];
  out.push(`id: ${note.id}`);
  out.push(`title: ${yaml(note.title)}`);
  out.push(`kind: ${note.kind}`);
  out.push(`created: ${new Date(note.createdAt).toISOString()}`);
  out.push(`updated: ${new Date(note.updatedAt).toISOString()}`);
  if (note.notebookId) out.push(`notebook: ${note.notebookId}`);
  if (note.tags.length) out.push(`tags: [${note.tags.map(yaml).join(', ')}]`);
  out.push(`pages: ${pages.length}`);
  out.push('source: inkstone');
  out.push('---', '');
  out.push(`# ${note.title.trim() || 'Untitled'}`, '');
  if (note.summary?.trim()) out.push(`> ${note.summary.trim().replace(/\n/g, '\n> ')}`, '');
  pages.forEach((page, i) => {
    if (pages.length > 1 || note.kind === 'paged') out.push(`## Page ${i + 1}`, '');
    const text = pageText(page);
    if (text) out.push(text, '');
    else if (page.strokes.length) out.push('_(handwriting not yet recognized)_', '');
    else out.push('_(blank)_', '');
    // Links made on handwriting, so agents and Markdown readers see them too.
    const inkLinks = liveInkLinks(page);
    if (inkLinks.length) out.push(`Linked in handwriting: ${[...new Set(inkLinks.map((l) => `[[${l.target}]]`))].join(' · ')}`, '');
    out.push(`![Page ${i + 1}](pages/${page.id}.svg)`, '');
  });
  return out.join('\n');
}
