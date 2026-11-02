import { describe, expect, it } from 'vitest';
import {
  ForceLayout, KeywordRelatedNotes, KnowledgeIndex, MemoryFS, TemplateStore, Vault, applyTemplate, buildGraph, dailyTitle, dayKey, expandTemplate,
  findDailyNote, findJournal, formatDate, newNote, newPage, notebookNodeId, parseDayKey, tagNodeId, templateFromNote,
  type NoteMeta, type NotebookMeta, type PageInk, type TextBox,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

const box = (id: string, text: string, y = 0): TextBox => ({ id, x: 0, y, width: 300, text, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 });
const note = (id: string, title: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({ ...newNote({ id, title, pageId: `${id}p`, now: 1000 }), ...extra });
const page = (id: string, texts: string[], extra: Partial<PageInk> = {}): PageInk => ({ ...newPage(id), texts: texts.map((t, i) => box(`${id}t${i}`, t, i * 40)), ...extra });

function vaultIndex() {
  const k = new KnowledgeIndex();
  k.update(note('bio', 'Biology', { notebookId: 'school', createdAt: 100 }), [page('b1', ['Cells and #genetics. See [[Chemistry]].'])]);
  k.update(note('chem', 'Chemistry', { notebookId: 'school', createdAt: 200 }), [page('c1', ['Atoms, bonds and molecules.']), page('c2', ['Back to [[Biology#Page 1|bio]]'])]);
  k.update(note('diary', 'Diary', { createdAt: 300 }), [page('d1', ['Studied biology today #genetics', 'chemistry exam soon'], { recognizedText: 'remember Biology lab' })]);
  k.update(note('plans', 'Plans', { notebookId: 'work', tags: ['work'], createdAt: 400 }), [{ ...newPage('p1'), strokes: [stroke('s', word(0, 0))], links: [{ id: 'L', strokeIds: ['s'], target: 'Diary', noteId: 'diary', createdAt: 0 }] }]);
  k.update(note('gone', 'Gone', { trashedAt: 1 }), [page('g1', ['[[Biology]]'])]);
  return k;
}

const notebooks: NotebookMeta[] = [
  { id: 'school', name: 'School', color: '#FF3D5A80', createdAt: 0, formatVersion: 2 },
  { id: 'bio-sub', name: 'Labs', color: '#FF3D7A5A', parentId: 'school', createdAt: 0, formatVersion: 2 },
  { id: 'work', name: 'Work', color: '#FFB8432F', createdAt: 0, formatVersion: 2 },
];

describe('knowledge index', () => {
  it('lists backlinks with context, ignoring trashed notes', () => {
    const k = vaultIndex();
    expect(k.has('gone')).toBe(false);
    expect(k.backlinks('biology')).toEqual([]);
    const bl = k.backlinks('bio');
    expect(bl).toEqual([{ noteId: 'chem', title: 'Chemistry', pageIndex: 1, source: 'text', snippet: 'Back to bio', targetPage: 1 }]);
    expect(k.backlinks('diary').map((b) => [b.noteId, b.source])).toEqual([['plans', 'ink']]);
  });

  it('finds unlinked mentions in typed text and handwriting', () => {
    const k = vaultIndex();
    const m = k.unlinkedMentions('bio');
    expect(m.map((x) => [x.noteId, x.source, x.pageIndex, x.snippet])).toEqual([
      ['diary', 'text', 0, 'Studied biology today #genetics'],
      ['diary', 'handwriting', 0, 'remember Biology lab'],
    ]);
    expect(k.unlinkedMentions('chem').map((x) => x.noteId)).toEqual(['diary']);
  });

  it('merges inline #tags with manual tags and follows renames', () => {
    const k = vaultIndex();
    expect(k.tagsOf('diary')).toEqual(['genetics']);
    expect(k.tagsOf('plans')).toEqual(['work']);
    expect(k.allTags()[0]).toEqual({ tag: 'genetics', count: 2 });
    k.updateMeta(note('chem', 'Chem', { notebookId: 'school' }));
    expect(k.outgoing('bio')[0]!.note).toBeNull();
    k.updateMeta(note('chem', 'Chemistry', { notebookId: 'school', trashedAt: 5 }));
    expect(k.has('chem')).toBe(false);
  });

  it('relates notes by shared keywords and tags', async () => {
    const k = vaultIndex();
    const rel = await new KeywordRelatedNotes(k).relatedNotes('bio');
    expect(rel[0]!.id).toBe('diary');
    expect(rel[0]!.score).toBeGreaterThan(0);
    expect(rel.every((r) => r.score <= 1)).toBe(true);
    expect(rel.some((r) => r.id === 'bio')).toBe(false);
  });
});

describe('graph', () => {
  it('builds note, tag and notebook nodes with link, tag, membership and related edges', () => {
    const k = vaultIndex();
    const g = buildGraph(k, notebooks, { related: new Map([['bio', [{ id: 'diary', score: 0.5 }, { id: 'chem', score: 0.9 }, { id: 'plans', score: 0.05 }]]]) });
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['bio', 'chem', 'diary', notebookNodeId('school'), notebookNodeId('work'), 'plans', tagNodeId('genetics'), tagNodeId('work')].sort());
    const kinds = (kind: string) => g.edges.filter((e) => e.kind === kind).map((e) => [e.source, e.target].sort().join('-')).sort();
    // bio→chem and chem→bio fold into one thread with weight 2.
    expect(kinds('link')).toEqual(['bio-chem', 'diary-plans']);
    expect(g.edges.find((e) => e.kind === 'link' && [e.source, e.target].includes('bio'))!.weight).toBe(2);
    expect(kinds('tag')).toEqual(['bio-tag:genetics', 'diary-tag:genetics', 'plans-tag:work']);
    expect(kinds('notebook')).toEqual(['bio-nb:school', 'chem-nb:school', 'nb:work-plans']);
    // Already linked → no related edge; below the threshold → none.
    expect(kinds('related')).toEqual(['bio-diary']);
    expect(g.clusters.map((c) => [c.id, c.nodeIds.sort()])).toEqual([['school', ['bio', 'chem']], ['work', ['plans']]]);
    expect(g.nodes.find((n) => n.id === 'bio')).toMatchObject({ color: '#FF3D5A80', cluster: 'school', degree: 4 });
  });

  it('filters by notebook, tag and time', () => {
    const k = vaultIndex();
    expect(buildGraph(k, notebooks, { notebookIds: ['school'], tags: false, notebooks: false }).nodes.map((n) => n.id).sort()).toEqual(['bio', 'chem']);
    expect(buildGraph(k, notebooks, { tag: 'GENETICS', notebooks: false }).nodes.map((n) => n.id).sort()).toEqual(['bio', 'diary', tagNodeId('genetics')]);
    const early = buildGraph(k, notebooks, { until: 250, tags: false, notebooks: false });
    expect(early.nodes.map((n) => n.id).sort()).toEqual(['bio', 'chem']);
    expect(early.edges).toHaveLength(1);
  });

  it('lays out deterministically with linked notes closer and clusters together', () => {
    const k = new KnowledgeIndex();
    const nbs: NotebookMeta[] = [{ id: 'a', name: 'A', color: '#FF000000', createdAt: 0, formatVersion: 2 }, { id: 'b', name: 'B', color: '#FF000000', createdAt: 0, formatVersion: 2 }];
    for (let i = 0; i < 24; i++) {
      const nb = i < 12 ? 'a' : 'b';
      k.update(note(`n${i}`, `Note ${i}`, { notebookId: nb }), [page(`p${i}`, [i % 12 ? `[[Note ${i - 1}]]` : 'start'])]);
    }
    const g = buildGraph(k, nbs, { tags: false });
    const run = (dims: 2 | 3) => { const l = new ForceLayout(g, { dims }); l.run(400); return l; };
    const l3 = run(3);
    expect(l3.settled).toBe(true);
    expect([...run(3).positions().values()]).toEqual([...l3.positions().values()]);
    const d = (a: string, b: string) => { const p = l3.position(a)!, q = l3.position(b)!; return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); };
    expect(d('n3', 'n4')).toBeLessThan(d('n3', 'n17'));
    const centre = (ids: string[]) => ids.map((id) => l3.position(id)!).reduce((s, p) => ({ x: s.x + p.x / ids.length, y: s.y + p.y / ids.length, z: s.z + p.z / ids.length }), { x: 0, y: 0, z: 0 });
    const ca = centre(Array.from({ length: 12 }, (_, i) => `n${i}`));
    const spreadA = Math.max(...Array.from({ length: 12 }, (_, i) => { const p = l3.position(`n${i}`)!; return Math.hypot(p.x - ca.x, p.y - ca.y, p.z - ca.z); }));
    const cb = centre(Array.from({ length: 12 }, (_, i) => `n${i + 12}`));
    expect(Math.hypot(ca.x - cb.x, ca.y - cb.y, ca.z - cb.z)).toBeGreaterThan(spreadA * 0.5);
    const l2 = run(2);
    expect([...l2.positions().values()].every((p) => p.z === 0)).toBe(true);
    l2.setDims(3);
    l2.run(100);
    expect([...l2.positions().values()].some((p) => p.z !== 0)).toBe(true);
  });

  it('uses Barnes-Hut on large graphs and stays finite', () => {
    const k = new KnowledgeIndex();
    for (let i = 0; i < 400; i++) k.update(note(`n${i}`, `N${i}`), [page(`p${i}`, [`[[N${(i * 7) % 400}]] [[N${(i + 1) % 400}]]`])]);
    const l = new ForceLayout(buildGraph(k, [], { tags: false }), { dims: 3 });
    l.run(60);
    for (const p of l.positions().values()) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    const r = Math.max(...[...l.positions().values()].map((p) => Math.hypot(p.x, p.y, p.z)));
    expect(r).toBeGreaterThan(20);
    expect(r).toBeLessThan(5000);
  });
});

describe('daily notes', () => {
  it('names days and finds the daily note and journal', () => {
    const d = new Date(2026, 10, 1, 9, 5);
    expect(dayKey(d)).toBe('2026-11-01');
    expect(dailyTitle(d)).toBe('2026-11-01');
    expect(parseDayKey('2026-02-30')).toBeNull();
    expect(parseDayKey('2026-11-01')!.getDate()).toBe(1);
    const notes = [note('a', '2026-11-01'), note('b', 'Renamed', { daily: '2026-11-01' }), note('c', '2026-10-31', { trashedAt: 1 })];
    expect(findDailyNote(notes, '2026-11-01')?.id).toBe('b');
    expect(findDailyNote(notes.slice(0, 1), '2026-11-01')?.id).toBe('a');
    expect(findDailyNote(notes, '2026-10-31')).toBeUndefined();
    const nbs: NotebookMeta[] = [{ id: 'x', name: 'journal', color: '#FF000000', parentId: 'p', createdAt: 0, formatVersion: 2 }, { id: 'j', name: 'Journal', color: '#FF000000', createdAt: 0, formatVersion: 2 }];
    expect(findJournal(nbs)?.id).toBe('j');
    expect(findJournal(nbs, 'x')?.id).toBe('x');
  });

  it('expands template placeholders', () => {
    const d = new Date(2026, 10, 1, 14, 7);
    expect(formatDate(d, 'dddd, D MMMM YYYY [at] HH:mm', 'en-US')).toBe('Sunday, 1 November 2026 at 14:07');
    expect(expandTemplate('# {{title}}\n{{date}} {{time}} {{weekday}} {{date:DD/MM}} [[{{yesterday}}]] [[{{tomorrow}}]] {{unknown}}', { date: d, title: 'Day', locale: 'en-US' }))
      .toBe('# Day\n2026-11-01 14:07 Sunday 01/11 [[2026-10-31]] [[2026-11-02]] {{unknown}}');
  });
});

describe('templates', () => {
  it('captures a note and makes fresh notes from it', () => {
    const src = note('n', 'Meeting', { tags: ['meeting', 'idea'], inlineTags: ['idea'], paper: { style: 'dot_grid', tint: 'cream', texture: 'smooth', spacing: 0 } });
    const pages: PageInk[] = [{ ...page('p', ['# {{title}}', 'Date: {{date}}']), strokes: [stroke('s', word(0, 0))], recognizedText: 'old', images: [{ id: 'i', x: 0, y: 0, width: 10, height: 10, asset: 'logo.png', rotation: 0, createdAt: 0 }], links: [{ id: 'l', strokeIds: ['s'], target: 'Bio', createdAt: 0 }] }];
    const t = templateFromNote(src, pages, 'Meeting notes', { id: 'T', now: 5 });
    expect(t).toMatchObject({ id: 'T', name: 'Meeting notes', kind: 'paged', tags: ['meeting'] });
    expect(t.pages[0]!.recognizedText).toBeUndefined();
    let k = 0;
    const made = applyTemplate(t, { title: 'Standup', date: new Date(2026, 10, 1), notebookId: 'nb', now: 9, newId: () => `id${k++}` });
    expect(made.note).toMatchObject({ title: 'Standup', notebookId: 'nb', paper: src.paper, tags: ['meeting'] });
    const p0 = made.pages[0]!;
    expect(p0.texts!.map((x) => x.text)).toEqual(['# Standup', 'Date: 2026-11-01']);
    expect(new Set([made.note.id, p0.id, p0.strokes[0]!.id, p0.texts![0]!.id, p0.images![0]!.id, p0.links![0]!.id]).size).toBe(6);
    expect(p0.links![0]!.strokeIds).toEqual([p0.strokes[0]!.id]);
    expect(made.note.pageIds).toEqual([p0.id]);
  });

  it('stores templates in the vault with their files', async () => {
    const fs = new MemoryFS();
    const vault = new Vault(fs, () => 1000);
    await vault.init();
    const { note: n, pages } = await vault.createNote({ title: 'Lab' });
    await vault.writeAsset(n.id, 'pic.png', new Uint8Array([1, 2, 3]));
    await vault.saveNote(n, [{ ...pages[0]!, images: [{ id: 'i', x: 0, y: 0, width: 5, height: 5, asset: 'pic.png', rotation: 0, createdAt: 0 }] }]);
    const store = new TemplateStore(fs);
    const t = await store.saveFromNote(vault, n.id, 'Lab report');
    expect((await store.list()).map((x) => x.name)).toEqual(['Lab report']);
    const made = await store.createNote(vault, t.id, { title: 'Lab 2' });
    expect(await vault.readAsset(made.note.id, 'pic.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect((await vault.readNote(made.note.id))!.title).toBe('Lab 2');
    await store.rename(t.id, 'Lab write-up');
    expect((await store.read(t.id))!.name).toBe('Lab write-up');
    await store.delete(t.id);
    expect(await store.list()).toEqual([]);
  });
});
