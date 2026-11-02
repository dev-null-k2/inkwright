import {
  DEFAULT_PAPER,
  NO_VALUE,
  PAGE_SIZES,
  VAULT_FORMAT_VERSION,
  type InkPoint,
  type InkStroke,
  type NoteMeta,
  type NotebookMeta,
  type PageInk,
  type VaultManifest,
} from './model.ts';

/**
 * JSON encoding for every vault file. Points are compact arrays `[x, y, t, p?, tilt?, orient?]`
 * (coordinates to 0.01, pressure/angles to 0.001), which makes a page of handwriting 4–8× smaller
 * than objects. Readers fill defaults and ignore unknown fields so the format can grow; writers
 * preserve unknown fields they read (see `extra`).
 */

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => (v < 0 ? v : Math.round(v * 1000) / 1000);

export function encodePoint(p: InkPoint): number[] {
  const out = [r2(p.x), r2(p.y), Math.round(p.t)];
  const hasOrient = p.orient >= 0;
  const hasTilt = p.tilt >= 0 || hasOrient;
  const hasP = p.p >= 0 || hasTilt;
  if (hasP) out.push(r3(p.p));
  if (hasTilt) out.push(r3(p.tilt));
  if (hasOrient) out.push(r3(p.orient));
  return out;
}

export function decodePoint(a: unknown): InkPoint {
  if (!Array.isArray(a) || a.length < 3) throw new Error('InkPoint needs at least [x, y, t]');
  const n = (i: number) => (i < a.length && typeof a[i] === 'number' ? (a[i] as number) : NO_VALUE);
  return { x: Number(a[0]), y: Number(a[1]), t: Number(a[2]), p: n(3), tilt: n(4), orient: n(5) };
}

/** A stroke as written to disk (also what authorship digests hash, so they survive a save). */
export function encodeStroke(s: InkStroke): Record<string, unknown> {
  const o: Record<string, unknown> = { id: s.id, pen: s.pen, color: s.color, size: r3(s.size), createdAt: s.createdAt };
  if (s.shape) o.shape = s.shape;
  if (s.input) o.input = s.input;
  if (s.origin) o.origin = s.origin;
  if (typeof s.nib === 'number') o.nib = r3(s.nib);
  if (s.layer === 'drawing') o.layer = s.layer;
  if (s.author) o.author = { id: s.author.id, name: s.author.name };
  o.points = s.points.map(encodePoint);
  return o;
}

export function decodeStroke(o: any): InkStroke {
  const s: InkStroke = {
    id: String(o.id),
    pen: o.pen ?? 'fountain',
    color: typeof o.color === 'string' ? o.color : '#FF000000',
    size: typeof o.size === 'number' ? o.size : 2,
    points: Array.isArray(o.points) ? o.points.map(decodePoint) : [],
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
  if (o.shape) s.shape = o.shape;
  if (o.input === 'pen' || o.input === 'touch' || o.input === 'mouse') s.input = o.input;
  if (typeof o.origin === 'string') s.origin = o.origin;
  if (typeof o.nib === 'number' && Number.isFinite(o.nib)) s.nib = o.nib;
  if (o.layer === 'drawing') s.layer = 'drawing';
  if (o.author && typeof o.author.id === 'string') s.author = { id: o.author.id, name: typeof o.author.name === 'string' ? o.author.name : '' };
  return s;
}

export function encodePage(p: PageInk): string {
  const o: Record<string, unknown> = { ...p, formatVersion: VAULT_FORMAT_VERSION };
  o.strokes = p.strokes.map(encodeStroke);
  return JSON.stringify(o);
}

export function decodePage(json: string): PageInk {
  const o = JSON.parse(json);
  if (!o || typeof o !== 'object' || typeof o.id !== 'string') throw new Error('Invalid page file');
  return {
    ...o,
    id: o.id,
    strokes: Array.isArray(o.strokes) ? o.strokes.map(decodeStroke) : [],
    formatVersion: typeof o.formatVersion === 'number' ? o.formatVersion : 1,
  };
}

export function encodeNote(n: NoteMeta): string {
  return JSON.stringify({ ...n, formatVersion: VAULT_FORMAT_VERSION }, null, 2);
}

export function decodeNote(json: string): NoteMeta {
  const o = JSON.parse(json);
  if (!o || typeof o.id !== 'string') throw new Error('Invalid note file');
  return {
    ...o,
    id: o.id,
    title: typeof o.title === 'string' ? o.title : 'Untitled',
    kind: o.kind === 'board' ? 'board' : 'paged',
    paper: { ...DEFAULT_PAPER, ...(o.paper ?? {}) },
    pageSize: o.pageSize ?? (o.kind === 'board' ? PAGE_SIZES.INFINITE : PAGE_SIZES.A4),
    pageIds: Array.isArray(o.pageIds) ? o.pageIds.map(String) : [],
    tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    createdAt: Number(o.createdAt ?? 0),
    updatedAt: Number(o.updatedAt ?? o.createdAt ?? 0),
    pinned: Boolean(o.pinned),
    formatVersion: typeof o.formatVersion === 'number' ? o.formatVersion : 1,
  };
}

export function encodeNotebook(n: NotebookMeta): string {
  return JSON.stringify({ ...n, formatVersion: VAULT_FORMAT_VERSION }, null, 2);
}

export function decodeNotebook(json: string): NotebookMeta {
  const o = JSON.parse(json);
  if (!o || typeof o.id !== 'string') throw new Error('Invalid notebook file');
  return {
    ...o,
    id: o.id,
    name: typeof o.name === 'string' ? o.name : 'Notebook',
    color: typeof o.color === 'string' ? o.color : '#FF3D5A80',
    createdAt: Number(o.createdAt ?? 0),
    formatVersion: typeof o.formatVersion === 'number' ? o.formatVersion : 1,
  };
}

export function encodeManifest(m: VaultManifest): string {
  return JSON.stringify(m, null, 2);
}

export function decodeManifest(json: string): VaultManifest {
  const o = JSON.parse(json);
  return { app: o.app ?? 'Inkwright', formatVersion: Number(o.formatVersion ?? 1), createdAt: Number(o.createdAt ?? 0) };
}

/** Relative paths inside a vault. */
export const VaultLayout = {
  MANIFEST: 'inkwright.json',
  NOTES_DIR: 'notes',
  NOTEBOOKS_DIR: 'notebooks',
  noteDir: (noteId: string) => `notes/${noteId}`,
  noteMeta: (noteId: string) => `notes/${noteId}/note.json`,
  noteMarkdown: (noteId: string) => `notes/${noteId}/note.md`,
  pageInk: (noteId: string, pageId: string) => `notes/${noteId}/pages/${pageId}.ink.json`,
  pageSvg: (noteId: string, pageId: string) => `notes/${noteId}/pages/${pageId}.svg`,
  pagesDir: (noteId: string) => `notes/${noteId}/pages`,
  assetsDir: (noteId: string) => `notes/${noteId}/assets`,
  asset: (noteId: string, name: string) => `notes/${noteId}/assets/${name}`,
  notebookMeta: (notebookId: string) => `notebooks/${notebookId}/notebook.json`,
} as const;
