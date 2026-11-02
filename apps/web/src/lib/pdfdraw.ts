import {
  PAPER_TINTS,
  argbToHexOpacity,
  centerlineSvgPath,
  outlineToSvgPath,
  pagePaper,
  paperElements,
  paperRoleColor,
  penLook,
  strokeOutline,
  type NoteMeta,
  type PageInk,
  type PageSize,
} from '@inkstone/core';
import { BlendMode, LineCapStyle, PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { layoutText } from '../canvas/render.ts';
import { fillPdfForm } from '../fill/formWriter.ts';
import { canvasBytes } from './canvasBytes.ts';

/**
 * Drawing Inkstone pages into pdf-lib pages, shared by the note exporter (new PDF) and the
 * filled-PDF exporter (original PDF with ink on top). Coordinates: callers give the page's width
 * and height in points with the origin at the bottom left, as the page is displayed.
 */

export type ReadAsset = (name: string) => Promise<Uint8Array | null>;
export interface PdfFonts { sans: PDFFont; serif: PDFFont; mono: PDFFont }

/** Points per page unit (page units are 1/96 in, points 1/72 in). */
export const K = 72 / 96;

export async function embedFonts(pdf: PDFDocument): Promise<PdfFonts> {
  return {
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
}

function cssColorToRgb(css: string): { r: number; g: number; b: number; a: number } {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (m) {
    const [r, g, b, a] = m[1]!.split(',').map((x) => Number(x.trim()));
    return { r: r! / 255, g: g! / 255, b: b! / 255, a: a ?? 1 };
  }
  const h = css.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: 1 };
}

export const hexRgb = (hex: string) => {
  const { rgb: c, opacity } = argbToHexOpacity(hex);
  return { ...cssColorToRgb(c), a: opacity };
};

/**
 * Source PDFs of a note, loaded once per export. Form values filled in Inkstone are written in and
 * the form flattened, so embedding a page as a vector XObject keeps what the fields show.
 */
export class SourcePdfs {
  private docs = new Map<string, Promise<PDFDocument | null>>();
  constructor(private readAsset: ReadAsset, private note: Pick<NoteMeta, 'forms'>) {}
  get(asset: string): Promise<PDFDocument | null> {
    let p = this.docs.get(asset);
    if (!p) {
      p = (async () => {
        const bytes = await this.readAsset(asset);
        if (!bytes) return null;
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        await fillPdfForm(doc, this.note.forms?.[asset], { flatten: true });
        return doc;
      })();
      this.docs.set(asset, p);
    }
    return p;
  }
}

/**
 * Draws page `pageNumber` of `src` as a vector XObject filling a W×H (points) page, showing the
 * visible area (CropBox) and honouring the page's /Rotate plus the user's extra rotation.
 */
export async function drawPdfPageBackground(pdf: PDFDocument, p: PDFPage, src: PDFDocument, pageNumber: number, extraRotation: number, W: number, H: number): Promise<void> {
  const sp = src.getPage(pageNumber - 1);
  const crop = sp.getCropBox();
  const rot = (((sp.getRotation().angle + extraRotation) % 360) + 360) % 360;
  const embedded = await pdf.embedPage(sp, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height });
  if (rot === 90) p.drawPage(embedded, { x: 0, y: H, width: H, height: W, rotate: degrees(-90) });
  else if (rot === 180) p.drawPage(embedded, { x: W, y: H, width: W, height: H, rotate: degrees(-180) });
  else if (rot === 270) p.drawPage(embedded, { x: W, y: 0, width: H, height: W, rotate: degrees(-270) });
  else p.drawPage(embedded, { x: 0, y: 0, width: W, height: H });
}

/** Paper tint and lines/grid as vectors. */
export function drawPaperBackground(p: PDFPage, note: NoteMeta, page: PageInk, size: PageSize, fonts: PdfFonts): void {
  const W = size.width * K, H = size.height * K;
  const paper = pagePaper(note, page);
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

/**
 * Images, ink (filled vector outlines) and typed text of a page, on top of whatever is already
 * there. Typed text is real, selectable text when the standard fonts can encode it; handwriting
 * fonts and other scripts are rasterized at print resolution.
 */
export async function drawPageItems(pdf: PDFDocument, p: PDFPage, page: PageInk, H: number, fonts: PdfFonts, readAsset: ReadAsset): Promise<void> {
  for (const im of page.images ?? []) {
    const bytes = await readAsset(im.asset);
    if (!bytes) continue;
    try {
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const img = isPng ? await pdf.embedPng(bytes) : isJpg ? await pdf.embedJpg(bytes) : await pdf.embedPng(await reencodePng(bytes));
      if (im.rotation) {
        // pdf-lib rotates about the lower-left corner; offset so the image turns about its centre.
        const w = im.width * K, h = im.height * K;
        const cx = (im.x + im.width / 2) * K, cy = H - (im.y + im.height / 2) * K;
        const a = -im.rotation;
        const x = cx - (w / 2) * Math.cos(a) + (h / 2) * Math.sin(a);
        const y = cy - (w / 2) * Math.sin(a) - (h / 2) * Math.cos(a);
        p.drawImage(img, { x, y, width: w, height: h, rotate: { type: 'radians', angle: a } as any });
      } else {
        p.drawImage(img, { x: im.x * K, y: H - (im.y + im.height) * K, width: im.width * K, height: im.height * K });
      }
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
    const encodable = font && /^[\x20-\x7E\n -ÿ‘’“”–—•…]*$/.test(t.text);
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

async function reencodePng(bytes: Uint8Array): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return canvasBytes(c, 'image/png');
}
