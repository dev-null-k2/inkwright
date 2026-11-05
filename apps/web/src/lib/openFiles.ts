import { useEffect, useState } from 'react';
import { newId, pageSizeOf, type NoteDocument, type PageSize, type TextBox } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import { inspectPdf } from '../canvas/assets.ts';
import type { AppVault } from './vault.ts';
import { useApp } from '../state/app.ts';
import { InkwrightNative, hasNativePlugin, type SharedFile } from '../platform/native.ts';
import { applePlugin } from '../ai/apple/plugin.ts';

/**
 * Opening files from the device, whichever way they arrive: the library's "Open file", drag and
 * drop onto the library or onto an open note, the installed desktop app's file handler ("Open
 * with Inkwright" in Finder/Explorer, `launchQueue`), the Web Share Target (share to Inkwright), and
 * Android's "Open with" / share sheet (InkwrightNativePlugin).
 */

export type FileKind = 'pdf' | 'image' | 'text' | 'backup' | 'unknown';

/** What a file is, by MIME type or, when the system gives none (drag and drop), by extension. */
export function classifyFile(f: { name: string; type: string }): FileKind {
  const t = (f.type || '').toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'avif', 'bmp'].includes(ext)) return 'image';
  if (t === 'text/plain' || t === 'text/markdown' || t === 'text/x-markdown' || ['txt', 'md', 'markdown', 'text'].includes(ext)) return 'text';
  if (ext === 'zip' || t === 'application/zip') return 'backup';
  return 'unknown';
}

export const isHeic = (f: { name: string; type: string }) => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

/** The `accept` list for file pickers: everything Inkwright can open. */
export const OPENABLE = 'application/pdf,image/*,.heic,.heif,text/plain,text/markdown,.txt,.md,.markdown,.zip';

/**
 * Lays text out as text boxes over pages: one box per page with as many lines as fit, breaking
 * between source lines (paragraphs flow on). Line wrapping is estimated from the average glyph
 * width, so a page never overflows; Markdown keeps its formatting since text boxes are Markdown.
 */
export function textToPages(text: string, size: PageSize, opts: { fontSize?: number; margin?: number; now?: number; makeId?: () => string } = {}): TextBox[][] {
  const fontSize = opts.fontSize ?? 16;
  const margin = opts.margin ?? 72;
  const makeId = opts.makeId ?? (() => newId());
  const width = Math.max(200, size.width - margin * 2);
  const lineH = fontSize * 1.5;
  const perPage = Math.max(4, Math.floor((size.height - margin * 2) / lineH));
  const perLine = Math.max(10, Math.floor(width / (fontSize * 0.55)));
  // A paragraph longer than a page is cut at a word boundary so every page fits.
  const maxChars = perLine * perPage;
  const src = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').flatMap((line) => {
    const parts: string[] = [];
    let rest = line;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(' ', maxChars);
      const at = cut > maxChars / 2 ? cut : maxChars;
      parts.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^ /, '');
    }
    parts.push(rest);
    return parts;
  });
  const pages: string[][] = [[]];
  let used = 0;
  for (const line of src) {
    const rows = Math.max(1, Math.ceil(line.length / perLine));
    if (used + rows > perPage && pages[pages.length - 1]!.length) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1]!.push(line);
    used += rows;
  }
  return pages.map((lines) => {
    const body = lines.join('\n');
    return body.trim() ? [{ id: makeId(), x: margin, y: margin, width, text: body, fontSize, color: '#FF1B1F24', font: 'sans', createdAt: opts.now ?? Date.now(), origin: 'import' } as TextBox] : [];
  });
}

/** Reads a text file as UTF-8 (with or without BOM). */
export async function readText(f: Blob): Promise<string> {
  return new TextDecoder('utf-8').decode(new Uint8Array(await f.arrayBuffer())).replace(/^﻿/, '');
}

/**
 * Drops files into the open note: PDFs add their pages after the current one, images land where
 * they were dropped, text files become a text box there.
 */
/**
 * Files a module takes over when they are dropped into a note (data files become datasets, photos
 * can become ink…): return true when handled. Registered by modules; the first match wins.
 */
export type NoteFileHandler = (f: File, ctx: { vault: AppVault; doc: NoteDocument; engine: InkEngine; pageIndex: number; at: { x: number; y: number } }) => Promise<boolean>;
const noteFileHandlers = new Set<NoteFileHandler>();
export function registerNoteFileHandler(h: NoteFileHandler): () => void {
  noteFileHandlers.add(h);
  return () => noteFileHandlers.delete(h);
}

export async function insertFilesIntoNote(vault: AppVault, doc: NoteDocument, engine: InkEngine, files: File[], drop?: { clientX: number; clientY: number; host: HTMLElement }): Promise<void> {
  const app = useApp.getState();
  let pageIndex = engine.currentPageIndex;
  let at = engine.visibleCenter(pageIndex);
  if (drop) {
    const hr = drop.host.getBoundingClientRect();
    const sx = drop.clientX - hr.left, sy = drop.clientY - hr.top;
    for (let i = 0; i < doc.pageCount; i++) {
      const s = pageSizeOf(doc.meta, doc.page(i));
      const r = engine.pageRectToScreen(i, { minX: 0, minY: 0, maxX: s.width || 1, maxY: s.height || 1 });
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
        pageIndex = i;
        const k = (s.width || 1) / r.w;
        at = { x: (sx - r.x) * k, y: (sy - r.y) * k };
        break;
      }
    }
  }
  let offset = 0;
  let addedPages = 0;
  for (const f of files) {
    try {
      let handled = false;
      for (const h of noteFileHandlers) if (!handled) handled = await h(f, { vault, doc, engine, pageIndex, at: { x: at.x + offset, y: at.y + offset } });
      if (handled) { offset += 24; continue; }
      const kind = classifyFile(f);
      if (kind === 'pdf') {
        addedPages += await insertPdf(vault, doc, f, engine.currentPageIndex + 1 + addedPages);
      } else if (kind === 'image') {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let dim: { width: number; height: number };
        try {
          const bmp = await createImageBitmap(f);
          dim = { width: bmp.width, height: bmp.height };
          bmp.close();
        } catch {
          app.fail(isHeic(f) ? `${f.name}: this browser can't open HEIC photos. Save it as JPEG, or open it on a device that can.` : `${f.name} couldn't be opened as an image.`);
          continue;
        }
        const ext = (f.type.split('/')[1] ?? /\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? 'png').replace('jpeg', 'jpg').toLowerCase();
        const asset = vault.newAssetName(ext);
        await vault.vault.writeAsset(doc.meta.id, asset, bytes);
        const size = pageSizeOf(doc.meta, doc.page(pageIndex));
        const k = Math.min(1, ((size.width || 800) * 0.7) / dim.width, ((size.height || 800) * 0.6) / dim.height);
        const w = dim.width * k, h = dim.height * k;
        doc.addImage(pageIndex, { id: newId(), x: at.x - w / 2 + offset, y: at.y - h / 2 + offset, width: w, height: h, asset, rotation: 0, createdAt: Date.now(), origin: 'import' });
        offset += 24;
      } else if (kind === 'text') {
        const text = await readText(f);
        const size = pageSizeOf(doc.meta, doc.page(pageIndex));
        const width = Math.max(200, Math.min(520, (size.width || 900) - at.x - 24));
        doc.upsertText(pageIndex, { id: newId(), x: at.x, y: at.y, width, text: text.trim(), fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'import' }, 'Add text');
      } else {
        app.fail(`${f.name} isn't a PDF, image or text file.`);
      }
    } catch (e) {
      console.error(e);
      app.fail(`Couldn't add ${f.name}: ${(e as Error).message}`);
    }
  }
  if (addedPages) app.toast({ text: `Added ${addedPages} ${addedPages === 1 ? 'page' : 'pages'}`, tone: 'success' });
}

/** Adds every page of a PDF to the note at `at` ("Merge PDF"); returns the number of pages. */
export async function insertPdf(vault: AppVault, doc: NoteDocument, f: Blob, at: number): Promise<number> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const info = await inspectPdf(bytes);
  const asset = vault.newAssetName('pdf');
  await vault.vault.writeAsset(doc.meta.id, asset, bytes);
  let i = at;
  info.sizes.forEach((s, n) => {
    doc.addPage(i++, { size: { name: 'PDF', width: s.width, height: s.height }, background: { kind: 'pdf', asset, pageNumber: n + 1 } });
  });
  return info.count;
}

/** Drag-and-drop of files onto an element; `dragging` drives a drop hint. */
export function useFileDrop(el: HTMLElement | null, onFiles: (files: File[], e: DragEvent) => void, enabled = true): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!el || !enabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDragging(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) onFiles(files, e);
    };
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  }, [el, enabled, onFiles]);
  return dragging;
}

// ---- Files handed to the app by the system ------------------------------------------------------

/** Imports files the system opened Inkwright with and opens the first resulting note. */
export async function openIncoming(files: File[], text?: string) {
  const { importFiles, importText } = await import('./actions.ts');
  const app = useApp.getState();
  let id: string | null = null;
  if (files.length) id = await importFiles(files);
  if (!id && text?.trim()) id = await importText(text, 'Shared text');
  if (id) app.navigate({ name: 'editor', noteId: id });
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hooks up every way the system can hand Inkwright a file. Call once, after the vault is open.
 *  - PWA file handlers (manifest `file_handlers`): `launchQueue` delivers file handles.
 *  - Web Share Target (manifest `share_target`, POST): the service worker stashes the shared
 *    files in Cache Storage and reloads the app with `?share=1`.
 *  - Android: MainActivity's intent filters; InkwrightNativePlugin copies the content into the
 *    app's cache and reports it here (`takeSharedFiles` at start, `sharedFiles` while running).
 *  - iOS: "Open in Inkwright" (Info.plist document types); InkwrightApplePlugin does the same.
 */
export function installOpenHandlers(): void {
  const lq = (window as Window & { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    await openIncoming(files);
  });

  if (new URLSearchParams(location.search).has('share') && 'caches' in window) {
    void (async () => {
      const cache = await caches.open('inkwright-share');
      const files: File[] = [];
      let text = '';
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (res) {
          if (req.url.endsWith('/__share/text')) text = await res.text();
          else files.push(new File([await res.blob()], decodeURIComponent(res.headers.get('x-name') ?? 'Shared file'), { type: res.headers.get('content-type') ?? '' }));
        }
        await cache.delete(req);
      }
      history.replaceState(history.state, '', location.pathname + location.hash);
      await openIncoming(files, text);
    })();
  }

  const intake: Pick<typeof InkwrightNative, 'takeSharedFiles'> & { addListener(e: 'sharedFiles', cb: (e: { files: SharedFile[] }) => void): Promise<unknown> } | null =
    hasNativePlugin ? InkwrightNative : applePlugin();
  if (intake) {
    const take = async (list: SharedFile[]) => {
      if (!list.length) return;
      const { Filesystem } = await import('@capacitor/filesystem');
      const files: File[] = [];
      for (const f of list) {
        try {
          const r = await Filesystem.readFile({ path: f.path });
          const data = typeof r.data === 'string' ? base64Bytes(r.data) : new Uint8Array(await (r.data as Blob).arrayBuffer());
          files.push(new File([data as BlobPart], f.name, { type: f.mimeType }));
          await Filesystem.deleteFile({ path: f.path }).catch(() => {});
        } catch (e) {
          useApp.getState().fail(`Couldn't open ${f.name}: ${(e as Error).message}`);
        }
      }
      await openIncoming(files);
    };
    // Listen first, then take what arrived before: a copy finishing in between is never lost.
    void intake.addListener('sharedFiles', (e) => void take(e.files))
      .then(() => intake.takeSharedFiles())
      .then((r) => take(r.files))
      .catch(() => {});
  }
}
