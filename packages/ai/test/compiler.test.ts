import { describe, expect, it } from 'vitest';
import { MemoryFS, Vault, extractSource, locateClaims, newId, textItemKey, type NoteMeta } from '@inkstone/core';
import {
  CompilerStore,
  RunRecorder,
  ActivityStore,
  VaultUndoTarget,
  VaultWikiTarget,
  adjudicate,
  applyProposal,
  compileWiki,
  createCompilerTools,
  createScriptedProvider,
  generateEvalQuestions,
  gradeTeachBack,
  makeCards,
  mcnemarExact,
  parseModelSentences,
  readProvenance,
  runMemoryEval,
  scanLedger,
  undoRun,
  vaultCurrentClaims,
  vaultRefresh,
  vaultSources,
  type CompilerAI,
  type ScriptContext,
} from '../src/index.ts';

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

async function setup() {
  let t = T0;
  const clock = () => (t += 1000);
  const vault = new Vault(new MemoryFS(), clock);
  await vault.init();
  const nb = await vault.createNotebook('Atlas', '#FF000000');
  const write = async (title: string, text: string, opts: { tags?: string[]; notebookId?: string } = {}): Promise<NoteMeta> => {
    const { note, pages } = await vault.createNote({ title, notebookId: opts.notebookId ?? nb.id, tags: opts.tags });
    const page = { ...pages[0]!, texts: [{ id: newId(clock()), x: 60, y: 60, width: 600, text, fontSize: 16, color: '#FF000000', font: 'sans' as const, createdAt: T0 }] };
    await vault.saveNote(note, [page]);
    return note;
  };
  const store = new CompilerStore(vault.fs);
  await store.saveConfig({ ...(await store.config()), sources: { notebooks: [nb.id], tags: [], notes: [] } });
  return { vault, store, write, nb, clock };
}

/** A model that writes one EXTRACTED sentence per source, one INFERRED summary, and one invented claim. */
function draftingModel(): CompilerAI & { calls: number } {
  const p = createScriptedProvider((ctx: ScriptContext) => {
    const lines = [...ctx.userText.matchAll(/^(S\d+) \[[^\]]*\]: (.+)$/gm)];
    const sentences = [
      ...lines.map(([, ref, text]) => ({ text: text!, sources: [ref], tag: 'EXTRACTED' })),
      ...(lines.length > 1 ? [{ text: `${lines[0]![2]!.split(' ').slice(0, 2).join(' ')} and ${lines[1]![2]!.split(' ').slice(0, 2).join(' ')} both matter here.`, sources: [lines[0]![1], lines[1]![1]], tag: 'INFERRED' }] : []),
      { text: 'The project was funded by a large grant from Mars.', sources: [lines[0]?.[1] ?? 'S1'], tag: 'INFERRED' },
    ];
    return { text: JSON.stringify({ sentences }) };
  });
  const ai = { provider: p, model: 'scripted', label: 'Scripted model', where: 'test', calls: 0 };
  return ai;
}

const choiceAll = (p: { items: { id: string }[] }) => Object.fromEntries(p.items.map((i) => [i.id, { accept: true }]));

describe('compileWiki and applyProposal', () => {
  it('compiles sources into a proposal, writes pages with provenance on accept, and logs undoable ops', async () => {
    const { vault, store, write } = await setup();
    const req = await write('Requirements', 'Latency must stay under 50 ms.\nEmbedding: a vector that represents meaning.', { tags: ['atlas'] });
    await write('Benchmark', 'The new pipeline averages 110 ms.', { tags: ['atlas'] });
    const ai = draftingModel();
    const sources = await vaultSources(vault, await store.config());
    const r = await compileWiki({ store, sources, ai, reason: 'Compile now', now: T0, currentClaims: (p) => vaultCurrentClaims(vault, p) });
    const p = r.proposal!;
    expect(p.items.map((i) => [i.key, i.action])).toEqual([['topic:atlas', 'create'], ['glossary', 'create'], ['index', 'create']]);
    const topic = p.items[0]!;
    expect(topic.dropped.map((d) => d.text)).toContain('The project was funded by a large grant from Mars.');
    expect(topic.next.some((c) => c.t === 'A' && /disagree/i.test(c.s))).toBe(true);
    expect(topic.next.every((c) => c.src.length > 0)).toBe(true);

    const activity = new ActivityStore(vault.fs);
    const rec = new RunRecorder(activity, { source: 'assistant', label: 'Compiled wiki' });
    const res = await applyProposal(p, choiceAll(p), { store, target: new VaultWikiTarget(vault), record: rec.record, now: T0 + 5000 });
    expect(res).toMatchObject({ applied: 3, rejected: 0, problems: [] });
    const run = await rec.finish('done');
    expect(run.ops.map((o) => o.kind)).toEqual(['note_created', 'note_created', 'note_created']);

    const state = await store.state();
    const page = state.pages['topic:atlas']!;
    const text = (await new VaultWikiTarget(vault).readText(page.noteId, page.pageId, page.textId))!;
    expect(text).toContain('# Atlas');
    expect(text).toMatch(/\nSources: \[\[(Requirements|Benchmark)\]\] · \[\[(Requirements|Benchmark)\]\]$/);
    const prov = await readProvenance(vault, page.noteId);
    const located = locateClaims(text, prov, textItemKey(page.textId)).filter((l) => l.claim);
    expect(located.length).toBeGreaterThanOrEqual(3);
    expect(located[0]!.gen?.by).toBe('Scripted model');
    expect((await vault.listNotebooks()).map((n) => n.name)).toContain('Compiled wiki');
    expect((await vault.readNote(page.noteId))!.tags).toEqual(['compiled']);

    // Nothing changed: nothing proposed. Compiled pages are never their own sources.
    const again = await compileWiki({ store, sources: await vaultSources(vault, await store.config()), ai, reason: 'Again', now: T0 + 6000, currentClaims: (pg) => vaultCurrentClaims(vault, pg) });
    expect(again.proposal).toBeNull();

    // An edit to a source proposes an update with a diff; accepting replaces the text (undoable).
    const pages = await vault.readPages(req);
    await vault.saveNote(req, [{ ...pages[0]!, texts: [{ ...pages[0]!.texts![0]!, text: 'Latency must stay under 80 ms.\nEmbedding: a vector that represents meaning.' }] }]);
    const upd = await compileWiki({ store, sources: await vaultSources(vault, await store.config()), ai, reason: 'Re-check', now: T0 + 7000, currentClaims: (pg) => vaultCurrentClaims(vault, pg) });
    const item = upd.proposal!.items.find((i) => i.key === 'topic:atlas')!;
    expect(item.action).toBe('update');
    expect(item.added.map((c) => c.s)).toContain('Latency must stay under 80 ms.');
    expect(item.removed.map((c) => c.s)).toContain('Latency must stay under 50 ms.');
    const rec2 = new RunRecorder(activity, { source: 'assistant', label: 'Compiled wiki' });
    await applyProposal(upd.proposal!, { [item.id]: { accept: true } }, { store, target: new VaultWikiTarget(vault), record: rec2.record, now: T0 + 8000 });
    const run2 = await rec2.finish('done');
    expect(run2.ops.map((o) => o.kind)).toEqual(['text_replaced']);
    expect(await new VaultWikiTarget(vault).readText(page.noteId, page.pageId, page.textId)).toContain('80 ms');
    await undoRun(run2, new VaultUndoTarget(vault));
    expect(await new VaultWikiTarget(vault).readText(page.noteId, page.pageId, page.textId)).toBe(text);
    // The undone text still finds its provenance (the previous generation is kept).
    const prov2 = await readProvenance(vault, page.noteId);
    expect(locateClaims(text, prov2, textItemKey(page.textId)).filter((l) => l.claim).length).toBe(located.length);
  });

  it('keeps the user’s own lines when updating, remembers rejections, and refreshes moved anchors silently', async () => {
    const { vault, store, write } = await setup();
    const a = await write('Plan', 'The demo is on Dec 3.\nWe decided to use Postgres.');
    const sources = async () => vaultSources(vault, await store.config());
    const cur = (pg: any) => vaultCurrentClaims(vault, pg);
    const first = (await compileWiki({ store, sources: await sources(), ai: null, reason: 'x', now: T0, currentClaims: cur })).proposal!;
    expect(first.gen.by).toMatch(/without AI/);
    await applyProposal(first, choiceAll(first), { store, target: new VaultWikiTarget(vault), record: () => {}, now: T0 });
    const page = (await store.state()).pages['topic:plan']!;
    const target = new VaultWikiTarget(vault);
    const t0 = (await target.readText(page.noteId, page.pageId, page.textId))!;
    await target.replaceText(page.noteId, page.pageId, page.textId, t0, `${t0}\n- My own reminder line.`);

    // Moving the source sentence to another position keeps the sentences: refreshed, no proposal.
    const pages = await vault.readPages(a);
    await vault.saveNote(a, [{ ...pages[0]!, texts: [{ ...pages[0]!.texts![0]!, y: 300 }] }]);
    const moved = await compileWiki({ store, sources: await sources(), ai: null, reason: 'x', now: T0 + 1, currentClaims: cur, refresh: (pg, claims, gen) => vaultRefresh(vault, pg, claims, gen) });
    expect(moved.proposal).toBeNull();
    expect(moved.refreshed).toBe(1);

    await vault.saveNote(a, [{ ...pages[0]!, texts: [{ ...pages[0]!.texts![0]!, text: 'The demo is on Dec 5.\nWe decided to use Postgres.' }] }]);
    const p2 = (await compileWiki({ store, sources: await sources(), ai: null, reason: 'x', now: T0 + 2, currentClaims: cur })).proposal!;
    const it2 = p2.items.find((i) => i.key === 'topic:plan')!;
    // Reject: the same change is not proposed again.
    await applyProposal(p2, { [it2.id]: { accept: false } }, { store, target, record: () => {}, now: T0 + 3 });
    expect((await compileWiki({ store, sources: await sources(), ai: null, reason: 'x', now: T0 + 4, currentClaims: cur })).proposal).toBeNull();
    // Force (re-check) proposes it again; accept keeps "My own reminder line."
    const p3 = (await compileWiki({ store, sources: await sources(), ai: null, reason: 'x', now: T0 + 5, currentClaims: cur, force: true, only: new Set(['topic:plan']) })).proposal!;
    await applyProposal(p3, choiceAll(p3), { store, target, record: () => {}, now: T0 + 6 });
    const t3 = (await target.readText(page.noteId, page.pageId, page.textId))!;
    expect(t3).toContain('Dec 5');
    expect(t3).toContain('## Your notes\n- My own reminder line.');
  });

  it('archives a compiled page whose sources are all gone', async () => {
    const { vault, store, write } = await setup();
    const n = await write('Lonely', 'Only line here.');
    const cur = (pg: any) => vaultCurrentClaims(vault, pg);
    const p = (await compileWiki({ store, sources: await vaultSources(vault, await store.config()), ai: null, reason: 'x', now: T0, currentClaims: cur })).proposal!;
    await applyProposal(p, choiceAll(p), { store, target: new VaultWikiTarget(vault), record: () => {}, now: T0 });
    await vault.trashNote(n.id);
    const p2 = (await compileWiki({ store, sources: await vaultSources(vault, await store.config()), ai: null, reason: 'x', now: T0 + 1, currentClaims: cur })).proposal!;
    expect(p2.items.map((i) => i.action)).toContain('archive');
  });

  it('parses model output leniently', () => {
    expect(parseModelSentences('Here you go:\n```json\n{"sentences":[{"text":"A.","sources":"S1, S2","tag":"INFERRED"}]}\n```')).toEqual([{ text: 'A.', sources: ['S1', 'S2'], tag: 'INFERRED' }]);
    expect(parseModelSentences('no json')).toEqual([]);
  });
});

describe('ledger', () => {
  it('honours dismissals and only promotes grey-zone pairs the model is sure about', async () => {
    const { vault, store, write } = await setup();
    await write('A', 'Latency must stay under 50 ms.', { tags: ['atlas'] });
    await write('B', 'The new pipeline averages 110 ms.', { tags: ['atlas'] });
    await write('C', 'The nightly job takes 9 minutes.');
    await write('D', 'Reports must be ready within 5 minutes.');
    const docs = (await vaultSources(vault, await store.config())).map((s) => extractSource(s.meta, s.pages));
    const scan = scanLedger(docs, new Map());
    expect(scan.open).toHaveLength(1);
    await store.decide({ id: scan.open[0]!.id, status: 'dismissed', a: scan.open[0]!.a.text, b: scan.open[0]!.b.text, at: T0 });
    const after = scanLedger(docs, await store.decisions());
    expect(after.open).toHaveLength(0);
    expect(after.decided).toHaveLength(1);
    const sure = createScriptedProvider(() => ({ text: '{"same_subject": true, "contradict": true, "confidence": 0.9, "why": "The export runs longer than allowed."}' }));
    const unsure = createScriptedProvider(() => ({ text: '{"same_subject": true, "contradict": true, "confidence": 0.5}' }));
    expect(after.candidates.length).toBeGreaterThan(0);
    expect((await adjudicate({ provider: sure, model: 'm', label: 'M' }, after.candidates)).map((c) => c.by)).toEqual(after.candidates.map(() => 'model'));
    expect(await adjudicate({ provider: unsure, model: 'm', label: 'M' }, after.candidates)).toEqual([]);
  });
});

describe('study with a model at the edges', () => {
  const units = () => extractSource({ id: 'N1', title: 'Physics', kind: 'paged', paper: { style: 'blank', tint: 'white', texture: 'smooth', spacing: 0 }, pageSize: { name: 'A4', width: 794, height: 1123 }, pageIds: ['p'], tags: [], createdAt: T0, updatedAt: T0, pinned: false, formatVersion: 2 },
    [{ id: 'p', strokes: [], formatVersion: 2, texts: [{ id: 't', x: 0, y: 0, width: 600, text: 'Latency must stay under 50 ms.\nEmbedding: a vector that represents meaning.', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] }]).units;

  it('keeps model cards whose answers are in their source, drops the rest, falls back to rules', async () => {
    const p = createScriptedProvider(() => ({ text: JSON.stringify({ cards: [
      { q: 'What must latency stay under?', a: '50 ms', source: 'S1' },
      { q: 'What must latency stay under?', a: '40 ms', source: 'S1' },
      { q: 'Who invented embeddings?', a: 'Alan Turing', source: 'S2' },
      { q: 'Unsourced', a: 'x', source: 'S9' },
    ] }) }));
    const r = await makeCards({ provider: p, model: 'm', label: 'M' }, units());
    expect(r.byModel).toBe(true);
    expect(r.cards.map((c) => c.a)).toEqual(['50 ms']);
    expect(r.cards[0]!.src).toMatch(/^N1\/1\//);
    const rules = await makeCards(null, units());
    expect(rules.cards.map((c) => c.origin)).toEqual(['extracted', 'extracted']);
  });

  it('grades teach-back answers: missing numbers and contradictions can’t be graded right', async () => {
    const u = units();
    const q = { id: 'q1', q: 'What is the latency limit?', expected: '50 ms', unitIds: [u[0]!.id] };
    const lenient = createScriptedProvider(() => ({ text: '{"score": 1, "gaps": [], "contradictions": [], "feedback": "Great!"}' }));
    const v = await gradeTeachBack({ provider: lenient, model: 'm', label: 'M' }, q, 'Latency must stay under 80 ms.', u);
    expect(v.verdict).toBe('wrong');
    expect(v.contradictions[0]!.sourceSays).toBe('Latency must stay under 50 ms.');
    expect(v.score).toBeLessThanOrEqual(0.5);
    const ok = await gradeTeachBack(null, q, 'It has to stay under 50 ms', u);
    expect(ok.verdict).toBe('right');
  });
});

describe('memory evals', () => {
  it('computes an exact McNemar p-value', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(10, 0)).toBeCloseTo(0.00195, 4);
    expect(mcnemarExact(3, 2)).toBe(1);
  });

  it('generates held-out questions and reports retrieval vs closed book honestly', async () => {
    const { vault, store, write } = await setup();
    for (let i = 0; i < 12; i++) await write(`Service ${i}`, `Service ${i} latency must stay under ${(i + 2) * 10} ms.`);
    const docs = (await vaultSources(vault, await store.config())).map((s) => extractSource(s.meta, s.pages));
    const qs = generateEvalQuestions(docs, 12);
    expect(qs).toHaveLength(12);
    expect(new Set(qs.map((q) => q.noteId)).size).toBe(12);
    // A model that knows only what the passages say.
    const model = createScriptedProvider((ctx) => {
      const m = /\[P(\d+)\] \([^)]*\) (.+)/.exec(ctx.userText);
      const blank = /"(.+)___(.*)"/.exec(ctx.userText);
      if (!m || !blank) return { text: "I don't know", usage: { inputTokens: 40, outputTokens: 4 } };
      const lines = [...ctx.userText.matchAll(/\[P(\d+)\] \([^)]*\) (.+)/g)];
      const hit = lines.find((l) => l[2]!.startsWith(blank[1]!.trim()));
      const ans = hit ? hit[2]!.slice(blank[1]!.trim().length).trim().split(/\s(?=ms)/).join(' ').replace(/\.$/, '') : "I don't know";
      return { text: hit ? `${ans} [P${hit[1]}]` : ans, usage: { inputTokens: 200, outputTokens: 6 } };
    });
    const byNote = new Map(docs.map((d) => [d.noteId, d]));
    const report = await runMemoryEval({
      ai: { provider: model, model: 'm', label: 'Scripted' }, questions: qs, conditions: ['none', 'notes'],
      host: { retrieve: async (q) => { const n = qs.find((x) => x.q === q)!; const d = byNote.get(n.noteId)!; return [{ id: 'p1', title: d.title, text: d.units[0]!.text, noteIds: [d.noteId] }]; } },
    });
    const none = report.summary.find((s) => s.condition === 'none')!;
    const notes = report.summary.find((s) => s.condition === 'notes')!;
    expect(none.accuracy).toBe(0);
    expect(notes.accuracy).toBe(1);
    expect(notes.citationAccuracy).toBe(1);
    expect(notes.tokensPerQuestion).toBeGreaterThan(none.tokensPerQuestion);
    expect(report.comparisons[0]!.significant).toBe(true);
    // Too few questions: says so instead of claiming a difference.
    const small = await runMemoryEval({ ai: { provider: model, model: 'm', label: 'S' }, questions: qs.slice(0, 3), conditions: ['none', 'notes'], host: { retrieve: async () => [] } });
    expect(small.headline).toMatch(/too few/);
    expect(small.comparisons[0]!.verdict).toMatch(/No significant difference/);
  });
});

describe('agent tools', () => {
  it('compile_wiki, list_conflicts and list_followups delegate to the host and never write notes', async () => {
    const tools = createCompilerTools({
      compile: async (reason) => ({ summary: `compiled (${reason})`, changes: 2 }),
      conflicts: async () => [{ a: 'A', aNote: 'n1', b: 'B', bNote: 'n2', reason: 'r', confidence: 0.8 }],
      followUps: async (since) => [{ text: `since ${new Date(since).getDate()}`, owner: 'me', done: false, note: 'N', noteId: 'n' }],
    });
    expect(tools.every((t) => t.readOnly)).toBe(true);
    const ctx = {} as any;
    expect(await tools[0]!.execute({ reason: 'Nightly' }, ctx)).toMatchObject({ summary: 'compiled (Nightly)' });
    expect(await tools[1]!.execute({}, ctx)).toMatchObject({ count: 1 });
    expect(await tools[2]!.execute({ since: '2026-11-02' }, ctx)).toMatchObject({ count: 1, items: [{ text: 'since 2' }] });
  });
});
