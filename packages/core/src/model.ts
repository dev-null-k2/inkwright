/**
 * Inkstone's portable data model. Everything a user creates is plain JSON in a "vault" folder
 * (see docs/VAULT_FORMAT.md), so it syncs through any folder sync and is readable by other tools
 * and AI agents. Units: 1 page unit = 1/96 inch (CSS px at 100%).
 */

/** Current on-disk format version. Readers accept older versions and ignore unknown fields. */
export const VAULT_FORMAT_VERSION = 2;

export type PenType = 'fountain' | 'ballpoint' | 'pencil' | 'marker' | 'highlighter' | 'dashed' | 'brush';

export const PEN_TYPES: readonly PenType[] = ['fountain', 'ballpoint', 'pencil', 'brush', 'marker', 'highlighter', 'dashed'];

export const PEN_INFO: Record<PenType, { name: string; isHighlighter: boolean; defaultSize: number }> = {
  fountain: { name: 'Fountain pen', isHighlighter: false, defaultSize: 2.6 },
  ballpoint: { name: 'Ballpoint', isHighlighter: false, defaultSize: 1.8 },
  pencil: { name: 'Pencil', isHighlighter: false, defaultSize: 2.2 },
  brush: { name: 'Brush pen', isHighlighter: false, defaultSize: 6 },
  marker: { name: 'Marker', isHighlighter: false, defaultSize: 5 },
  highlighter: { name: 'Highlighter', isHighlighter: true, defaultSize: 16 },
  dashed: { name: 'Dashed line', isHighlighter: false, defaultSize: 2 },
};

/** Sentinel for "not reported by the device" (pressure, tilt, orientation). */
export const NO_VALUE = -1;

/**
 * One sampled input point in page units. `t` is ms since stroke start. `p` is pressure 0..1,
 * `tilt` radians from vertical (0..π/2), `orient` radians (0..2π); each is -1 when unknown.
 */
export interface InkPoint {
  x: number;
  y: number;
  t: number;
  p: number;
  tilt: number;
  orient: number;
}

export type ShapeKind = 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'triangle' | 'polygon';

/** A finished stroke. Geometry is the raw input; how it looks is derived from pen + size. */
export interface InkStroke {
  id: string;
  pen: PenType;
  /** `#AARRGGBB`. */
  color: string;
  /** Nominal tip size in page units. */
  size: number;
  points: InkPoint[];
  /** Wall-clock creation time (epoch ms). Lines strokes up with audio recordings and agents. */
  createdAt: number;
  /** Set when the stroke was snapped to a geometric shape. */
  shape?: ShapeKind;
}

export type NoteKind = 'paged' | 'board';

export type PaperStyle =
  | 'blank'
  | 'ruled_narrow'
  | 'ruled_wide'
  | 'dot_grid'
  | 'square_grid'
  | 'graph_mm'
  | 'isometric'
  | 'cornell'
  | 'music'
  | 'planner_day'
  | 'planner_week'
  | 'todo';

export const PAPER_STYLES: Record<PaperStyle, { name: string; defaultSpacing: number }> = {
  blank: { name: 'Blank', defaultSpacing: 0 },
  ruled_narrow: { name: 'College ruled', defaultSpacing: 26.8 },
  ruled_wide: { name: 'Wide ruled', defaultSpacing: 32.6 },
  dot_grid: { name: 'Dot grid', defaultSpacing: 18.9 },
  square_grid: { name: 'Square grid', defaultSpacing: 18.9 },
  graph_mm: { name: 'Engineering (mm)', defaultSpacing: 3.78 },
  isometric: { name: 'Isometric', defaultSpacing: 22.7 },
  cornell: { name: 'Cornell', defaultSpacing: 26.8 },
  music: { name: 'Music staff', defaultSpacing: 9 },
  planner_day: { name: 'Daily planner', defaultSpacing: 26.8 },
  planner_week: { name: 'Weekly planner', defaultSpacing: 26.8 },
  todo: { name: 'To-do list', defaultSpacing: 32.6 },
};

export type PaperTint = 'white' | 'ivory' | 'cream' | 'recycled' | 'kraft' | 'mint' | 'blush' | 'slate' | 'midnight';

export const PAPER_TINTS: Record<PaperTint, { name: string; color: string; dark: boolean }> = {
  white: { name: 'White', color: '#FFFFFFFF', dark: false },
  ivory: { name: 'Ivory', color: '#FFFFFDF5', dark: false },
  cream: { name: 'Cream', color: '#FFFBF3E2', dark: false },
  recycled: { name: 'Recycled', color: '#FFEFEDE6', dark: false },
  kraft: { name: 'Kraft', color: '#FFE7D7BC', dark: false },
  mint: { name: 'Mint', color: '#FFEEF6EF', dark: false },
  blush: { name: 'Blush', color: '#FFFBEFEC', dark: false },
  slate: { name: 'Slate', color: '#FF22262B', dark: true },
  midnight: { name: 'Midnight', color: '#FF101521', dark: true },
};

/** Surface texture: drives haptic grain spacing, writing-sound timbre and the visual grain. */
export type PaperTexture = 'smooth' | 'standard' | 'toothy';

export const PAPER_TEXTURES: Record<PaperTexture, { name: string }> = {
  smooth: { name: 'Smooth (coated)' },
  standard: { name: 'Standard' },
  toothy: { name: 'Toothy (sketch)' },
};

export interface PaperSpec {
  style: PaperStyle;
  tint: PaperTint;
  texture: PaperTexture;
  /** Line/grid spacing in page units; 0 = the style's default. */
  spacing: number;
}

export const DEFAULT_PAPER: PaperSpec = { style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: 0 };

export function effectiveSpacing(p: PaperSpec): number {
  return p.spacing > 0 ? p.spacing : (PAPER_STYLES[p.style]?.defaultSpacing ?? 0);
}

/** Page size in page units. width/height 0 = unbounded (boards). */
export interface PageSize {
  name: string;
  width: number;
  height: number;
}

export const PAGE_SIZES = {
  A4: { name: 'A4', width: 793.7, height: 1122.5 },
  LETTER: { name: 'Letter', width: 816, height: 1056 },
  LEGAL: { name: 'Legal', width: 816, height: 1344 },
  A5: { name: 'A5', width: 559.4, height: 793.7 },
  B5: { name: 'B5', width: 665.2, height: 944.9 },
  A3: { name: 'A3', width: 1122.5, height: 1587.4 },
  INDEX_CARD: { name: 'Index card', width: 480, height: 288 },
  PHONE: { name: 'Phone', width: 600, height: 1066 },
  WIDESCREEN: { name: '16:9 slide', width: 1280, height: 720 },
  INFINITE: { name: 'Infinite', width: 0, height: 0 },
} as const satisfies Record<string, PageSize>;

export const PAGE_SIZE_PRESETS: PageSize[] = [
  PAGE_SIZES.A4, PAGE_SIZES.LETTER, PAGE_SIZES.LEGAL, PAGE_SIZES.A5, PAGE_SIZES.B5, PAGE_SIZES.A3,
  PAGE_SIZES.INDEX_CARD, PAGE_SIZES.PHONE, PAGE_SIZES.WIDESCREEN,
];

export function isInfinite(s: PageSize): boolean {
  return s.width <= 0 || s.height <= 0;
}

export type FontFamily = 'sans' | 'serif' | 'mono' | 'hand';

/** A typed text block placed on a page. `text` is Markdown (supports [[wiki links]]). */
export interface TextBox {
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
  color: string;
  font: FontFamily;
  createdAt: number;
}

/** An image placed on a page; the bytes live in the note's assets folder. */
export interface ImageItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** File name inside `notes/<id>/assets/`. */
  asset: string;
  rotation: number;
  createdAt: number;
}

/** A page whose background is an imported document page (PDF annotation) or an image. */
export interface PageBackground {
  kind: 'pdf' | 'image';
  asset: string;
  /** 1-based page number inside a PDF asset. */
  pageNumber?: number;
}

/** Content of one page file. */
export interface PageInk {
  id: string;
  strokes: InkStroke[];
  texts?: TextBox[];
  images?: ImageItem[];
  background?: PageBackground;
  /** Per-page overrides (e.g. imported PDF pages with their own size). */
  paper?: PaperSpec;
  size?: PageSize;
  /** Text recognized from handwriting on this page (search, Markdown, agents). */
  recognizedText?: string;
  recognizedAt?: number;
  recognizedBy?: string;
  formatVersion: number;
}

/** An audio recording made while writing. Strokes' `createdAt` lines up with `startedAt`. */
export interface AudioClip {
  id: string;
  asset: string;
  startedAt: number;
  durationMs: number;
  mimeType: string;
  title?: string;
}

export interface NoteMeta {
  id: string;
  title: string;
  kind: NoteKind;
  paper: PaperSpec;
  pageSize: PageSize;
  /** Ordered page ids. A board has exactly one page. */
  pageIds: string[];
  notebookId?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** Optional accent for the library card, `#AARRGGBB`. */
  color?: string;
  recordings?: AudioClip[];
  /** Short AI-written summary shown in the library and given to agents. */
  summary?: string;
  /** Soft-deleted notes go to Trash and are purged after 30 days. */
  trashedAt?: number;
  formatVersion: number;
}

export interface NotebookMeta {
  id: string;
  name: string;
  /** Cover color `#AARRGGBB`. */
  color: string;
  /** Nested notebooks (sections). */
  parentId?: string;
  createdAt: number;
  formatVersion: number;
}

export interface VaultManifest {
  app: string;
  formatVersion: number;
  createdAt: number;
}

// ---- Constructors --------------------------------------------------------------------------

export function point(x: number, y: number, t: number, p = NO_VALUE, tilt = NO_VALUE, orient = NO_VALUE): InkPoint {
  return { x, y, t, p, tilt, orient };
}

export function hasPressure(p: InkPoint): boolean {
  return p.p >= 0;
}

export function newPage(id: string): PageInk {
  return { id, strokes: [], formatVersion: VAULT_FORMAT_VERSION };
}

export function newNote(args: {
  id: string;
  title: string;
  pageId: string;
  now: number;
  kind?: NoteKind;
  paper?: PaperSpec;
  pageSize?: PageSize;
  notebookId?: string;
  tags?: string[];
}): NoteMeta {
  const kind = args.kind ?? 'paged';
  return {
    id: args.id,
    title: args.title,
    kind,
    paper: args.paper ?? DEFAULT_PAPER,
    pageSize: kind === 'board' ? PAGE_SIZES.INFINITE : (args.pageSize ?? PAGE_SIZES.A4),
    pageIds: [args.pageId],
    notebookId: args.notebookId,
    tags: args.tags ?? [],
    createdAt: args.now,
    updatedAt: args.now,
    pinned: false,
    formatVersion: VAULT_FORMAT_VERSION,
  };
}

/** Effective paper/size for a page, honoring per-page overrides. */
export function pagePaper(note: NoteMeta, page: PageInk | undefined): PaperSpec {
  return page?.paper ?? note.paper;
}

export function pageSizeOf(note: NoteMeta, page: PageInk | undefined): PageSize {
  return page?.size ?? note.pageSize;
}
