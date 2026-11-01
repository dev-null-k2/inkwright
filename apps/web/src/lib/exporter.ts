import {
  PAPER_TINTS,
  argbToHexOpacity,
  centerlineSvgPath,
  exportMarkdown,
  exportPageSvg,
  outlineToSvgPath,
  pagePaper,
  pageSizeOf,
  paperElements,
  paperRoleColor,
  penLook,
  strokeOutline,
  type NoteMeta,
  type PageInk,
} from '@inkstone/core';
import { renderPageStandalone } from '../canvas/engine.ts';
import { layoutText, FONT_FAMILIES } from '../canvas/render.ts';
import type { AppVault } from './vault.ts';
import { saveFile } from '../platform/files.ts';

const safeName = (s: string) => (s.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

function cssColorToRgb(css: string): { r: number; g: number; b: number; a: number } {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (m) {
    const [r, g, b, a] = m[1]!.split(',').map((x) => Number(x.trim()));
    return { r: r! / 255, g: g! / 255, b: b! / 255, a: a ?? 1 };
  }
  const h = css.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: 1 };
}

const hexRgb = (hex: string) => {
  const { rgb, opacity } = argbToHexOpacity(hex);
  const c = cssColorToRgb(rgb);
  return { ...c, a: opacity };
};

/**
 * Vector PDF: original PDF pages are embedded as vectors, ink as filled paths, paper lines as
 * lines, typed text as real (selectable) text when the font allows it, images at full quality.
 */
export async function exportPdf(vault: AppVault, note: NoteMeta, pages: PageInk[], opts: { pageIndexes?: number[] } = {}): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts, BlendMode, LineCapStyle, degrees } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(note.title);
  pdf.setCreator('Inkstone');
  pdf.setProducer('Inkstone');
  pdf.setCreationDate(new Date(note.createdAt));
  pdf.setModificationDate(new Date(note.updatedAt));
  if (note.tags.length) pdf.setKeywords(note.tags);
  const fonts = {
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const srcPdfs = new Map<string, any>();
  const K = 72 / 96;
  const indexes = opts.pageIndexes ?? pages.map((_, i) => i);
  for (const i of indexes) {
    const page = pages[i]!;
    if (note.kind === 'board') {
      // Boards: raster at print quality — their extent is whatever was drawn.
      const canvas = await renderPageStandalone({ meta: note, pages }, i, 2, vault.assets);
      const png = await pdf.embedPng(await canvasBytes(canvas, 'image/png'));
      const p = pdf.addPage([canvas.width * K / 2, canvas.height * K / 2]);
      p.drawImage(png, { x: 0, y: 0, width: p.getWidth(), height: p.getHeight() });
      continue;
    }
    const size = pageSizeOf(note, page);
    const W = size.width * K, H = size.height * K;
    const p = pdf.addPage([W, H]);
    const paper = pagePaper(note, page);
    if (page.background?.kind === 'pdf') {
      const key = page.background.asset;
      let src = srcPdfs.get(key);
      if (!src) {
        const bytes = await vault.vault.readAsset(note.id, key);
        if (bytes) { src = await PDFDocument.load(bytes, { ignoreEncryption: true }); srcPdfs.set(key, src); }
      }
      if (src) {
        // Embed the visible area (CropBox) and honour the page's /Rotate, as viewers do.
        const sp = src.getPage((page.background.pageNumber ?? 1) - 1);
        const crop = sp.getCropBox();
        const rot = ((sp.getRotation().angle % 360) + 360) % 360;
        const embedded = await pdf.embedPage(sp, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height });
        if (rot === 90) p.drawPage(embedded, { x: 0, y: H, width: H, height: W, rotate: degrees(-90) });
        else if (rot === 180) p.drawPage(embedded, { x: W, y: H, width: W, height: H, rotate: degrees(-180) });
        else if (rot === 270) p.drawPage(embedded, { x: W, y: 0, width: H, height: W, rotate: degrees(-270) });
        else p.drawPage(embedded, { x: 0, y: 0, width: W, height: H });
      }
    } else {
      const tint = hexRgb(PAPER_TINTS[paper.tint]?.color ?? '#FFFFFFFF');
      p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(tint.r, tint.g, tint.b) });
      for (const e of paperElements(paper, { minX: 0, minY: 0, maxX: size.width, maxY: size.height }, { minX: 0, minY: 0, maxX: size.width, maxY: size.height })) {
        const c = cssColorToRgb(paperRoleColor(e.role, paper.tint));
        const color = rgb(c.r, c.g, c.b);
        if (e.kind === 'line') p.drawLine({ start: { x: e.x1 * K, y: H - e.y1 * K }, end: { x: e.x2 * K, y: H - e.y2 * K }, thickness: e.width * 0.75 * K, color, opacity: c.a });
        else if (e.kind === 'dot') p.drawCircle({ x: e.x * K, y: H - e.y * K, size: e.radius * K, color, opacity: c.a });
        else if (e.kind === 'box') p.drawRectangle({ x: e.x * K, y: H - (e.y + e.h) * K, width: e.w * K, height: e.h * K, borderColor: color, borderWidth: e.width * K, borderOpacity: c.a });
        else p.drawText(e.text.charAt(0) + e.text.slice(1).toLowerCase(), { x: e.x * K, y: H - e.y * K, size: e.size * K, font: fonts.sans, color, opacity: c.a });
      }
    }
    for (const im of page.images ?? []) {
      const bytes = await vault.vault.readAsset(note.id, im.asset);
      if (!bytes) continue;
      try {
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
        const img = isPng ? await pdf.embedPng(bytes) : isJpg ? await pdf.embedJpg(bytes) : await pdf.embedPng(await reencodePng(bytes));
        p.drawImage(img, { x: im.x * K, y: H - (im.y + im.height) * K, width: im.width * K, height: im.height * K, rotate: im.rotation ? { type: 'radians', angle: -im.rotation } as any : undefined });
      } catch (e) {
        console.warn('image export failed', e);
      }
    }
    const under = page.strokes.filter((s) => penLook(s.pen).underlay);
    const over = page.strokes.filter((s) => !penLook(s.pen).underlay);
    for (const s of [...under, ...over]) {
      const look = penLook(s.pen);
      const c = hexRgb(s.color);
      const color = rgb(c.r, c.g, c.b);
      if (look.dashed) {
        p.drawSvgPath(centerlineSvgPath(s.points), { x: 0, y: H, scale: K, borderColor: color, borderWidth: s.size, borderOpacity: c.a, borderDashArray: [s.size * 3, s.size * 2.2], borderLineCap: LineCapStyle.Round });
      } else {
        p.drawSvgPath(outlineToSvgPath(strokeOutline(s)), { x: 0, y: H, scale: K, color, opacity: c.a * look.opacity, borderWidth: 0, blendMode: look.multiply ? BlendMode.Multiply : undefined });
      }
    }
    for (const t of page.texts ?? []) {
      const c = hexRgb(t.color);
      const font = t.font === 'serif' ? fonts.serif : t.font === 'mono' ? fonts.mono : t.font === 'sans' ? fonts.sans : null;
      const encodable = font && /^[\x20-\x7E\n -ÿ‘’“”–—•…]*$/.test(t.text);
      if (font && encodable) {
        const ctx = document.createElement('canvas').getContext('2d')!;
        const { lines, lineHeights } = layoutText(ctx, t);
        let y = t.y;
        lines.forEach((l, k) => {
          const prefix = l.check != null ? (l.check ? '☑ ' : '☐ ') : l.bullet ? '• ' : '';
          const textOut = (prefix && /[☑☐]/.test(prefix) ? (l.check ? '[x] ' : '[ ] ') : prefix) + l.text;
          try {
            p.drawText(textOut, { x: (t.x + (l.bullet || l.check != null ? 0 : l.x)) * K, y: H - (y + l.size * 1.02) * K, size: l.size * K, font, color: rgb(c.r, c.g, c.b), opacity: c.a });
          } catch { /* glyph not in font: skip line */ }
          y += lineHeights[k]!;
        });
      } else {
        // Handwriting-style or non-Latin text: rasterize at print resolution.
        const cv = document.createElement('canvas');
        const ctx = cv.getContext('2d')!;
        const { height } = layoutText(ctx, t);
        const k = 4;
        cv.width = Math.ceil(t.width * k) + 8;
        cv.height = Math.ceil(height * k) + 8;
        ctx.scale(k, k);
        ctx.translate(-t.x, -t.y);
        const { drawTextBox } = await import('../canvas/render.ts');
        drawTextBox(ctx, t);
        const png = await pdf.embedPng(await canvasBytes(cv, 'image/png'));
        p.drawImage(png, { x: t.x * K, y: H - (t.y + cv.height / k) * K, width: (cv.width / k) * K, height: (cv.height / k) * K });
      }
    }
  }
  void FONT_FAMILIES;
  return pdf.save();
}

async function reencodePng(bytes: Uint8Array): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return canvasBytes(c, 'image/png');
}

export function canvasBytes(c: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => c.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('Canvas export failed'))), type, quality));
}

export type ExportFormat = 'pdf' | 'png' | 'svg' | 'md';

export async function exportNote(vault: AppVault, note: NoteMeta, pages: PageInk[], format: ExportFormat, pageIndex = 0): Promise<void> {
  const base = safeName(note.title);
  switch (format) {
    case 'pdf': {
      const bytes = await exportPdf(vault, note, pages);
      return saveFile(`${base}.pdf`, bytes, 'application/pdf');
    }
    case 'png': {
      const canvas = await renderPageStandalone({ meta: note, pages }, pageIndex, 3, vault.assets);
      return saveFile(`${base}${pages.length > 1 ? ` p${pageIndex + 1}` : ''}.png`, await canvasBytes(canvas, 'image/png'), 'image/png');
    }
    case 'svg': {
      const svg = exportPageSvg(note, pages[pageIndex]!);
      return saveFile(`${base}${pages.length > 1 ? ` p${pageIndex + 1}` : ''}.svg`, new TextEncoder().encode(svg), 'image/svg+xml');
    }
    case 'md': {
      const md = exportMarkdown(note, pages).replace(/\]\(pages\/[^)]+\.svg\)/g, '](#)');
      return saveFile(`${base}.md`, new TextEncoder().encode(md), 'text/markdown');
    }
  }
}

/** PNG of a page for AI vision (bounded size, white background). */
export async function pageImageForAI(vault: AppVault, note: NoteMeta, pages: PageInk[], pageIndex: number, region?: { minX: number; minY: number; maxX: number; maxY: number }): Promise<{ mediaType: string; base64: string }> {
  const canvas = await renderPageStandalone({ meta: note, pages }, pageIndex, 1.6, vault.assets);
  let out = canvas;
  if (region) {
    const k = canvas.width / (note.kind === 'board' ? canvas.width : (pageSizeOf(note, pages[pageIndex]).width || canvas.width));
    const c = document.createElement('canvas');
    const pad = 16;
    const sx = Math.max(0, (region.minX - pad) * k), sy = Math.max(0, (region.minY - pad) * k);
    const sw = Math.min(canvas.width - sx, (region.maxX - region.minX + pad * 2) * k), sh = Math.min(canvas.height - sy, (region.maxY - region.minY + pad * 2) * k);
    c.width = Math.max(1, Math.round(sw));
    c.height = Math.max(1, Math.round(sh));
    c.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    out = c;
  }
  const max = 1600;
  if (Math.max(out.width, out.height) > max) {
    const s = max / Math.max(out.width, out.height);
    const c = document.createElement('canvas');
    c.width = Math.round(out.width * s);
    c.height = Math.round(out.height * s);
    c.getContext('2d')!.drawImage(out, 0, 0, c.width, c.height);
    out = c;
  }
  const bytes = await canvasBytes(out, 'image/jpeg', 0.88);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: 'image/jpeg', base64: btoa(bin) };
}
