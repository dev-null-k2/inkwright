import { describe, expect, it } from 'vitest';
import { extractSource, newNote, planWiki, stripMarkdown, type ProvTag, type SourceDoc } from '@inkstone/core';
import { createScriptedProvider, draftPage, pagePrompt, type CompilerAI } from '../src/index.ts';
import { liveConfig, printReport } from './harness.ts';

/**
 * Compiler eval: what reaches the user after a model drafts a page. A scripted "noisy" model
 * writes the kinds of sentences small models really produce — faithful quotes, paraphrases
 * mislabelled as quotes, invented facts, wrong numbers, wrong citations, unflagged
 * disagreements — each with a gold label (keep with tag E/I/A, or must not be shown). The draft
 * goes through the real pipeline (`draftPage` → `validateDraft`) and is scored on:
 *   - provenance precision: kept sentences that are really supported by what they cite (≥ 0.9)
 *   - unsupported pass-through: sentences that should have been dropped but were shown (≤ 0.25)
 *   - recall of good sentences (≥ 0.85) and tag accuracy among them (≥ 0.85)
 * Some gold labels are deliberately beyond a lexical check (an inference that sounds like a
 * quote; a plausible but unsupported link between two sources), so the numbers are honest about
 * what validation can and can't catch. With INKSTONE_EVAL_PROVIDER/KEY/MODEL set, the same pages
 * are drafted by a real model and its validation report is printed.
 */
type Gold = { text: string; sources: string[]; tag: string; gold: ProvTag | 'drop' };

const PAGES: Array<{ title: string; tags: string[]; lines: string[]; model: Gold[] }> = [
  {
    title: 'Atlas', tags: ['atlas'],
    lines: ['Latency must stay under 50 ms.', 'The new pipeline averages 110 ms.', 'We decided to use Postgres for the queue.', 'Embedding: a vector that represents meaning.', 'The demo is on Nov 20.'],
    model: [
      { text: 'Latency must stay under 50 ms.', sources: ['S1'], tag: 'EXTRACTED', gold: 'E' },
      { text: 'The new pipeline averages 110 ms.', sources: ['S2'], tag: 'EXTRACTED', gold: 'E' },
      { text: 'The pipeline is slower than the latency limit allows.', sources: ['S1', 'S2'], tag: 'INFERRED', gold: 'A' },
      { text: 'The team chose Postgres for the queue.', sources: ['S3'], tag: 'EXTRACTED', gold: 'I' },
      { text: 'The demo is on Nov 20.', sources: ['S5'], tag: 'EXTRACTED', gold: 'E' },
      { text: 'The demo is on Nov 22.', sources: ['S5'], tag: 'EXTRACTED', gold: 'drop' },
      { text: 'Embeddings represent meaning as vectors.', sources: ['S4'], tag: 'INFERRED', gold: 'I' },
      { text: 'Atlas is built in Rust by a team of six.', sources: ['S3'], tag: 'INFERRED', gold: 'drop' },
      { text: 'Postgres was chosen for the queue.', sources: ['S4'], tag: 'INFERRED', gold: 'drop' },
      { text: 'The latency limit is 50 ms.', sources: [], tag: 'INFERRED', gold: 'drop' },
      { text: 'Latency must stay under 50 ms and the demo is on Nov 20.', sources: ['S1', 'S5'], tag: 'INFERRED', gold: 'I' },
      { text: 'Queue work uses Postgres, a decision recorded by the team.', sources: ['S3'], tag: 'INFERRED', gold: 'I' },
    ],
  },
  {
    title: 'Signals', tags: ['signals'],
    lines: ['Fourier transforms decompose signals into frequencies.', 'The sampling rate is 44.1 kHz for CD audio.', 'The quiz is on Nov 18.', 'A low-pass filter removes frequencies above the cutoff.'],
    model: [
      { text: 'Fourier transforms decompose signals into frequencies.', sources: ['S1'], tag: 'EXTRACTED', gold: 'E' },
      { text: 'CD audio is sampled at 44.1 kHz.', sources: ['S2'], tag: 'EXTRACTED', gold: 'E' },
      { text: 'Low-pass filters keep frequencies below the cutoff.', sources: ['S4'], tag: 'EXTRACTED', gold: 'I' },
      { text: 'The quiz is on Nov 18.', sources: ['S3'], tag: 'EXTRACTED', gold: 'E' },
      { text: 'The quiz covers Fourier transforms.', sources: ['S1', 'S3'], tag: 'INFERRED', gold: 'drop' },
      { text: 'The sampling rate is 48 kHz.', sources: ['S2'], tag: 'EXTRACTED', gold: 'drop' },
    ],
  },
];

function docsFor(p: (typeof PAGES)[number]): SourceDoc[] {
  // One note per line, all under the page's tag, as a project's notes usually are.
  return p.lines.map((line, i) => {
    const id = `${p.title}${i}`;
    const meta = newNote({ id, title: `${p.title} note ${i + 1}`, pageId: `${id}p`, now: Date.UTC(2026, 10, 2), tags: p.tags });
    return extractSource(meta, [{ id: `${id}p`, strokes: [], formatVersion: 2, texts: [{ id: `${id}t`, x: 60, y: 60, width: 600, text: line, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] }]);
  });
}

describe('compiler drafts against a noisy model', () => {
  it('meets the provenance, pass-through, recall and tag bars', async () => {
    let kept = 0, keptGood = 0, good = 0, goodKept = 0, dropGold = 0, dropShown = 0, tagRight = 0;
    const lines: string[] = [];
    for (const p of PAGES) {
      const plan = planWiki(docsFor(p));
      const page = plan.pages.find((x) => x.kind === 'topic')!;
      const { refs } = pagePrompt(page, plan.units, plan.conflicts);
      // The prompt numbers sources in page order; map the fixture's S-numbers (line order) onto them.
      const byLine = new Map(p.lines.map((l, i) => [`S${i + 1}`, [...refs].find(([, id]) => stripMarkdown(plan.units.get(id)!.text) === l)![0]]));
      const model = p.model.map((m) => ({ ...m, sources: m.sources.map((s) => byLine.get(s)!) }));
      const ai: CompilerAI = { provider: createScriptedProvider(() => ({ text: JSON.stringify({ sentences: model.map(({ gold: _g, ...m }) => m) }) })), model: 'noisy', label: 'Noisy scripted model' };
      const draft = await draftPage(page, plan, ai);
      for (const m of p.model) {
        const shown = draft.claims.find((c) => stripMarkdown(c.text).replace(/\.$/, '') === m.text.replace(/\.$/, ''));
        if (m.gold === 'drop') { dropGold++; if (shown) { dropShown++; lines.push(`  shown but unsupported: ${m.text}`); } continue; }
        good++;
        if (shown) {
          goodKept++;
          if (shown.tag === m.gold) tagRight++;
          else lines.push(`  tag ${shown.tag}, gold ${m.gold}: ${m.text}`);
        } else lines.push(`  dropped though supported: ${m.text}`);
      }
      for (const c of draft.claims) {
        if (/^Sources disagree/.test(c.text)) continue; // the rules' own AMBIGUOUS line
        kept++;
        const m = p.model.find((x) => stripMarkdown(c.text).replace(/\.$/, '') === x.text.replace(/\.$/, ''));
        if (m && m.gold !== 'drop') keptGood++;
      }
    }
    const precision = keptGood / Math.max(1, kept);
    const passThrough = dropShown / Math.max(1, dropGold);
    const recall = goodKept / Math.max(1, good);
    const tagAcc = tagRight / Math.max(1, goodKept);
    printReport(`\nCompiler drafts (noisy scripted model, ${PAGES.reduce((s, p) => s + p.model.length, 0)} sentences): provenance precision ${precision.toFixed(3)}, unsupported pass-through ${passThrough.toFixed(3)}, recall ${recall.toFixed(3)}, tag accuracy ${tagAcc.toFixed(3)}\n${lines.join('\n')}`);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(passThrough).toBeLessThanOrEqual(0.25);
    expect(recall).toBeGreaterThanOrEqual(0.85);
    expect(tagAcc).toBeGreaterThanOrEqual(0.85);
  });

  const live = liveConfig();
  it.skipIf(!live)('live model: validation report per page', async () => {
    for (const p of PAGES) {
      const plan = planWiki(docsFor(p));
      const page = plan.pages.find((x) => x.kind === 'topic')!;
      const draft = await draftPage(page, plan, { provider: live!.provider, model: live!.model, label: live!.label });
      const tags = draft.claims.reduce((m, c) => ({ ...m, [c.tag]: (m[c.tag] ?? 0) + 1 }), {} as Record<string, number>);
      printReport(`Live ${live!.label} · ${p.title}: ${draft.byModel ? 'model draft' : `fallback (${draft.fallback})`}, kept ${draft.report.kept}, downgraded ${draft.report.downgraded}, dropped ${draft.report.dropped.length} ${JSON.stringify(tags)}\n${draft.report.dropped.map((d) => `  dropped: ${d.text} — ${d.reason}`).join('\n')}`);
      expect(draft.claims.every((c) => c.units.length > 0)).toBe(true);
    }
  });
});
