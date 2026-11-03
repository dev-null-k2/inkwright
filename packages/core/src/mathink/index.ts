import type { InkStroke } from '../model.ts';
import { builtInRecognizer } from './classifier.ts';
import { decode, linearize, toLatex, toPlain } from './decode.ts';
import { flattenScripts, parseLayout } from './layout.ts';
import { segmentSymbols, splitGroup, type SymbolGroup } from './segment.ts';
import { fromRanked, fuseWithShape } from './symbols.ts';
import type { InkGroup, MathInkReading, MathSymbol, RawCandidate, SymbolRecognizer } from './types.ts';

export * from './types.ts';
export { segmentSymbols, splitGroup, type SymbolGroup, type Segmentation, type GroupShape } from './segment.ts';
export { parseLayout, parseRow, flattenScripts, isBarSymbol, isRadicalSymbol } from './layout.ts';
export { decode, linearize, toLatex, toPlain, type Tok } from './decode.ts';
export { aliasesOf, fromRanked, fuseWithShape } from './symbols.ts';
export { builtInRecognizer, classifySymbol } from './classifier.ts';
export { strokeInfos, referenceHeight, primitiveOf, looksLikeRadical } from './features.ts';

/**
 * Reads handwritten maths from strokes — deterministic, on-device, no pictures:
 *   strokes → symbols (segment.ts) → candidates (a SymbolRecognizer, fused with geometry)
 *   → 2-D structure (layout.ts) → the most likely valid reading (decode.ts) → plain + LaTeX.
 * See docs/MATH.md for the design and the measured accuracy.
 */
export async function readMathInk(strokes: readonly InkStroke[], recognizer: SymbolRecognizer = builtInRecognizer): Promise<MathInkReading> {
  const empty: MathInkReading = { plain: '', latex: '', confidence: 0, weakest: 0, engine: recognizer.name, symbols: [], lines: [] };
  const seg = segmentSymbols(strokes);
  if (!seg.groups.length) return empty;
  const all = seg.groups.reduce((r, g) => ({ minX: Math.min(r.minX, g.bounds.minX), minY: Math.min(r.minY, g.bounds.minY), maxX: Math.max(r.maxX, g.bounds.maxX), maxY: Math.max(r.maxY, g.bounds.maxY) }), seg.groups[0]!.bounds);
  const area = { width: Math.max(1, all.maxX - all.minX), height: Math.max(1, Math.min(all.maxY - all.minY, seg.ref * 2.2)) };

  // Geometry decides plain marks (bars, dots, "=", "÷", √) on its own; the recognizer sees the rest
  // and the ambiguous ones (a "+" or "×" made of two straight strokes).
  const certain = new Set(['dot', 'hline', 'equals', 'divide', 'radical']);
  const ask = seg.groups.filter((g) => !g.shape || !certain.has(g.shape));
  const raw = ask.length ? await recognizer.recognize(ask.map(toInkGroup), area) : [];
  const rawById = new Map<string, RawCandidate[]>(ask.map((g, i) => [g.id, raw[i] ?? []]));

  // A group read as several characters is probably several symbols that touch: split and re-read.
  const groups: SymbolGroup[] = [];
  const retry: { at: number; parts: SymbolGroup[] }[] = [];
  for (const g of seg.groups) {
    const top = (rawById.get(g.id) ?? [])[0]?.text.replace(/\s+/g, '') ?? '';
    const n = [...top].length;
    const parts = n >= 2 && n <= 4 && !['TT', 'Tt', 'tt', '11'].includes(top) ? splitGroup(g, n) : null;
    if (parts) retry.push({ at: groups.length, parts });
    groups.push(g);
  }
  if (retry.length) {
    const flat = retry.flatMap((r) => r.parts);
    const again = await recognizer.recognize(flat.map(toInkGroup), area);
    let k = 0;
    const replaced: SymbolGroup[] = [];
    const byAt = new Map(retry.map((r) => [r.at, r]));
    groups.forEach((g, i) => {
      const r = byAt.get(i);
      if (!r) return void replaced.push(g);
      const res = r.parts.map(() => again[k++] ?? []);
      // Keep the split only if every part now reads as a single symbol.
      if (res.every((c) => [...(c[0]?.text.replace(/\s+/g, '') ?? '')].length === 1)) {
        r.parts.forEach((p, j) => { rawById.set(p.id, res[j]!); replaced.push(p); });
      } else replaced.push(g);
    });
    groups.splice(0, groups.length, ...replaced);
  }

  const symbols: MathSymbol[] = groups.map((g) => ({
    id: g.id,
    strokeIds: g.strokes.map((s) => s.id),
    bounds: g.bounds,
    shape: g.shape,
    cands: fuseWithShape(fromRanked(rawById.get(g.id) ?? []), g.shape),
  })).filter((s) => s.cands.length);
  if (!symbols.length) return empty;

  const lines = parseLayout(symbols, seg.ref);
  const best = decode(linearize(lines)) ?? decode(linearize(flattenScripts(lines)));
  if (!best) return { ...empty, symbols, lines };
  return {
    plain: toPlain(best.toks),
    latex: toLatex(best.toks),
    confidence: best.confidence,
    weakest: best.weakest,
    engine: recognizer.name,
    symbols,
    lines,
  };
}

function toInkGroup(g: SymbolGroup): InkGroup {
  return { id: g.id, strokes: g.strokes, bounds: g.bounds };
}
