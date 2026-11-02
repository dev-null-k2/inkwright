import {
  exportMarkdown,
  exportPageSvg,
  pageSizeOf,
  type NoteMeta,
  type PageInk,
} from '@inkstone/core';
import { renderPageStandalone } from '../canvas/engine.ts';
import type { AppVault } from './vault.ts';
import { saveFile } from '../platform/files.ts';
import { canvasBytes } from './canvasBytes.ts';
import { useSettings } from '../state/settings.ts';

export { canvasBytes };

const safeName = (s: string) => (s.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

/**
 * Vector PDF: original PDF pages are embedded as vectors, ink as filled paths, paper lines as
 * lines, typed text as real (selectable) text when the font allows it, images at full quality.
 * (To get the original PDF back with its form filled in, see fill/exportFilled.ts.)
 */
export async function exportPdf(vault: AppVault, note: NoteMeta, pages: PageInk[], opts: { pageIndexes?: number[] } = {}): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  // Loaded on demand: pdf-lib is large and only needed when exporting.
  const { K, SourcePdfs, drawPageItems, drawPaperBackground, drawPdfPageBackground, embedFonts } = await import('./pdfdraw.ts');
  const pdf = await PDFDocument.create();
  pdf.setTitle(note.title);
  pdf.setCreator('Inkstone');
  pdf.setProducer('Inkstone');
  pdf.setCreationDate(new Date(note.createdAt));
  pdf.setModificationDate(new Date(note.updatedAt));
  if (note.tags.length) pdf.setKeywords(note.tags);
  const fonts = await embedFonts(pdf);
  const readAsset = (name: string) => vault.vault.readAsset(note.id, name);
  const sources = new SourcePdfs(readAsset, note);
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
    if (page.background?.kind === 'pdf') {
      const src = await sources.get(page.background.asset);
      if (src) await drawPdfPageBackground(pdf, p, src, page.background.pageNumber ?? 1, page.background.rotation ?? 0, W, H);
    } else {
      drawPaperBackground(p, note, page, size, fonts);
    }
    await drawPageItems(pdf, p, page, H, fonts, readAsset);
  }
  // Proof of authorship: a signed certificate for the exported pages travels inside the PDF.
  if (useSettings.getState().authorship.attachToPdf) {
    try {
      const { createCertificate, embedInPdf } = await import('../authorship/certificate.ts');
      await embedInPdf(pdf, await createCertificate(note, pages, indexes));
    } catch (e) {
      console.warn('Exported without an authorship certificate', e);
    }
  }
  return pdf.save();
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
