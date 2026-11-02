import { describe, expect, it } from 'vitest';
import {
  agentsMd,
  attributeAnswer,
  attributedClaims,
  applyClaimChoice,
  buildContextPack,
  claimFreshness,
  compileWork,
  decodeDeck,
  decodeProvenance,
  detectConflicts,
  deterministicCards,
  deterministicDraft,
  diffClaims,
  dueCards,
  emptyCompilerState,
  emptyProvenance,
  encodeDeck,
  encodeProvenance,
  extractActions,
  extractClaims,
  extractDates,
  extractDefinitions,
  extractEntities,
  extractSource,
  formatAnchor,
  gradeAnswer,
  locateClaims,
  mergeDecks,
  mergeProvenance,
  newCard,
  newNote,
  parseAnchor,
  parseQuantities,
  planWiki,
  previewIntervals,
  renderPage,
  reviewCard,
  setItem,
  sourceHashes,
  splitSentences,
  stripMarkdown,
  toProvClaims,
  validateDraft,
  type NoteMeta,
  type PageInk,
  type RecordingTranscript,
  type SourceDoc,
} from '../src/index.ts';

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
let seq = 0;

/** A typed note: each string is a text box (Markdown). */
function note(title: string, boxes: string[], opts: { tags?: string[]; notebookId?: string; at?: number; recognized?: string } = {}): { meta: NoteMeta; pages: PageInk[] } {
  const id = `N${String(++seq).padStart(4, '0')}${title.replace(/\W/g, '').slice(0, 10)}`;
  const meta = newNote({ id, title, pageId: `${id}p1`, now: opts.at ?? T0, tags: opts.tags, notebookId: opts.notebookId });
  let y = 60;
  const page: PageInk = {
    id: `${id}p1`, strokes: [], formatVersion: 2,
    texts: boxes.map((text, i) => { const box = { id: `${id}t${i}`, x: 60, y, width: 600, text, fontSize: 16, color: '#FF000000', font: 'sans' as const, createdAt: T0 }; y += 200; return box; }),
  };
  if (opts.recognized) page.recognizedText = opts.recognized;
  return { meta, pages: [page] };
}

const doc = (n: { meta: NoteMeta; pages: PageInk[] }, transcripts?: RecordingTranscript[]): SourceDoc => extractSource(n.meta, n.pages, { transcripts });

describe('text helpers', () => {
  it('splits sentences, keeping numbers, abbreviations and list items intact', () => {
    const s = splitSentences('Latency is 3.5 ms today. Dr. Rao agreed, e.g. for p95.\n- [ ] Call Sam\n# Heading');
    expect(s.map((x) => x.text)).toEqual(['Latency is 3.5 ms today.', 'Dr. Rao agreed, e.g. for p95.', '- [ ] Call Sam', '# Heading']);
    expect(stripMarkdown('- [x] **Ship** [[Project Atlas|Atlas]] now')).toBe('Ship Atlas now');
  });
});

describe('extraction', () => {
  it('cuts notes into located sentences with headings, links and tags', () => {
    const n = note('Atlas sync', ['# Performance\nLatency must stay under 50 ms. See [[Pipeline]] #perf', 'Plain line'], { tags: ['atlas'] });
    const d = doc(n);
    expect(d.units.map((u) => u.text)).toEqual(['Latency must stay under 50 ms.', 'See [[Pipeline]] #perf', 'Plain line']);
    expect(d.units[0]!.heading).toBe('Performance');
    expect(d.units[0]!.rect).toBeDefined();
    expect(d.units[0]!.textId).toBe(n.pages[0]!.texts![0]!.id);
    expect(d.links).toEqual(['Pipeline']);
    expect(d.tags).toEqual(['atlas', 'perf']);
    expect(d.headings).toEqual(['Performance']);
  });

  it('anchors speech to the recording moment and recognized handwriting to its page', () => {
    const n = note('Lecture', [], { recognized: 'Fourier transforms decompose signals' });
    n.meta.recordings = [{ id: 'clip1', asset: 'a.webm', startedAt: T0, durationMs: 60_000, mimeType: 'audio/webm' }];
    const transcripts: RecordingTranscript[] = [{ clip: n.meta.recordings[0]!, file: { formatVersion: 1, clipId: 'clip1', run: 'r', engine: 'device:x', where: 'device', complete: true, updatedAt: T0, segments: [{ id: 's1', startMs: 12_000, endMs: 15_000, text: 'The exam is on December 3.' }] } }];
    const d = doc(n, transcripts);
    const speech = d.units.find((u) => u.kind === 'speech')!;
    expect(speech).toMatchObject({ clip: 'clip1', startMs: 12_000, text: 'The exam is on December 3.' });
    expect(d.units.find((u) => u.kind === 'handwriting')!.text).toBe('Fourier transforms decompose signals');
    const a = parseAnchor(formatAnchor({ noteId: speech.noteId, page: 0, clip: 'clip1', ms: 12_000, h: speech.hash }))!;
    expect(a).toMatchObject({ noteId: speech.noteId, page: 0, clip: 'clip1', ms: 12_000, h: speech.hash });
  });

  it('skips locked and trashed notes', () => {
    const n = note('Secret', ['Budget is $5k.']);
    expect(extractSource({ ...n.meta, trashedAt: 1 }, n.pages).units).toEqual([]);
  });

  it('finds people, projects, definitions, dates and actions by rule', () => {
    const n = note('Standup', ['Attendees: Priya Shah, Sam Lee\n- [ ] Sam to send the deck by Friday\nFollow up with Priya about hiring.\nProject Atlas kicks off on Dec 3.\nEmbedding: a vector that represents meaning\nI need to book the room tomorrow.']);
    const d = doc(n);
    const ents = extractEntities(d);
    expect(new Set(ents.filter((e) => e.kind === 'person').map((e) => e.name))).toEqual(new Set(['Priya Shah', 'Sam Lee']));
    expect(ents.some((e) => e.kind === 'project' && e.name === 'Atlas')).toBe(true);
    expect(extractDefinitions(d.units)).toEqual([expect.objectContaining({ term: 'Embedding', definition: 'a vector that represents meaning' })]);
    const actions = extractActions(d, { ref: new Date(2026, 10, 2) });
    expect(actions.find((a) => a.text.includes('deck'))).toMatchObject({ owner: 'Sam', due: '2026-11-06', done: false });
    expect(actions.find((a) => a.followUp)).toMatchObject({ person: 'Priya', followUp: true });
    expect(actions.find((a) => a.text.includes('book the room'))).toMatchObject({ owner: 'me', due: '2026-11-03' });
    expect(extractDates('Launch on 3 Dec, review 2026-12-10 and 12/24', new Date(2026, 10, 2)).map((x) => x.date)).toEqual(['2026-12-03', '2026-12-10', '2026-12-24']);
  });

  it('does not take ordinary capitalised words for people', () => {
    const n = note('Tech', ['We met with Google about Kafka.\nCall Monday to confirm.\nThe Team said it works.']);
    expect(extractEntities(doc(n)).filter((e) => e.kind === 'person')).toEqual([]);
  });
});

describe('claims and conflicts', () => {
  it('parses quantities with units and currencies', () => {
    expect(parseQuantities('p95 is 110 ms, budget $5k, 2.5 GB and 99.9% uptime').map((q) => [q.dim, q.base])).toEqual([
      ['time', 0.11], ['money', 5000], ['data', 2.5e9], ['percent', 99.9],
    ]);
  });

  it('flags a measurement that breaks a limit, across notes (the latency example)', () => {
    const a = doc(note('Requirements', ['Latency must stay under 50 ms.'], { tags: ['atlas'] }));
    const b = doc(note('Benchmark', ['The new pipeline averages 110 ms.'], { tags: ['atlas'] }));
    const conflicts = detectConflicts([...extractClaims(a), ...extractClaims(b)]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'violates-limit' });
    expect(conflicts[0]!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(conflicts[0]!.reason).toContain('50 ms');
  });

  it('stays quiet when values agree, units differ in kind, or one note supersedes the other', () => {
    const claims = [
      ...extractClaims(doc(note('A', ['Latency must stay under 50 ms.']))),
      ...extractClaims(doc(note('B', ['The pipeline averages 30 ms.']))),
      ...extractClaims(doc(note('C', ['The bundle is 110 MB.']))),
      ...extractClaims(doc(note('D', ['The launch is on Dec 3.']))),
      ...extractClaims(doc(note('E', ['The launch moved to Dec 10.']))),
      ...extractClaims(doc(note('F', ['The build takes 3 days.']))),
    ];
    expect(detectConflicts(claims)).toEqual([]);
  });

  it('detects date and decision disagreements', () => {
    const claims = [
      ...extractClaims(doc(note('Plan', ['The launch is on Dec 3.'], { tags: ['atlas'] }))),
      ...extractClaims(doc(note('Email', ['Launch is December 10.'], { tags: ['atlas'] }))),
      ...extractClaims(doc(note('Mon', ['We decided to use Postgres for the queue.']))),
      ...extractClaims(doc(note('Tue', ['We decided not to use Postgres for the queue.']))),
    ];
    const kinds = detectConflicts(claims).map((c) => c.kind).sort();
    expect(kinds).toEqual(['dates-disagree', 'decisions-disagree']);
  });
});

describe('provenance', () => {
  it('round-trips, locates claims by sentence, and keeps the previous generation for undo', () => {
    const f = emptyProvenance();
    const gen = { by: 'Test model', prompt: 'compiler.topic/1', at: 10 };
    setItem(f, 'text:t1', gen, [{ s: 'Latency must stay under 50 ms.', t: 'E', src: ['N1/1#abc'] }]);
    setItem(f, 'text:t1', { ...gen, at: 20 }, [{ s: 'Latency is capped at 50 ms.', t: 'I', src: ['N1/1#abc'] }], 20);
    const back = decodeProvenance(encodeProvenance(f));
    const located = locateClaims('# Page\n- Latency must stay under 50 ms.\n- I wrote this myself.', back, 'text:t1');
    expect(located.map((l) => l.claim?.t ?? null)).toEqual([null, 'E', null]);
    expect(located[1]!.gen?.by).toBe('Test model');
    expect(Object.keys(back.gens)).toHaveLength(2);
  });

  it('marks a claim stale when its source sentence changes, missing when the note is gone', () => {
    const n = note('Req', ['Latency must stay under 50 ms.']);
    const d = doc(n);
    const claim = toProvClaims([{ text: 'Latency must stay under 50 ms.', tag: 'E', units: [d.units[0]!.id] }], new Map(d.units.map((u) => [u.id, u])))[0]!;
    expect(claimFreshness(claim, (id) => (id === n.meta.id ? sourceHashes(d) : null))).toBe('fresh');
    n.pages[0]!.texts![0]!.text = 'Latency must stay under 80 ms.';
    const d2 = doc(n);
    expect(claimFreshness(claim, (id) => (id === n.meta.id ? sourceHashes(d2) : null))).toBe('stale');
    expect(claimFreshness(claim, () => null)).toBe('missing');
  });

  it('merges per item, newer wins, deletions honoured', () => {
    const base = emptyProvenance();
    setItem(base, 'text:a', { by: 'x', prompt: 'p', at: 1 }, [{ s: 'A.', t: 'E', src: [] }], 1);
    setItem(base, 'text:b', { by: 'x', prompt: 'p', at: 1 }, [{ s: 'B.', t: 'E', src: [] }], 1);
    const local = structuredClone(base);
    const remote = structuredClone(base);
    setItem(local, 'text:a', { by: 'y', prompt: 'p', at: 5 }, [{ s: 'A2.', t: 'I', src: [] }], 5);
    delete remote.items['text:b'];
    const m = mergeProvenance(base, local, remote);
    expect(m.items['text:a']!.claims[0]!.s).toBe('A2.');
    expect(m.items['text:b']).toBeUndefined();
  });
});

describe('wiki planning, validation and diffs', () => {
  const sources = () => [
    doc(note('Atlas requirements', ['# Performance\nLatency must stay under 50 ms.\nEmbedding: a vector that represents meaning.'], { tags: ['atlas'] })),
    doc(note('Atlas benchmark', ['# Performance\nThe new pipeline averages 110 ms.'], { tags: ['atlas'] })),
    doc(note('Groceries', ['Milk and eggs.'])),
  ];

  it('plans topic pages from tags and loose notes, a glossary and an index, with stable fingerprints', () => {
    const plan = planWiki(sources());
    expect(plan.pages.map((p) => p.key)).toEqual(['topic:atlas', 'topic:groceries', 'glossary', 'index']);
    expect(plan.conflicts).toHaveLength(1);
    const again = planWiki(sources());
    expect(again.pages.map((p) => p.fingerprint)).toEqual(plan.pages.map((p) => p.fingerprint));
  });

  it('recompiles only pages whose sources changed', () => {
    const plan = planWiki(sources());
    const state = emptyCompilerState();
    for (const p of plan.pages) state.pages[p.key] = { key: p.key, kind: p.kind, title: p.title, noteId: 'x', pageId: 'p', textId: 't', fingerprint: p.fingerprint, sourceNotes: p.noteIds, at: 1 };
    expect(compileWork(plan.pages, state).changed).toEqual([]);
    const s2 = sources();
    s2[2] = doc(note('Groceries', ['Milk, eggs and bread.']));
    const plan2 = planWiki(s2);
    expect(compileWork(plan2.pages, state).changed.map((p) => p.key)).toEqual(['topic:groceries']);
    const s3 = sources().slice(0, 2);
    expect(compileWork(planWiki(s3).pages, state).orphaned.map((p) => p.key)).toEqual(['topic:groceries']);
  });

  it('writes a deterministic draft with an AMBIGUOUS line for disagreeing sources', () => {
    const plan = planWiki(sources());
    const page = plan.pages.find((p) => p.key === 'topic:atlas')!;
    const draft = deterministicDraft(page, plan.units, plan.conflicts);
    expect(draft[0]).toMatchObject({ tag: 'A' });
    expect(draft[0]!.text).toContain('Sources disagree');
    expect(draft.filter((d) => d.tag === 'E').map((d) => d.text)).toContain('Latency must stay under 50 ms.');
  });

  it('validates model drafts: drops unsupported sentences and invented numbers, downgrades fake quotes, forces AMBIGUOUS', () => {
    const plan = planWiki(sources());
    const page = plan.pages.find((p) => p.key === 'topic:atlas')!;
    const refs = new Map(page.unitIds.map((id, i) => [`S${i + 1}`, id]));
    const { claims, report } = validateDraft([
      { text: 'Latency must stay under 50 ms.', sources: ['S1'], tag: 'EXTRACTED' },
      { text: 'Latency has to remain below 50 ms.', sources: ['S1'], tag: 'EXTRACTED' },
      { text: 'The pipeline misses the latency limit.', sources: ['S1', 'S3'], tag: 'INFERRED' },
      { text: 'Atlas will be rewritten in Rust next quarter.', sources: ['S1'], tag: 'INFERRED' },
      { text: 'Latency must stay under 40 ms.', sources: ['S1'], tag: 'EXTRACTED' },
      { text: 'Embeddings are vectors.', sources: [], tag: 'INFERRED' },
    ], refs, plan.units, plan.conflicts);
    expect(claims.map((c) => [c.text, c.tag])).toEqual([
      ['Latency must stay under 50 ms.', 'E'],
      ['Latency has to remain below 50 ms.', 'I'],
      ['The pipeline misses the latency limit.', 'A'],
    ]);
    expect(report.dropped.map((d) => d.reason)).toEqual([expect.stringContaining('not supported'), expect.stringContaining('40'), 'cites no source']);
    expect(report.downgraded).toBe(1);
  });

  it('diffs claims and applies per-claim choices', () => {
    const cur = [{ s: 'A is 1.', t: 'E' as const, src: [] }, { s: 'B is 2.', t: 'E' as const, src: [] }];
    const next = [{ s: 'A is 1.', t: 'E' as const, src: ['n/1#x'] }, { s: 'C is 3.', t: 'I' as const, src: [] }, { s: 'D is 4.', t: 'I' as const, src: [] }];
    const diff = diffClaims(cur, next);
    expect(diff.added.map((c) => c.s)).toEqual(['C is 3.', 'D is 4.']);
    expect(diff.removed.map((c) => c.s)).toEqual(['B is 2.']);
    const chosen = applyClaimChoice(diff, { added: new Set(['c is 3.']), removed: new Set() }, next);
    expect(chosen.map((c) => c.s)).toEqual(['A is 1.', 'C is 3.', 'B is 2.']);
    expect(renderPage('T', chosen, ['Note A'])).toBe('# T\n\n- A is 1.\n- C is 3.\n- B is 2.\n\nSources: [[Note A]]');
  });

  it('makes person pages only with consent, with their actions', () => {
    const docs = [doc(note('1:1', ['Follow up with Priya Shah about hiring.\nPriya said the offer goes out Monday.']))];
    expect(planWiki(docs).pages.some((p) => p.kind === 'person')).toBe(false);
    const plan = planWiki(docs, { people: true });
    const person = plan.pages.find((p) => p.kind === 'person')!;
    expect(person.title).toBe('Priya Shah');
    expect(person.actions).toEqual([expect.objectContaining({ followUp: true })]);
    const draft = deterministicDraft(person, plan.units);
    expect(draft.some((d) => d.text.startsWith('Follow up'))).toBe(true);
  });
});

describe('study (FSRS)', () => {
  it('schedules with FSRS-6: Again soon, Easy much later; intervals grow with good reviews', () => {
    let card = newCard({ id: 'c1', q: 'Q', a: 'A', from: 'note', origin: 'extracted' }, T0);
    const p = previewIntervals(card, T0);
    expect(p[1]).toBeLessThan(p[3]);
    expect(p[3]).toBeLessThan(p[4]);
    card = reviewCard(card, 3, T0);
    card = reviewCard(card, 3, card.mem.due);
    const first = card.mem.due - T0;
    card = reviewCard(card, 3, card.mem.due);
    expect(card.mem.due - T0).toBeGreaterThan(first);
    expect(card.mem.reps).toBe(3);
  });

  it('lists due cards and merges decks card by card', () => {
    const c1 = newCard({ id: 'c1', q: 'Q1', a: 'A1', from: 'note', origin: 'ai' }, T0);
    const c2 = newCard({ id: 'c2', q: 'Q2', a: 'A2', from: 'note', origin: 'ai' }, T0);
    const base = { formatVersion: 1 as const, id: 'd', title: 'D', updatedAt: T0, cards: [c1, c2], reviews: [] };
    const local = { ...base, cards: [reviewCard(c1, 3, T0 + 1000), c2], updatedAt: T0 + 1000, reviews: [{ card: 'c1', at: T0 + 1000, rating: 3 as const }] };
    const remote = { ...base, cards: [c1, reviewCard(c2, 1, T0 + 2000)], updatedAt: T0 + 2000, reviews: [{ card: 'c2', at: T0 + 2000, rating: 1 as const }] };
    const m = mergeDecks(base, local, remote);
    expect(m.cards.map((c) => c.mem.reps)).toEqual([1, 1]);
    expect(m.reviews).toHaveLength(2);
    expect(decodeDeck(encodeDeck(m)).cards).toHaveLength(2);
    expect(dueCards([base], T0).map((x) => x.card.id)).toEqual(['c1', 'c2']);
  });

  it('writes cloze and definition cards by rule, and grades written answers', () => {
    const d = doc(note('Physics', ['Embedding: a vector that represents meaning.\nLatency must stay under 50 ms.']));
    const units = new Map(d.units.map((u) => [u.id, u]));
    const cards = deterministicCards(units, extractDefinitions(d.units), extractClaims(d));
    expect(cards.map((c) => [c.q, c.a])).toEqual([['What is Embedding?', 'a vector that represents meaning'], ['Latency must stay under ___.', '50 ms']]);
    expect(gradeAnswer('fifty? no, 50 ms', '50 ms').rating).toBeGreaterThanOrEqual(3);
    expect(gradeAnswer('40 ms', '50 ms').rating).toBe(1);
    expect(gradeAnswer('a vector representing meaning', 'a vector that represents meaning').score).toBeGreaterThan(0.6);
  });
});

describe('context packs and AGENTS.md', () => {
  it('builds Markdown with numbered citations, JSON with images, and a valid skill folder', () => {
    const n = note('Atlas', ['Latency must stay under 50 ms.']);
    const d = doc(n);
    const claims = toProvClaims([{ text: 'Latency must stay under 50 ms.', tag: 'E', units: [d.units[0]!.id] }], new Map(d.units.map((u) => [u.id, u])));
    const pack = buildContextPack({
      title: 'Project Atlas', createdAt: T0,
      notes: [{ id: n.meta.id, title: 'Atlas', tags: [], updatedAt: T0, pages: [{ index: 0, text: 'Latency must stay under 50 ms.' }] }],
      compiled: [{ title: 'Atlas', kind: 'topic', claims }],
      images: [{ name: 'ink-1.png', noteId: n.meta.id, noteTitle: 'Atlas', page: 0, alt: 'sketch of the pipeline', mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }],
      memory: { instructions: ['Answer in British English.'], facts: [] },
    });
    expect(pack.markdown).toContain('- Latency must stay under 50 ms. _(extracted)_ [1]');
    expect(pack.markdown).toContain('[1]: Atlas, page 1');
    expect(pack.markdown).toContain('Answer in British English.');
    const skillMd = pack.skill['notes-project-atlas/SKILL.md'] as string;
    expect(skillMd).toMatch(/^---\nname: notes-project-atlas\ndescription: ".+"\n/);
    expect(pack.skill['notes-project-atlas/assets/ink-1.png']).toBeInstanceOf(Uint8Array);
    expect((pack.json.images as Array<{ base64: string }>)[0]!.base64).toBe('iVBORw==');
    const md = agentsMd({ instructions: ['Use pnpm.'], facts: [], decisions: [{ text: 'We decided to use Postgres.', noteTitle: 'Arch', src: formatAnchor({ noteId: n.meta.id, page: 0, h: 'x1' }) }], createdAt: T0 });
    expect(md).toContain('- We decided to use Postgres. _(Arch, page 1)_');
  });
});

describe('explaining answers', () => {
  it('attributes sentences to the passages that support them, and admits when nothing does', () => {
    const n = note('Atlas', ['Latency must stay under 50 ms.']);
    const d = doc(n);
    const passages = [{ noteId: n.meta.id, title: 'Atlas', pageIndex: 0, text: 'Latency must stay under 50 ms.' }];
    const s = attributeAnswer(`Latency must stay under 50 ms ([Atlas, p. 1](#mem/${n.meta.id}/1)). Latency has a 50 ms ceiling. Paris is in France.`, passages);
    expect(s.map((x) => [x.tag, x.cited])).toEqual([['E', true], ['I', false], [null, false]]);
    expect(s[0]!.text).toBe('Latency must stay under 50 ms.');
    const claims = attributedClaims(s, (id) => (id === n.meta.id ? d.units : null));
    expect(claims).toHaveLength(2);
    expect(claims[0]!.src[0]).toContain(`#${d.units[0]!.hash}`);
  });
});
