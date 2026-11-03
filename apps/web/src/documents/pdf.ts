/**
 * PDF export of a document note, from the browser's own layout.
 *
 * The document on screen is already laid out by the browser — wrapped lines, list markers,
 * tables, pictures. Rather than lay it out a second time with a PDF library, the exporter reads
 * that layout (every word's box through DOM ranges, every picture, cell, rule and checkbox) and
 * redraws it with vector text in pdf-lib, cut into A4 pages between lines (never through a line,
 * a picture or a table row) and at manual page breaks. Ink annotations are drawn on top as
 * vector paths. Words a standard PDF font can't encode (CJK, emoji…) are drawn as crisp images
 * of the same words, so nothing is dropped.
 *
 * Colours are those of printed paper (dark text on white) whatever the app's theme.
 */
import { argbToHexOpacity, outlineToSvgPath, penLook, strokeOutline, type InkStroke } from '@inkwright/core';

/** A box (CSS px, relative to the top of the sheet) that must not be split across pages. */
export interface Span { top: number; bottom: number }

/**
 * Where pages start and end: slices of at most `sliceH` from `start` to `end`, cut at forced
 * breaks and otherwise at the lowest point above the limit that cuts through no span. A span
 * taller than a page (a huge picture) is cut at the limit. Pure, for tests.
 */
export function planPages(spans: readonly Span[], forced: readonly number[], start: number, end: number, sliceH: number): { from: number; to: number }[] {
  const pages: { from: number; to: number }[] = [];
  const breaks = [...forced].filter((y) => y > start && y < end).sort((a, b) => a - b);
  const straddles = (y: number) => spans.some((s) => s.top < y - 0.5 && s.bottom > y + 0.5);
  let from = start;
  let guard = 0;
  while (from < end - 0.5 && guard++ < 10_000) {
    const limit = from + sliceH;
    const forcedCut = breaks.find((y) => y > from + 0.5 && y <= limit);
    let cut: number;
    if (forcedCut != null) cut = forcedCut;
    else if (limit >= end) cut = end;
    else {
      const cands = new Set<number>([limit]);
      for (const s of spans) {
        if (s.bottom > from && s.bottom <= limit) cands.add(s.bottom);
        if (s.top > from && s.top <= limit) cands.add(s.top);
      }
      const ok = [...cands].filter((y) => y > from + 0.5 && !straddles(y)).sort((a, b) => b - a);
      cut = ok[0] ?? limit;
    }
    pages.push({ from, to: cut });
    from = cut;
  }
  if (!pages.length) pages.push({ from: start, to: Math.max(end, start + 1) });
  return pages;
}

type Item =
  | { kind: 'text'; x: number; y: number; w: number; h: number; text: string; size: number; bold: boolean; italic: boolean; mono: boolean; link: boolean; underline: boolean; strike: boolean; css: string }
  | { kind: 'image'; x: number; y: number; w: number; h: number; el: HTMLImageElement }
  | { kind: 'box'; x: number; y: number; w: number; h: number; fill?: [number, number, number]; stroke?: [number, number, number]; width?: number }
  | { kind: 'check'; x: number; y: number; w: number; h: number; checked: boolean }
  | { kind: 'dot'; x: number; y: number; r: number }
  | { kind: 'label'; x: number; y: number; h: number; text: string; size: number };

const A4 = { w: 595.28, h: 841.89 };
const INK: [number, number, number] = [0.11, 0.11, 0.13];
const LINK: [number, number, number] = [0.12, 0.37, 0.62];
const RULE: [number, number, number] = [0.72, 0.72, 0.74];
const SHADE: [number, number, number] = [0.95, 0.94, 0.96];

/** Reads the laid-out document under `prose` (the editor's content element) relative to `sheet`. */
export function readLayout(sheet: HTMLElement, prose: HTMLElement, width: number) {
  const sr = sheet.getBoundingClientRect();
  const s = sr.width / width || 1;
  const box = (r: DOMRect) => ({ x: (r.left - sr.left) / s, y: (r.top - sr.top) / s, w: r.width / s, h: r.height / s });
  const items: Item[] = [];
  const spans: Span[] = [];
  const forced: number[] = [];
  const within = (el: Element, sel: string) => !!el.closest(sel) && prose.contains(el.closest(sel)!);

  // Words.
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const el = t.parentElement;
    if (!el || !t.data.trim() || el.closest('.ProseMirror-widget, [contenteditable="false"]:not(.ProseMirror)')) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize) || 16;
    const weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400);
    const link = within(el, 'a');
    const fmt = {
      size, bold: weight >= 600, italic: cs.fontStyle === 'italic', mono: /mono|courier|consol/i.test(cs.fontFamily), link,
      underline: link || within(el, 'u'), strike: within(el, 's, del, strike'), css: `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`,
    };
    for (const m of t.data.matchAll(/\S+/g)) {
      range.setStart(t, m.index!);
      range.setEnd(t, m.index! + m[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      if (!rects.length) continue;
      const b = box(rects[0]!);
      items.push({ kind: 'text', ...b, text: m[0], ...fmt });
      spans.push({ top: b.y, bottom: b.y + b.h });
    }
  }
  for (const img of prose.querySelectorAll('img')) {
    const b = box(img.getBoundingClientRect());
    if (b.w && b.h) { items.push({ kind: 'image', ...b, el: img }); spans.push({ top: b.y, bottom: b.y + b.h }); }
  }
  for (const li of prose.querySelectorAll('li[data-type="taskItem"]')) {
    const input = li.querySelector('input[type="checkbox"]');
    const b = box((input ?? li).getBoundingClientRect());
    items.push({ kind: 'check', x: b.x, y: b.y, w: Math.min(b.w, 14), h: Math.min(b.h, 14), checked: li.getAttribute('data-checked') === 'true' });
  }
  for (const list of prose.querySelectorAll('ul:not([data-type]), ol')) {
    const ordered = list.tagName === 'OL';
    const start = Number(list.getAttribute('start') ?? 1) || 1;
    [...list.children].filter((c) => c.tagName === 'LI').forEach((li, i) => {
      const lb = box(li.getBoundingClientRect());
      const first = li.querySelector('p, h1, h2, h3, h4, h5, h6');
      const fb = first ? box(first.getBoundingClientRect()) : lb;
      const size = parseFloat(getComputedStyle(first ?? li).fontSize) || 16;
      const line = Math.min(fb.h, size * 1.6);
      if (ordered) items.push({ kind: 'label', x: lb.x - 6, y: fb.y, h: line, text: `${start + i}.`, size });
      else items.push({ kind: 'dot', x: lb.x - size * 0.75, y: fb.y + line / 2, r: size * 0.16 });
    });
  }
  for (const q of prose.querySelectorAll('blockquote')) { const b = box(q.getBoundingClientRect()); items.push({ kind: 'box', x: b.x, y: b.y, w: 3, h: b.h, fill: RULE }); }
  for (const pre of prose.querySelectorAll('pre')) { const b = box(pre.getBoundingClientRect()); items.unshift({ kind: 'box', ...b, fill: SHADE }); }
  for (const cell of prose.querySelectorAll('td, th')) {
    const b = box(cell.getBoundingClientRect());
    items.unshift({ kind: 'box', ...b, ...(cell.tagName === 'TH' ? { fill: SHADE } : {}), stroke: RULE, width: 0.75 });
  }
  for (const tr of prose.querySelectorAll('tr')) { const b = box(tr.getBoundingClientRect()); spans.push({ top: b.y, bottom: b.y + b.h }); }
  for (const hr of prose.querySelectorAll('hr')) { const b = box(hr.getBoundingClientRect()); items.push({ kind: 'box', x: b.x, y: b.y + b.h / 2, w: b.w, h: 0.75, fill: RULE }); }
  for (const pb of prose.querySelectorAll('.page-break')) forced.push(box(pb.getBoundingClientRect()).y);
  const cs = getComputedStyle(sheet);
  const padTop = parseFloat(cs.paddingTop) || 48;
  const padBottom = parseFloat(cs.paddingBottom) || 48;
  const pb = box(prose.getBoundingClientRect());
  return { items, spans, forced, top: pb.y, bottom: pb.y + pb.h, margin: Math.max(padTop, padBottom, 40) };
}

/** Renders a word the standard fonts can't encode, as the browser draws it, for embedding. */
async function wordImage(text: string, css: string, size: number): Promise<{ png: Uint8Array; w: number; h: number }> {
  const scale = 4;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = css;
  const w = Math.max(1, Math.ceil(ctx.measureText(text).width));
  const h = Math.ceil(size * 1.4);
  c.width = w * scale;
  c.height = h * scale;
  const g = c.getContext('2d')!;
  g.scale(scale, scale);
  g.font = css;
  g.fillStyle = 'rgb(28,28,33)';
  g.textBaseline = 'middle';
  g.fillText(text, 0, h / 2);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  return { png: new Uint8Array(await blob!.arrayBuffer()), w, h };
}

async function imagePng(img: HTMLImageElement): Promise<Uint8Array | null> {
  try {
    if (!img.complete) await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 1;
    c.height = img.naturalHeight || 1;
    c.getContext('2d')!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/**
 * The document as an A4 PDF. `sheet` is the page element at its layout `width` (CSS px), `prose`
 * the editor content inside it, `ink` the annotations in sheet coordinates.
 */
export async function documentToPdf(sheet: HTMLElement, prose: HTMLElement, width: number, opts: { title: string; ink: readonly InkStroke[] }): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, LineCapStyle } = await import('pdf-lib');
  const layout = readLayout(sheet, prose, width);
  const k = A4.w / width;
  const pageH = A4.h / k;
  const slice = pageH - 2 * layout.margin;
  // Pages are cut between lines of text; ink may cross a cut (it is clipped to each page).
  const pages = planPages(layout.spans, layout.forced, layout.top, layout.bottom, slice);
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.title || 'Document');
  pdf.setCreator('Inkwright');
  const fonts = {
    r: await pdf.embedFont(StandardFonts.Helvetica), b: await pdf.embedFont(StandardFonts.HelveticaBold),
    i: await pdf.embedFont(StandardFonts.HelveticaOblique), bi: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    m: await pdf.embedFont(StandardFonts.Courier), mb: await pdf.embedFont(StandardFonts.CourierBold),
  };
  const images = new Map<HTMLImageElement, Awaited<ReturnType<typeof pdf.embedPng>> | null>();
  const c3 = (c: [number, number, number]) => rgb(c[0], c[1], c[2]);

  for (const pg of pages) {
    const p = pdf.addPage([A4.w, A4.h]);
    // Sheet y → PDF y (points from the bottom of the page).
    const Y = (y: number) => A4.h - (layout.margin + (y - pg.from)) * k;
    const visible = (y: number, h: number) => y + h > pg.from - 0.5 && y < pg.to + 0.5;
    p.pushOperators(pushGraphicsState(), rectangle(0, Y(pg.to), A4.w, (pg.to - pg.from) * k), clip(), endPath());
    for (const it of layout.items) {
      if (it.kind === 'dot') {
        if (!visible(it.y - it.r, it.r * 2)) continue;
        p.drawCircle({ x: it.x * k, y: Y(it.y), size: it.r * k, color: c3(INK) });
        continue;
      }
      if (!visible(it.y, it.h)) continue;
      if (it.kind === 'box') {
        p.drawRectangle({ x: it.x * k, y: Y(it.y + it.h), width: it.w * k, height: Math.max(0.5, it.h * k), ...(it.fill ? { color: c3(it.fill) } : {}), ...(it.stroke ? { borderColor: c3(it.stroke), borderWidth: it.width ?? 0.75 } : {}) });
      } else if (it.kind === 'check') {
        p.drawRectangle({ x: it.x * k, y: Y(it.y + it.h), width: it.w * k, height: it.h * k, borderColor: c3(INK), borderWidth: 0.9 });
        if (it.checked) p.drawSvgPath(`M ${it.w * 0.2} ${it.h * 0.55} L ${it.w * 0.42} ${it.h * 0.78} L ${it.w * 0.82} ${it.h * 0.22}`, { x: it.x * k, y: Y(it.y), scale: k, borderColor: c3(INK), borderWidth: 1.4, borderLineCap: LineCapStyle.Round });
      } else if (it.kind === 'label') {
        const size = it.size * k;
        const w = fonts.r.widthOfTextAtSize(it.text, size);
        p.drawText(it.text, { x: it.x * k - w, y: Y(it.y + it.h / 2) - size * 0.33, size, font: fonts.r, color: c3(INK) });
      } else if (it.kind === 'image') {
        if (!images.has(it.el)) {
          const png = await imagePng(it.el);
          images.set(it.el, png ? await pdf.embedPng(png).catch(() => null) : null);
        }
        const img = images.get(it.el);
        if (img) p.drawImage(img, { x: it.x * k, y: Y(it.y + it.h), width: it.w * k, height: it.h * k });
      } else {
        const font = it.mono ? (it.bold ? fonts.mb : fonts.m) : it.bold ? (it.italic ? fonts.bi : fonts.b) : it.italic ? fonts.i : fonts.r;
        const size = it.size * k;
        const color = c3(it.link ? LINK : INK);
        const baseline = Y(it.y + it.h / 2) - size * 0.33;
        let drawn = true;
        try {
          font.encodeText(it.text);
          p.drawText(it.text, { x: it.x * k, y: baseline, size, font, color });
        } catch {
          drawn = false;
        }
        if (!drawn) {
          const im = await wordImage(it.text, it.css, it.size);
          const e = await pdf.embedPng(im.png);
          p.drawImage(e, { x: it.x * k, y: Y(it.y + it.h / 2 + im.h / 2), width: im.w * k, height: im.h * k });
        }
        if (it.underline) p.drawLine({ start: { x: it.x * k, y: baseline - size * 0.12 }, end: { x: (it.x + it.w) * k, y: baseline - size * 0.12 }, thickness: Math.max(0.4, size / 18), color });
        if (it.strike) p.drawLine({ start: { x: it.x * k, y: baseline + size * 0.3 }, end: { x: (it.x + it.w) * k, y: baseline + size * 0.3 }, thickness: Math.max(0.4, size / 18), color });
      }
    }
    // Ink annotations over the text.
    for (const s of opts.ink) {
      const ys = s.points.map((q) => q.y);
      if (!visible(Math.min(...ys), Math.max(...ys) - Math.min(...ys))) continue;
      const { rgb: css, opacity } = argbToHexOpacity(s.color);
      const h = css.replace('#', '');
      const col = rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
      const look = penLook(s.pen);
      p.drawSvgPath(outlineToSvgPath(strokeOutline(s)), { x: 0, y: Y(0), scale: k, color: col, opacity: opacity * look.opacity, borderWidth: 0 });
    }
    p.pushOperators(popGraphicsState());
  }
  return pdf.save();
}
