import type { Rect } from '../geometry.ts';
import type { InkStroke } from '../model.ts';

/**
 * Shared types of the handwritten-maths reader (see docs/MATH.md).
 *
 * The reader works on strokes, not pictures: strokes are grouped into symbols, each symbol gets a
 * ranked list of candidate labels from a recognizer (ML Kit Digital Ink on Android, the browser's
 * Handwriting Recognition API, or the built-in template classifier), a layout parser turns the
 * 2-D arrangement into structure (fractions, powers, roots, lines) and a decoder picks the most
 * likely reading that is also valid maths.
 */

/** One recognizer hypothesis for a symbol: a canonical label and a probability-like weight in (0, 1]. */
export interface SymbolCandidate {
  label: string;
  p: number;
}

/** What a recognizer engine returns for one ink, in its own terms (ML Kit: lower score = better). */
export interface RawCandidate {
  text: string;
  /** Engine score when it has one. ML Kit: lower is more likely, any sign; see `fromRanked`. */
  score?: number | null;
}

/** A group of strokes believed to be one written symbol. */
export interface InkGroup {
  id: string;
  strokes: InkStroke[];
  bounds: Rect;
}

/**
 * Recognizes symbol groups. `area` is the size of the expression being read (page units), so an
 * engine that judges size (ML Kit's WritingArea) can tell "o" from "O" and "-" from "_".
 */
export interface SymbolRecognizer {
  /** Stable engine id: 'ml-kit' | 'browser' | 'built-in' | a test stub's name. */
  readonly name: string;
  recognize(groups: readonly InkGroup[], area: { width: number; height: number }): Promise<RawCandidate[][]>;
}

/** A recognised symbol on the page: its strokes, box and candidates (best first). */
export interface MathSymbol {
  id: string;
  strokeIds: string[];
  bounds: Rect;
  cands: SymbolCandidate[];
  /** The geometric primitive, when the strokes are one ('hline', 'dot', …): see primitives.ts. */
  shape?: string;
}

/** The 2-D structure the layout parser finds. */
export type LayoutNode =
  | { k: 'sym'; sym: MathSymbol; sup?: LayoutRow; sub?: LayoutRow }
  | { k: 'frac'; bar: MathSymbol; num: LayoutRow; den: LayoutRow; bounds: Rect; sup?: LayoutRow }
  | { k: 'sqrt'; sign: MathSymbol; body: LayoutRow; bounds: Rect; sup?: LayoutRow };

export interface LayoutRow {
  items: LayoutNode[];
  bounds: Rect;
}

/** The result of reading handwritten maths. */
export interface MathInkReading {
  /** ASCII maths the solver parses ("2x+3=7"; one equation per line for systems). Empty if nothing was read. */
  plain: string;
  latex: string;
  /** Geometric mean of the chosen candidates' weights, 0..1: how sure the reader is. */
  confidence: number;
  /** The weakest symbol's weight (one bad symbol is enough to misread a problem). */
  weakest: number;
  /** Which engine read the symbols. */
  engine: string;
  symbols: MathSymbol[];
  lines: LayoutRow[];
}
