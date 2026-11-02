import { describe, expect, it } from 'vitest';
import {
  NoteDocument, findMentions, formatWikiLink, fuzzyScore, inkLinksFromRecognition, linkTrigger, suggestNotes, linkFirstMention, linkLabel, newNote, newPage, noteLinkOccurrences,
  parseTags, parseWikiLinks, renameLinksInPage, renameLinksInText, resolveWikiTarget, stripWikiLinks, syncInlineTags,
  type NoteMeta, type NotebookMeta, type PageInk,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

const note = (id: string, title: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({ ...newNote({ id, title, pageId: `${id}p`, now: 1000 }), ...extra });

describe('wiki link parsing', () => {
  it('finds titles, pages, headings, aliases and embeds', () => {
    const ls = parseWikiLinks('See [[Biology]] and [[Chem#Page 2|lab]], ![[Diagram]] and [[#Page 3]].');
    expect(ls.map((l) => [l.title, l.subpath, l.page, l.alias, l.embed])).toEqual([
      ['Biology', undefined, undefined, undefined, false],
      ['Chem', 'Page 2', 2, 'lab', false],
      ['Diagram', undefined, undefined, undefined, true],
      ['', 'Page 3', 3, undefined, false],
    ]);
    expect(ls[1]!.target).toBe('Chem#Page 2');
    expect(parseWikiLinks('no links [here]')).toEqual([]);
    expect(parseWikiLinks('[[ ]] empty')).toEqual([]);
  });

  it('labels and strips links the way the page shows them', () => {
    expect(linkLabel({ title: 'Chem', subpath: 'Page 2' })).toBe('Chem › Page 2');
    expect(stripWikiLinks('A [[Chem|lab notes]] and [[Bio]]')).toBe('A lab notes and Bio');
    expect(formatWikiLink('Bio', { page: 2 })).toBe('[[Bio#Page 2]]');
    expect(formatWikiLink('Q[1]|x')).toBe('[[Q 1 x|Q 1 |x]]');
  });
});

describe('tags', () => {
  it('reads #tags like Obsidian does', () => {
    expect(parseTags('#idea and #project/inkwright, (#todo) but not # heading, ## h2, [[Note#Page 2]], #2024, http://x.com/#frag or `#code`')).toEqual(['idea', 'project/inkwright', 'todo']);
    expect(parseTags('#Idea then #idea again')).toEqual(['Idea']);
    expect(parseTags('#y2024 #café')).toEqual(['y2024', 'café']);
  });

  it('keeps manual tags and follows inline ones', () => {
    let m = note('a', 'A', { tags: ['manual'] });
    m = syncInlineTags(m, 'thoughts #idea #later');
    expect(m.tags).toEqual(['manual', 'idea', 'later']);
    expect(m.inlineTags).toEqual(['idea', 'later']);
    const same = syncInlineTags(m, '#idea #later');
    expect(same).toBe(m);
    m = syncInlineTags(m, 'only #idea now');
    expect(m.tags).toEqual(['manual', 'idea']);
    m = syncInlineTags(m, 'nothing');
    expect(m.tags).toEqual(['manual']);
    expect(m.inlineTags).toBeUndefined();
  });
});

describe('resolution', () => {
  const nbs: NotebookMeta[] = [
    { id: 'school', name: 'School', color: '#FF000000', createdAt: 0, formatVersion: 2 },
    { id: 'work', name: 'Work', color: '#FF000000', createdAt: 0, formatVersion: 2 },
  ];
  const notes = [
    note('1', 'Biology', { notebookId: 'school', updatedAt: 10, pageIds: ['a', 'b', 'c'] }),
    note('2', 'biology', { notebookId: 'work', updatedAt: 20 }),
    note('3', 'Old', { trashedAt: 5 }),
    note('4', 'Plans'),
  ];

  it('matches titles case-insensitively, preferring the linking notebook, then recency', () => {
    expect(resolveWikiTarget('BIOLOGY', notes)?.note.id).toBe('2');
    expect(resolveWikiTarget('Biology', notes, { from: note('x', 'x', { notebookId: 'school' }) })?.note.id).toBe('1');
    expect(resolveWikiTarget('Old', notes)).toBeNull();
    expect(resolveWikiTarget('Plans.md', notes)?.note.id).toBe('4');
  });

  it('understands folder paths, pages, ids and self links', () => {
    expect(resolveWikiTarget('School/Biology', notes, { notebooks: nbs })?.note.id).toBe('1');
    expect(resolveWikiTarget('Biology#Page 2', notes, { from: note('x', 'x', { notebookId: 'school' }) })).toMatchObject({ pageIndex: 1 });
    expect(resolveWikiTarget('Biology#Page 9', notes, { from: note('x', 'x', { notebookId: 'school' }) })).toMatchObject({ pageIndex: 2 });
    expect(resolveWikiTarget('Anything', notes, { noteId: '4' })?.note.id).toBe('4');
    const self = note('s', 'Self', { pageIds: ['p', 'q'] });
    expect(resolveWikiTarget('#Page 2', notes, { from: self })).toEqual({ note: self, pageIndex: 1 });
  });
});

describe('rename', () => {
  it('rewrites links in text keeping pages, aliases and paths', () => {
    const t = 'see [[Bio]], [[bio#Page 2|lab]], [[School/Bio]], ![[Bio]] and [[Biology]]';
    expect(renameLinksInText(t, 'Bio', 'Life science')).toBe('see [[Life science]], [[Life science#Page 2|lab]], [[School/Life science]], ![[Life science]] and [[Biology]]');
  });

  it('updates typed text, recognized handwriting and ink links on a page', () => {
    const page: PageInk = {
      ...newPage('p'),
      strokes: [stroke('s1', word(0, 0))],
      texts: [{ id: 't', x: 0, y: 0, width: 100, text: 'go to [[Bio]]', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }],
      recognizedText: 'ink says [[Bio]]',
      links: [{ id: 'l', strokeIds: ['s1'], target: 'Bio#Page 1', noteId: 'n1', createdAt: 0 }],
    };
    const next = renameLinksInPage(page, 'Bio', 'Biology', 'n1');
    expect(next.texts![0]!.text).toBe('go to [[Biology]]');
    expect(next.recognizedText).toBe('ink says [[Biology]]');
    expect(next.links![0]!.target).toBe('Biology#Page 1');
    expect(renameLinksInPage(page, 'Other', 'X')).toBe(page);
  });
});

describe('occurrences and mentions', () => {
  it('collects typed, handwritten and ink links with their lines', () => {
    const p: PageInk = {
      ...newPage('p'),
      strokes: [stroke('s1', word(0, 0)), stroke('s2', word(0, 40))],
      texts: [{ id: 't', x: 0, y: 0, width: 100, text: 'Intro\n- read [[Bio#Page 2]] tonight', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }],
      recognizedText: 'call [[Mum]]',
      links: [{ id: 'l1', strokeIds: ['s2'], target: 'Plans', createdAt: 0 }, { id: 'gone', strokeIds: ['erased'], target: 'Lost', createdAt: 0 }],
    };
    const occ = noteLinkOccurrences([p]);
    expect(occ.map((o) => [o.source, o.title, o.page, o.context])).toEqual([
      ['text', 'Bio', 2, 'read Bio › Page 2 tonight'],
      ['handwriting', 'Mum', undefined, 'call Mum'],
      ['ink', 'Plans', undefined, ''],
    ]);
  });

  it('finds unlinked mentions as whole words and links the first', () => {
    expect(findMentions('Biology class; biology! not microbiology, [[Biology]]', 'Biology')).toEqual([{ start: 0, end: 7 }, { start: 15, end: 22 }]);
    expect(findMentions('a b', 'ab')).toEqual([]);
    expect(linkFirstMention('notes on project   plan today', 'Project plan')).toBe('notes on [[project   plan]] today');
    expect(linkFirstMention('see microbiology and Bio-logy', 'Bio')).toBe('see microbiology and [[Bio]]-logy');
    expect(linkFirstMention('Read Biology', 'biology')).toBe('Read [[Biology]]');
    expect(linkFirstMention('nothing here', 'Biology')).toBeNull();
  });

  it('turns recognized [[links]] into ink links over the line', () => {
    const page: PageInk = { ...newPage('p'), strokes: [stroke('a', word(0, 0)), stroke('b', word(0, 50))], links: [{ id: 'x', strokeIds: ['b'], target: 'Old', createdAt: 0 }] };
    let k = 0;
    const out = inkLinksFromRecognition(page, [{ text: 'see [[Bio]]', strokeIds: ['a'] }, { text: '[[Again]]', strokeIds: ['b'] }, { text: 'plain', strokeIds: ['c'] }], { now: 5, newId: () => `id${k++}`, resolve: (t) => (t === 'Bio' ? 'n1' : undefined) });
    expect(out).toEqual([{ id: 'id0', strokeIds: ['a'], target: 'Bio', noteId: 'n1', createdAt: 5 }]);
  });
});

describe('ink links in the document', () => {
  it('are undoable, follow moved ink and survive page duplication', () => {
    let k = 0;
    const doc = new NoteDocument(note('n', 'N', { pageIds: ['p'] }), [{ ...newPage('p'), strokes: [stroke('s', word(0, 0))] }], () => 1, () => `id${k++}`);
    doc.commit(0, { label: 'Link', links: { removed: [], added: [{ index: 0, item: { id: 'L', strokeIds: ['s'], target: 'Bio', createdAt: 0 } }] } });
    expect(doc.page(0).links).toHaveLength(1);
    const moved = doc.transform(0, { strokes: new Set(['s']) }, 'Move', { stroke: (s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: p.x + 10 })) }) });
    const newId = [...moved.strokes][0]!;
    expect(doc.page(0).links![0]!.strokeIds).toEqual([newId]);
    doc.undo();
    expect(doc.page(0).links![0]!.strokeIds).toEqual(['s']);
    doc.undo();
    expect(doc.page(0).links).toBeUndefined();
    doc.redo();
    const i = doc.duplicatePage(0);
    const dup = doc.page(i);
    expect(dup.links![0]!.strokeIds).toEqual([dup.strokes[0]!.id]);
    expect(dup.links![0]!.id).not.toBe('L');
  });
});


describe('suggestions', () => {
  it('ranks fuzzy title matches', () => {
    const notes = [note('1', 'Biology lab', { updatedAt: 1 }), note('2', 'Microbiology'), note('3', 'Big ideas'), note('4', 'Chemistry'), note('5', 'Biology', { trashedAt: 1 })];
    expect(suggestNotes('bio', notes).map((n) => n.title)).toEqual(['Biology lab', 'Microbiology']);
    expect(suggestNotes('bg id', notes).map((n) => n.title)).toEqual(['Big ideas']);
    expect(suggestNotes('', notes, { limit: 2 })).toHaveLength(2);
    expect(fuzzyScore('xyz', 'Biology')).toBeLessThan(0);
  });

  it('detects what is being typed at the caret', () => {
    expect(linkTrigger('see [[Bio')).toEqual({ kind: 'note', query: 'Bio', start: 4 });
    expect(linkTrigger('see [[Bio#Pa')).toEqual({ kind: 'page', title: 'Bio', query: 'Pa', start: 4 });
    expect(linkTrigger('see [[Bio]] and')).toBeNull();
    expect(linkTrigger('see [[Bio|ali')).toBeNull();
    expect(linkTrigger('idea #proj')).toEqual({ kind: 'tag', query: 'proj', start: 5 });
    expect(linkTrigger('#')).toEqual({ kind: 'tag', query: '', start: 0 });
    expect(linkTrigger('issue#1')).toBeNull();
  });
});
