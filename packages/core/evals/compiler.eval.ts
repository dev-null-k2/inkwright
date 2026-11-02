import { describe, expect, it } from 'vitest';
import {
  claimFreshness,
  detectConflicts,
  deterministicDraft,
  extractClaims,
  extractSource,
  newNote,
  parseAnchor,
  planWiki,
  sourceHashes,
  stripMarkdown,
  toProvClaims,
  type NoteMeta,
  type PageInk,
  type SourceDoc,
} from '../src/index.ts';
import { CONFLICT_CASES } from './fixtures/conflicts.ts';
import { EVERYDAY_NOTES } from './fixtures/everyday.ts';

/**
 * Context compiler evals (deterministic parts): contradiction precision/recall, staleness
 * detection and anchor correctness. Bars are below; the numbers are printed so changes to the
 * rules show their effect. The model-facing parts (draft validation against a noisy scripted
 * model, live models) are in packages/ai/evals/compiler.eval.ts.
 */
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
let n = 0;
function note(text: string | string[], tags: string[] = []): { meta: NoteMeta; pages: PageInk[] } {
  const id = `E${String(++n).padStart(5, '0')}`;
  const meta = newNote({ id, title: `Note ${n}`, pageId: `${id}p`, now: T0, tags });
  const boxes = Array.isArray(text) ? text : [text];
  return { meta, pages: [{ id: `${id}p`, strokes: [], formatVersion: 2, texts: boxes.map((t, i) => ({ id: `${id}t${i}`, x: 60, y: 60 + i * 120, width: 600, text: t, fontSize: 16, color: '#FF000000', font: 'sans' as const, createdAt: T0 })) }] };
}
const doc = (x: { meta: NoteMeta; pages: PageInk[] }): SourceDoc => extractSource(x.meta, x.pages);
const out = (s: string) => (globalThis as { process?: { stdout?: { write(s: string): unknown } } }).process?.stdout?.write(s + '\n');

describe('contradiction linter', () => {
  it('pairwise: precision ≥ 0.95 and recall ≥ 0.8 at the default threshold', () => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    const misses: string[] = [];
    for (const c of CONFLICT_CASES) {
      const tags = c.sameTag ? ['project'] : [];
      const claims = [...extractClaims(doc(note(c.a, tags))), ...extractClaims(doc(note(c.b, tags)))];
      const found = detectConflicts(claims).length > 0;
      if (found && c.conflict) tp++;
      else if (found) { fp++; misses.push(`  false alarm: "${c.a}" / "${c.b}"`); }
      else if (c.conflict) { fn++; misses.push(`  missed${c.hard ? ' (hard)' : ''}: "${c.a}" / "${c.b}"`); }
      else tn++;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    out(`\nContradictions (pairwise, ${CONFLICT_CASES.length} pairs): precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)} (tp ${tp}, fp ${fp}, fn ${fn}, tn ${tn})\n${misses.join('\n')}`);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  it('noise floor: a realistic vault with many numbers and no contradictions gets at most one false alarm', () => {
    const docs = EVERYDAY_NOTES.map(([title, tags, lines]) => { const x = note(lines.join('\n'), tags); x.meta.title = title; return doc(x); });
    const claims = docs.flatMap((d) => extractClaims(d));
    const conflicts = detectConflicts(claims);
    out(`Noise floor (${docs.length} everyday notes, ${claims.length} claims): ${conflicts.length} reported\n${conflicts.map((c) => `  ${c.confidence.toFixed(2)} "${stripMarkdown(c.a.text)}" / "${stripMarkdown(c.b.text)}"`).join('\n')}`);
    expect(claims.length).toBeGreaterThan(60);
    expect(conflicts.length).toBeLessThanOrEqual(1);
  });
});

describe('staleness', () => {
  it('flags exactly the claims whose sources were edited or erased (moves and untouched notes stay fresh)', () => {
    const notes = Array.from({ length: 30 }, (_, i) => note([`Fact ${i} alpha is ${i + 10} ms.`, `Fact ${i} beta is the ${['first', 'second', 'third'][i % 3]} option.`, `Fact ${i} gamma stays.`]));
    const docs = notes.map(doc);
    const plan = planWiki(docs);
    const claims = docs.flatMap((d) => d.units).map((u) => ({ unit: u, claim: toProvClaims([{ text: u.text, tag: 'E', units: [u.id] }], plan.units)[0]! }));
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const expected = new Map<string, 'fresh' | 'stale' | 'missing'>();
    const trashed = new Set<string>();
    notes.forEach((nt, i) => {
      const r = rnd();
      const page = nt.pages[0]!;
      if (r < 0.2) {
        page.texts![0]!.text = page.texts![0]!.text.replace(/\d+ ms/, '999 ms');
        expected.set(`${nt.meta.id}:0`, 'stale');
      } else if (r < 0.35) {
        page.texts = page.texts!.filter((_, k) => k !== 1);
        expected.set(`${nt.meta.id}:1`, 'stale');
      } else if (r < 0.5) {
        page.texts!.forEach((t) => (t.y += 300)); // moved: same sentences
      } else if (r < 0.58) {
        trashed.add(nt.meta.id);
      }
      void i;
    });
    const now = new Map(notes.map((nt) => [nt.meta.id, trashed.has(nt.meta.id) ? null : sourceHashes(doc(nt))]));
    let correct = 0, total = 0, tp = 0, fp = 0, fn = 0;
    for (const { unit, claim } of claims) {
      const box = Number(unit.textId!.split('t').pop());
      const want = trashed.has(unit.noteId) ? 'missing' : expected.get(`${unit.noteId}:${box}`) ?? 'fresh';
      const got = claimFreshness(claim, (id) => now.get(id) ?? null);
      total++;
      if (got === want) correct++;
      if (got !== 'fresh' && want !== 'fresh') tp++;
      else if (got !== 'fresh') fp++;
      else if (want !== 'fresh') fn++;
    }
    out(`Staleness (${total} claims over ${notes.length} notes): accuracy ${(correct / total).toFixed(3)}, precision ${(tp / Math.max(1, tp + fp)).toFixed(3)}, recall ${(tp / Math.max(1, tp + fn)).toFixed(3)}`);
    expect(correct / total).toBe(1);
  });
});

describe('anchors', () => {
  it('every EXTRACTED claim of a deterministic draft points at a sentence on its page that says it', () => {
    const docs = Array.from({ length: 12 }, (_, i) => doc(note([`# Topic ${i % 3}\nLatency must stay under ${40 + i} ms.\nEmbedding ${i}: a vector for item ${i}.`, `Owner ${i} reviewed it on Dec ${i + 1}.`], [`t${i % 4}`])));
    const plan = planWiki(docs);
    let checked = 0, right = 0;
    for (const page of plan.pages) {
      for (const c of toProvClaims(deterministicDraft(page, plan.units, plan.conflicts), plan.units)) {
        if (c.t !== 'E') continue;
        for (const s of c.src) {
          checked++;
          const a = parseAnchor(s)!;
          const unit = [...plan.units.values()].find((u) => u.noteId === a.noteId && u.hash === a.h && u.pageIndex === a.page);
          if (unit && unit.rect && a.rect && Math.abs(unit.rect.minY - a.rect.minY) < 0.2 && stripMarkdown(c.s).includes(stripMarkdown(unit.text).replace(/\.$/, '').slice(0, 20))) right++;
        }
      }
    }
    out(`Anchors: ${right}/${checked} EXTRACTED sources resolve to the right sentence and place`);
    expect(checked).toBeGreaterThan(30);
    expect(right).toBe(checked);
  });
});
