import { segmentLines, type InkGroup, type InkStroke, type RawCandidate, type SymbolRecognizer } from '@inkwright/core';
import { rng, type Written } from './synth.ts';

/**
 * A stand-in for ML Kit Digital Ink's English model, for the eval. ML Kit cannot run off Android,
 * so this reproduces its behaviour as far as it is known (docs/MATH.md, "How the eval models ML
 * Kit"), using the eval's knowledge of which symbol each stroke belongs to:
 *  - one whole symbol → a ranked list of texts drawn from a confusion table: mostly right, with
 *    the confusions a text model makes on maths (+ → t, × → x/X, 1 → l/|, 0 → o, 5 → s, 2 → z,
 *    √ → V, π → n/TT) at the rates below; the top answer is sampled, so sometimes it is wrong.
 *    Digits are wrong about 5% of the time: twice the 2.5% character error rate Google reports
 *    for its production recognizer on IAM-OnDB (Carbune et al. 2020, arXiv:1902.10525), because a
 *    lone symbol has no word context. Operators and √/π are worse — a text model's weak spot;
 *  - several whole symbols → their texts concatenated ("12"), as ML Kit reads multi-character ink;
 *  - part of a symbol → what that fragment looks like (a bar reads "-", a stem "1"), or junk.
 * Scores follow ML Kit's convention (lower = likelier, unnormalised). It is deliberately not the
 * reader's own classifier, and it does not know where symbols are: segmentation, layout and
 * decoding are tested for real; only per-symbol recognition is modelled.
 */
const CONFUSIONS: Record<string, [string, number][]> = {
  '0': [['0', 0.95], ['o', 0.02], ['O', 0.015], ['6', 0.01], ['D', 0.005]],
  '1': [['1', 0.94], ['l', 0.025], ['|', 0.015], ['/', 0.01], ['I', 0.01]],
  '2': [['2', 0.95], ['z', 0.025], ['Z', 0.015], ['a', 0.01]],
  '3': [['3', 0.96], ['B', 0.015], ['}', 0.015], ['5', 0.01]],
  '4': [['4', 0.95], ['y', 0.02], ['A', 0.015], ['9', 0.015]],
  '5': [['5', 0.94], ['s', 0.025], ['S', 0.025], ['3', 0.01]],
  '6': [['6', 0.95], ['b', 0.025], ['G', 0.01], ['0', 0.015]],
  '7': [['7', 0.95], ['1', 0.025], ['>', 0.01], ['?', 0.015]],
  '8': [['8', 0.96], ['B', 0.02], ['&', 0.01], ['g', 0.01]],
  '9': [['9', 0.94], ['g', 0.025], ['q', 0.025], ['4', 0.01]],
  '+': [['+', 0.86], ['t', 0.09], ['f', 0.02], ['x', 0.02], ['†', 0.01]],
  '-': [['-', 0.8], ['—', 0.08], ['_', 0.06], ['~', 0.03], ['.', 0.03]],
  '×': [['x', 0.5], ['X', 0.22], ['×', 0.18], ['+', 0.05], ['y', 0.05]],
  x: [['x', 0.86], ['X', 0.07], ['×', 0.03], ['y', 0.02], ['r', 0.02]],
  y: [['y', 0.9], ['4', 0.03], ['g', 0.03], ['Y', 0.04]],
  '÷': [['÷', 0.72], ['+', 0.12], ['-', 0.08], [':', 0.05], ['t', 0.03]],
  '=': [['=', 0.94], ['-', 0.03], ['z', 0.015], ['二', 0.015]],
  '(': [['(', 0.92], ['C', 0.04], ['c', 0.02], ['<', 0.02]],
  ')': [[')', 0.92], [']', 0.03], ['>', 0.03], ['7', 0.02]],
  '.': [['.', 0.85], [',', 0.1], ["'", 0.05]],
  '√': [['√', 0.45], ['V', 0.3], ['v', 0.15], ['J', 0.1]],
  π: [['π', 0.55], ['n', 0.2], ['TT', 0.15], ['T', 0.1]],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function sample(label: string, r: () => number): RawCandidate[] {
  const table = CONFUSIONS[label] ?? [[label, 0.9], ['?', 0.1]];
  // Draw the top answer from the table, then list the rest by likelihood (ML Kit gives ≤ 10).
  let u = r(), topIdx = 0;
  for (let i = 0; i < table.length; i++) { u -= table[i]![1]; if (u <= 0) { topIdx = i; break; } }
  const rest = table.filter((_, i) => i !== topIdx);
  const ordered = [table[topIdx]!, ...rest];
  return ordered.map(([text, p], i) => ({ text, score: -Math.log(p) * 2 + i * 0.4 + r() * 0.3 }));
}

function boxOf(strokes: InkStroke[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}

/** What a lone fragment of a symbol looks like to a text recognizer. */
function fragment(strokes: InkStroke[], r: () => number): RawCandidate[] {
  const b = boxOf(strokes);
  if (b.h < b.w * 0.3) return [{ text: '-', score: 1 }, { text: '_', score: 1.8 }];
  if (b.w < b.h * 0.3) return [{ text: '1', score: 1 }, { text: 'l', score: 1.5 }, { text: '|', score: 1.9 }];
  return [{ text: ['c', 'r', 'v', 'u', 'n'][Math.floor(r() * 5)]!, score: 2.5 }, { text: 'o', score: 3 }];
}

export function simulatedMlKit(w: Written, seed: number): SymbolRecognizer {
  const byId = new Map(w.strokes.map((s) => [s.id, s]));
  const sym = (i: number) => w.symbols[i]!;
  const top1 = (i: number, r: () => number) => sample(sym(i).label, r)[0]!.text;
  return {
    name: 'ml-kit (simulated)',
    async recognize(groups: readonly InkGroup[]): Promise<RawCandidate[][]> {
      return groups.map((g) => {
        const r = rng(seed ^ hash(g.id));
        const owners = new Set(g.strokes.map((s) => w.owner.get(s.id)!));
        const complete = [...owners].filter((o) => sym(o).strokeIds.every((id) => g.strokes.some((s) => s.id === id)));
        if (owners.size === 1 && complete.length === 1) return sample(sym(complete[0]!).label, r);
        if (complete.length === owners.size) {
          const ordered = complete.sort((a, b) => boxOf(sym(a).strokeIds.map((id) => byId.get(id)!)).minX - boxOf(sym(b).strokeIds.map((id) => byId.get(id)!)).minX);
          const text = ordered.map((o) => top1(o, r)).join('');
          return [{ text, score: 1.2 }, { text: ordered.map((o) => top1(o, r)).join(''), score: 2 }];
        }
        return fragment(g.strokes, r);
      });
    },
  };
}

/**
 * The old reading path, for the "before" numbers: ML Kit read whole lines (segmentLines) as
 * text, flattening structure ("3²" → "32", a stacked fraction → its parts on separate lines or
 * run together), and the solver got that text.
 */
export function simulatedLineText(w: Written, seed: number): string {
  const r = rng(seed ^ 0x51ed);
  const lines = segmentLines(w.strokes);
  return lines.map((l) => {
    const owners = new Set(l.strokes.map((s) => w.owner.get(s.id)!));
    const ordered = [...owners].map((o) => ({ o, x: boxOf(w.symbols[o]!.strokeIds.map((id) => w.strokes.find((s) => s.id === id)!)).minX })).sort((a, b) => a.x - b.x);
    return ordered.map(({ o }) => sample(w.symbols[o]!.label, r)[0]!.text).join('');
  }).join('\n');
}
