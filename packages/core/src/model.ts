/**
 * Inkstone's portable data model. Everything a user creates is plain JSON in a "vault" folder
 * (see docs/VAULT_FORMAT.md), so it syncs through any folder sync and is readable by other tools
 * and AI agents. Units: 1 page unit = 1/96 inch (CSS px at 100%).
 */

import type { PageObject } from './objects.ts';
import type { PageAuthorship } from './authorship.ts';

export type { PageObject };

/** Current on-disk format version. Readers accept older versions and ignore unknown fields. */
export const VAULT_FORMAT_VERSION = 2;

export type PenType = 'fountain' | 'ballpoint' | 'pencil' | 'marker' | 'highlighter' | 'dashed' | 'brush' | 'calligraphy';

export const PEN_TYPES: readonly PenType[] = ['fountain', 'ballpoint', 'pencil', 'brush', 'calligraphy', 'marker', 'highlighter', 'dashed'];

export const PEN_INFO: Record<PenType, { name: string; isHighlighter: boolean; defaultSize: number }> = {
  fountain: { name: 'Fountain pen', isHighlighter: false, defaultSize: 2.6 },
  ballpoint: { name: 'Ballpoint', isHighlighter: false, defaultSize: 1.8 },
  pencil: { name: 'Pencil', isHighlighter: false, defaultSize: 2.2 },
  brush: { name: 'Brush pen', isHighlighter: false, defaultSize: 6 },
  marker: { name: 'Marker', isHighlighter: false, defaultSize: 5 },
  highlighter: { name: 'Highlighter', isHighlighter: true, defaultSize: 16 },
  dashed: { name: 'Dashed line', isHighlighter: false, defaultSize: 2 },
  calligraphy: { name: 'Calligraphy pen', isHighlighter: false, defaultSize: 7 },
};

/** Default nib angle of the calligraphy pen, degrees clockwise from the page's x axis (italic hands use 30–45°). */
export const DEFAULT_NIB_ANGLE = 40;

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
  /**
   * How a stroke written in Inkstone was made: stylus, finger or mouse. Set by the ink engine
   * when the stroke is drawn; absent for strokes from older versions or created by code.
   */
  input?: StrokeInput;
  /** Where the stroke came from when it was not written by hand (see `ContentOrigin`). */
  origin?: ContentOrigin;
  /**
   * Calligraphy pen only: the broad nib's angle in degrees, clockwise from the page's x axis.
   * Stored per stroke so every renderer and export draws the same thick and thin strokes.
   */
  nib?: number;
  /** The page layer the stroke is on (see `PageLayers`); absent = the writing layer. */
  layer?: StrokeLayer;
  /**
   * Set when someone else wrote it in a live session (docs/COLLABORATION.md): never counted as
   * this vault owner's handwriting. Stamped by the receiving device, not taken from the sender.
   */
  author?: ItemAuthor;
}

/** A live collaborator who wrote or changed an item (see `InkStroke.author`). */
export interface ItemAuthor {
  /** Stable id of the collaborator's device key (short fingerprint). */
  id: string;
  /** The name they gave; shown, never trusted. */
  name: string;
}

/**
 * Lightweight layers: strokes are on the writing layer (default) or the drawing layer, which is
 * drawn underneath. Each layer can be hidden or locked per page (`PageInk.layers`).
 */
export type StrokeLayer = 'writing' | 'drawing';

/** Per-page layer state. Hidden layers are not drawn or exported; locked ones can't be erased, selected or scratched out. */
export interface PageLayers {
  writing?: { hidden?: boolean; locked?: boolean };
  drawing?: { hidden?: boolean; locked?: boolean };
}

export type StrokeInput = 'pen' | 'touch' | 'mouse';

/**
 * Where a piece of content came from, so it can never be mistaken for handwriting (see
 * docs/AUTHORSHIP.md). Absent means "made by the user in the app" (handwriting for strokes,
 * typing for text boxes).
 *  - `ai`: written by an AI model (assistant text, AI ink, AI-solved results).
 *  - `solver`: computed on the device by the maths engine (no AI involved).
 *  - `recognized`: machine transcription of the user's own handwriting.
 *  - `import`: brought in from a file (images, PDF pages, pasted pictures).
 */
export type ContentOrigin = 'ai' | 'solver' | 'recognized' | 'import';

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
  /** Set when the text was not typed by the user (AI answer, recognized handwriting…). */
  origin?: ContentOrigin;
  /** Typed by a live collaborator (see `InkStroke.author`). */
  author?: ItemAuthor;
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
  /** Images are imported (`import`) or generated (`ai`); never handwriting. */
  origin?: ContentOrigin;
}

/** A page whose background is an imported document page (PDF annotation) or an image. */
export interface PageBackground {
  kind: 'pdf' | 'image';
  asset: string;
  /** 1-based page number inside a PDF asset. */
  pageNumber?: number;
  /**
   * Extra clockwise rotation (degrees, a multiple of 90) applied on top of the source page's own
   * orientation (a PDF page's /Rotate). Set by "Rotate page"; the page's `size` is already swapped.
   */
  rotation?: number;
}

/**
 * Handwriting that links to another note: the user lassoed ink and chose "Link to note…", or
 * recognized handwriting contained `[[…]]`. The ink stays ink; the link rides on top of it.
 * `target` is a wiki-link target (`Title`, `Title#Page 2`), `noteId` the note it resolved to when
 * the link was made, so renaming the target never breaks it.
 */
export interface InkLink {
  id: string;
  strokeIds: string[];
  target: string;
  noteId?: string;
  createdAt: number;
}

/** Content of one page file. */
export interface PageInk {
  id: string;
  strokes: InkStroke[];
  texts?: TextBox[];
  images?: ImageItem[];
  background?: PageBackground;
  /** Links carried by handwriting on this page (see `InkLink`). */
  links?: InkLink[];
  /** Per-page overrides (e.g. imported PDF pages with their own size). */
  paper?: PaperSpec;
  size?: PageSize;
  /** Text recognized from handwriting on this page (search, Markdown, agents). */
  recognizedText?: string;
  recognizedAt?: number;
  recognizedBy?: string;
  /**
   * Live objects on the page made from ink: tables, solved equations, function graphs
   * (see objects.ts). Drawn under the ink so handwriting in a table cell sits on top.
   */
  objects?: PageObject[];
  /** Append-only hash chain of content events, for authorship certificates (authorship.ts). */
  authorship?: PageAuthorship;
  /**
   * Where each recognized line sits on the page, when the recognizer worked line by line. Lets
   * search results and AI citations point at the exact handwriting, not just the page.
   */
  recognizedLines?: RecognizedLine[];
  /** Hide/lock state of the page's writing and drawing layers (see `StrokeLayer`). */
  layers?: PageLayers;
  /**
   * Present only in the files of a locked note: the page's real content, encrypted (lock.ts).
   * The visible fields of such a file are empty, so tools that don't know about locks see a
   * blank page instead of the content.
   */
  sealed?: SealedBox;
  formatVersion: number;
}

/** AES-GCM ciphertext (base64) with its 96-bit IV (base64). */
export interface SealedBox {
  v: 1;
  iv: string;
  data: string;
}

/**
 * A note locked with a passcode (lock.ts, docs/PRIVACY.md): its pages, assets, version history
 * and sensitive metadata are encrypted with a key derived from the passcode.
 */
export interface NoteLock {
  v: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: 'AES-GCM-256';
  /** A known value encrypted with the key: proves a passcode right without decrypting pages. */
  check: SealedBox;
  /** Encrypted metadata that would otherwise reveal content (summary, form values, properties). */
  meta?: SealedBox;
  lockedAt: number;
}

/** One line of recognized handwriting: its text, the strokes it came from and their bounds (page units). */
export interface RecognizedLine {
  text: string;
  strokeIds: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
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
  /**
   * Values typed into the AcroForm fields of imported PDFs ("Fill & sign"), per PDF asset name,
   * then per fully-qualified field name. The PDF asset itself is never modified; values are
   * written into a copy on export. See `FormFieldValue`.
   */
  forms?: Record<string, Record<string, FormFieldValue>>;
  /**
   * Tags that came from `#tags` written or typed in the note (kept in `tags` too). Remembered
   * separately so deleting the `#tag` from the page removes it again without touching tags the
   * user added by hand.
   */
  inlineTags?: string[];
  /** Set on daily notes ("Today"): the local calendar day, `YYYY-MM-DD`. */
  daily?: string;
  /**
   * Front-matter properties brought in from Markdown/Obsidian that Inkstone has no field for
   * (`aliases`, `status`, …). Kept as-is and written back on Obsidian export.
   */
  properties?: Record<string, unknown>;
  /**
   * The latest signed authorship certificate of this note (a JSON file in `assets/`), so the
   * "Verified handwriting" panel can show what changed since it was signed.
   */
  certificate?: { asset: string; signedAt: number };
  /** Set while the note is locked with a passcode (see `NoteLock`). */
  lock?: NoteLock;
  /**
   * Code links (`[[code:path#Symbol]]`, typed or on ink) and the signature each was written or
   * last reviewed against, keyed `path#Symbol`. A re-scan whose signature differs flags drift
   * (packages/core/src/dev/drift.ts). Optional; see docs/VAULT_FORMAT.md › Code sources.
   */
  codeRefs?: Record<string, CodeRefBaseline>;
  formatVersion: number;
}

/**
 * The value of one PDF form field: text (text fields, single-choice lists and dropdowns), the
 * selected state name of a radio group (or "Off"), a checkbox's checked state, or the selected
 * export values of a multi-select list.
 */
export type FormFieldValue = string | boolean | string[];

/** What a code link was written (or last reviewed) against: see `NoteMeta.codeRefs`. */
export interface CodeRefBaseline {
  /** The symbol's signature hash then (`CodeSymbol.hash`). */
  hash: string;
  /** The signature then, so drift can show old and new side by side. */
  signature: string;
  /** The code source it resolved in. */
  sourceId?: string;
  /** When the link was first seen with this symbol (epoch ms). */
  linkedAt: number;
  /** When the user last marked the link reviewed after a change. */
  reviewedAt?: number;
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
