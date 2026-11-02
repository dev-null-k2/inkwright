import { describe, expect, it } from 'vitest';
import { readZip, writeZip } from '@inkstone/sync';
import {
  MemoryFS, Vault, emitYaml, exportObsidianVault, imageDimensions, importObsidianVault, markdownBlocks, obsidianFileName, parseYaml,
  splitFrontmatter, vaultFilesOf, type PageInk, type VaultFile,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PAPER = { style: 'blank', tint: 'white', texture: 'standard', spacing: 0 } as const;
const SIZE = { name: 'A4', width: 793.7, height: 1122.5 };

/** 1×1 PNG header with the given size (enough for dimension sniffing). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

async function sampleVault() {
  const vault = new Vault(new MemoryFS(), () => Date.UTC(2026, 10, 1, 12));
  await vault.init();
  const school = await vault.createNotebook('School');
  const labs = await vault.createNotebook('Labs', '#FF3D7A5A', school.id);
  const bio = await vault.createNote({ title: 'Biology', notebookId: school.id, tags: ['science'] });
  const bioPages: PageInk[] = [
    { ...bio.pages[0]!, texts: [{ id: 't1', x: 0, y: 0, width: 300, text: 'Cells #genetics\nSee [[Q: answers]] and [[Chem lab#Page 2|lab]]', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] },
    { id: 'p2', strokes: [stroke('s', word(0, 0))], recognizedText: 'handwritten mitochondria', links: [{ id: 'L', strokeIds: ['s'], target: 'Chem lab', createdAt: 0 }], formatVersion: 2 },
  ];
  await vault.saveNote({ ...bio.note, pageIds: bioPages.map((p) => p.id), summary: 'All about cells' }, bioPages);
  const chem = await vault.createNote({ title: 'Chem lab', notebookId: labs.id });
  await vault.writeAsset(chem.note.id, 'doc.pdf', enc.encode('%PDF-1.4 fake'));
  await vault.saveNote({ ...chem.note, pageIds: ['c1', 'c2'] }, [
    { id: 'c1', strokes: [], background: { kind: 'pdf', asset: 'doc.pdf', pageNumber: 1 }, formatVersion: 2 },
    { id: 'c2', strokes: [], texts: [{ id: 't', x: 0, y: 0, width: 200, text: 'Back to [[Biology]]', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }], formatVersion: 2 },
  ]);
  await vault.createNote({ title: 'Q: answers' });
  return { vault, school, labs };
}

describe('front matter', () => {
  it('parses the YAML Obsidian writes', () => {
    const y = parseYaml(`title: "Hello: world"
tags:
- one
- "two"
aliases: [A, 'B c']
count: 3
done: true
empty:
nested:
  key: value
  list:
    - x
notes: |
  line 1
  line 2
items:
  - name: a
    n: 1
# comment
url: http://x.com/#y
`);
    expect(y).toEqual({
      title: 'Hello: world', tags: ['one', 'two'], aliases: ['A', 'B c'], count: 3, done: true, empty: null,
      nested: { key: 'value', list: ['x'] }, notes: 'line 1\nline 2', items: [{ name: 'a', n: 1 }], url: 'http://x.com/#y',
    });
  });

  it('round-trips what it writes', () => {
    const data = { tags: ['a', 'b c'], created: '2026-11-01T12:00:00Z', title: 'x: y', n: '007', flag: false, list: [], nested: { k: 'v' } };
    expect(parseYaml(emitYaml(data))).toEqual(data);
    const { data: d, body } = splitFrontmatter(`---\n${emitYaml(data)}---\n\n# Body`);
    expect(d).toEqual(data);
    expect(body).toBe('\n# Body');
    expect(splitFrontmatter('no front matter').data).toEqual({});
  });
});

describe('helpers', () => {
  it('makes safe, readable file names', () => {
    expect(obsidianFileName('Q: answers / notes?')).toBe('Q - answers - notes');
    expect(obsidianFileName('  ..  ')).toBe('Untitled');
    expect(obsidianFileName('[[x]] #tag|y')).toBe('x tagy');
  });

  it('sniffs image sizes', () => {
    expect(imageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(enc.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">'))).toEqual({ width: 120, height: 80 });
    expect(imageDimensions(enc.encode('<svg width="30px" height="20">'))).toEqual({ width: 30, height: 20 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 5, 0, 0, 0]);
    expect(imageDimensions(gif)).toEqual({ width: 10, height: 5 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 100, 3, 0, 0, 0]);
    expect(imageDimensions(jpeg)).toEqual({ width: 100, height: 50 });
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('strips the vault folder and Obsidian internals', () => {
    const files = vaultFilesOf([
      { path: 'My vault/.obsidian/app.json', bytes: new Uint8Array() },
      { path: 'My vault/A.md', bytes: new Uint8Array() },
      { path: 'My vault\\sub\\B.md', bytes: new Uint8Array() },
      { path: '__MACOSX/My vault/._A.md', bytes: new Uint8Array() },
    ]);
    expect(files.map((f) => f.path)).toEqual(['A.md', 'sub/B.md']);
  });

  it('turns embeds and Markdown links into blocks and wiki links', () => {
    const img: VaultFile = { path: 'img/a.png', bytes: png(10, 10) };
    const blocks = markdownBlocks('Intro ![[a.png|200]] mid ![x](img/a.png) [the plan](Plans%20B.md#Goals) ![[Other note]] [web](https://x.y/a.md) end',
      (ref) => (ref.endsWith('a.png') ? img : null), (ref) => (ref === 'Plans B.md' ? 'Plans B' : null));
    expect(blocks.map((b) => (b.kind === 'text' ? b.text : `${b.kind}:${b.kind === 'image' ? b.width ?? '-' : ''}`))).toEqual([
      'Intro', 'image:200', 'mid', 'image:-', '[[Plans B#Goals|the plan]] [[Other note]] [web](https://x.y/a.md) end',
    ]);
  });
});

describe('Obsidian export', () => {
  it('writes notes, folders, properties, links and attachments', async () => {
    const { vault } = await sampleVault();
    const files = await exportObsidianVault(vault);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'Q - answers.md',
      'School/Biology.md',
      'School/Labs/Chem lab.md',
      'attachments/Biology - page 2.svg',
      'attachments/Chem lab - page 1.svg',
      'attachments/Chem lab.pdf',
    ]);
    const md = (p: string) => dec.decode(files.find((f) => f.path === p)!.bytes);
    const bio = md('School/Biology.md');
    const { data, body } = splitFrontmatter(bio);
    expect(data).toMatchObject({ tags: ['science', 'genetics'], created: '2026-11-01T12:00:00Z', summary: 'All about cells' });
    expect(typeof data['inkstone-id']).toBe('string');
    expect(body).toContain('## Page 1');
    expect(body).toContain('See [[Q - answers|Q: answers]] and [[Chem lab#Page 2|lab]]');
    expect(body).toContain('handwritten mitochondria');
    expect(body).toContain('Linked in handwriting: [[Chem lab]]');
    expect(body).toContain('![[Biology - page 2.svg]]');
    expect(splitFrontmatter(md('Q - answers.md')).data.aliases).toEqual(['Q: answers']);
    const chem = md('School/Labs/Chem lab.md');
    expect(chem).toContain('![[Chem lab.pdf]]');
    expect(chem).toContain('Back to [[Biology]]');
    expect(dec.decode(files.find((f) => f.path === 'attachments/Chem lab.pdf')!.bytes)).toBe('%PDF-1.4 fake');
  });
});

describe('Markdown vault import', () => {
  it('brings notes, folders, properties, tags, links and images in', async () => {
    const vault = new Vault(new MemoryFS(), () => 5000);
    await vault.init();
    const existing = await vault.createNotebook('Projects');
    const zip = await writeZip([
      { path: 'Vault/.obsidian/workspace.json', bytes: enc.encode('{}') },
      { path: 'Vault/Inbox.md', bytes: enc.encode('Loose thought #idea linking [[Roadmap]].\n\n![[diagram.png]]\n\nMore text.'), mtime: Date.UTC(2025, 0, 1) },
      { path: 'Vault/Projects/Roadmap.md', bytes: enc.encode('---\ntags: [plan, "q4"]\ncreated: 2025-03-01\nstatus: active\naliases:\n  - The plan\n---\n# Roadmap\nSee [inbox](../Inbox.md) and ![[Spec]].') },
      { path: 'Vault/Projects/Deep/Spec.md', bytes: enc.encode('Spec body') },
      { path: 'Vault/assets/diagram.png', bytes: png(1600, 800) },
      { path: 'Vault/assets/unused.bin', bytes: new Uint8Array([1]) },
    ]);
    const files = (await readZip(zip)).map((e) => ({ path: e.path, bytes: e.bytes, mtime: e.mtime }));
    const r = await importObsidianVault(vault, files, { paper: PAPER, pageSize: SIZE, now: 9000 });
    expect(r.noteIds).toHaveLength(3);
    expect(r.notebooksCreated).toBe(1);
    expect(r.attachments).toBe(1);
    expect(r.skipped).toEqual(['assets/unused.bin']);
    const notes = await vault.listNotes();
    const byTitle = (t: string) => notes.find((n) => n.title === t)!;
    const roadmap = byTitle('Roadmap');
    expect(roadmap.notebookId).toBe(existing.id);
    expect(roadmap.tags).toEqual(['plan', 'q4']);
    expect(roadmap.createdAt).toBe(new Date('2025-03-01T00:00:00').getTime());
    expect(roadmap.properties).toEqual({ status: 'active', aliases: ['The plan'] });
    const rmText = (await vault.readPages(roadmap)).flatMap((p) => p.texts ?? []).map((t) => t.text).join('\n');
    expect(rmText).toBe('# Roadmap\nSee [[Inbox]] and [[Spec]].');
    const spec = byTitle('Spec');
    const deep = (await vault.listNotebooks()).find((n) => n.id === spec.notebookId)!;
    expect(deep).toMatchObject({ name: 'Deep', parentId: existing.id });
    const inbox = byTitle('Inbox');
    expect(inbox.notebookId).toBeUndefined();
    expect(inbox.tags).toEqual(['idea']);
    expect(inbox.inlineTags).toEqual(['idea']);
    expect(inbox.createdAt).toBe(Date.UTC(2025, 0, 1) - (Date.UTC(2025, 0, 1) % 2000));
    const pages = await vault.readPages(inbox);
    const im = pages.flatMap((p) => p.images ?? [])[0]!;
    expect(im.width).toBeCloseTo(SIZE.width - 144, 0);
    expect(im.height).toBeCloseTo((SIZE.width - 144) / 2, 0);
    expect(await vault.readAsset(inbox.id, im.asset)).toEqual(png(1600, 800));
    expect(pages.flatMap((p) => p.texts ?? []).map((t) => t.text)).toEqual(['Loose thought #idea linking [[Roadmap]].', 'More text.']);
  });

  it('flows long text over pages and turns embedded PDFs into pages', async () => {
    const vault = new Vault(new MemoryFS(), () => 1);
    await vault.init();
    const long = Array.from({ length: 160 }, (_, i) => `Line ${i} of a long note`).join('\n');
    await importObsidianVault(vault, [
      { path: 'Long.md', bytes: enc.encode(long + '\n\n![[slides.pdf]]\n\nAfter') },
      { path: 'slides.pdf', bytes: enc.encode('%PDF') },
    ], { paper: PAPER, pageSize: SIZE, pdfPageSizes: async () => [{ width: 612, height: 792 }, { width: 612, height: 792 }] });
    const [n] = await vault.listNotes();
    const pages = await vault.readPages(n!);
    const textPages = pages.filter((p) => p.texts?.length);
    expect(textPages.length).toBeGreaterThan(2);
    expect(textPages.flatMap((p) => p.texts!.map((t) => t.text)).join('\n')).toBe(long + '\nAfter');
    const pdfPages = pages.filter((p) => p.background?.kind === 'pdf');
    expect(pdfPages.map((p) => p.background!.pageNumber)).toEqual([1, 2]);
    expect(pages[pages.length - 1]!.texts![0]!.text).toBe('After');
  });

  it('survives an export → import round trip', async () => {
    const { vault } = await sampleVault();
    const zip = await writeZip(await exportObsidianVault(vault));
    const files = (await readZip(zip)).map((e) => ({ path: e.path, bytes: e.bytes }));
    const target = new Vault(new MemoryFS(), () => 1);
    await target.init();
    await importObsidianVault(target, files, { paper: PAPER, pageSize: SIZE });
    const notes = await target.listNotes();
    expect(notes.map((n) => n.title).sort()).toEqual(['Biology', 'Chem lab', 'Q - answers']);
    const bio = notes.find((n) => n.title === 'Biology')!;
    expect(bio.tags).toEqual(['science', 'genetics']);
    expect(bio.createdAt).toBe(Date.UTC(2026, 10, 1, 12));
    expect(bio.summary).toBe('All about cells');
    const nbs = await target.listNotebooks();
    expect(nbs.map((n) => n.name).sort()).toEqual(['Labs', 'School']);
    const text = (await target.readPages(bio)).flatMap((p) => p.texts ?? []).map((t) => t.text).join('\n');
    expect(text).toContain('[[Q - answers|Q: answers]]');
    expect(text).toContain('[[Chem lab]]');
    // The page picture comes back as an image on the page.
    expect((await target.readPages(bio)).some((p) => p.images?.length)).toBe(true);
    const q = notes.find((n) => n.title === 'Q - answers')!;
    expect(q.properties).toEqual({ aliases: ['Q: answers'] });
  });
});
