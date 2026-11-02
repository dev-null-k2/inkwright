/**
 * Importers from other note apps (packages/core/src/importers, docs/IMPORTERS.md): Evernote ENEX,
 * Notion's Markdown & CSV export, OneNote's Word / web-archive / web-page exports, PDF notebooks
 * (GoodNotes, Notability) and web clips — each into the Markdown vault the Obsidian importer lays
 * out, and end to end into a vault.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIP_LIMITS, MemoryFS, Vault, forMarkdownImport, clipToMarkdown, decodeClip, docxToMarkdown, encodeClip, enexDate, enexToNotes, htmlToMarkdown, importObsidianVault, md5Hex,
  mhtmlToNote, notesToVaultFiles, notionToVaultFiles, oneNoteToNotes, parseCsvRows, parseEnex, pdfNotebookApp, planPdfSections, stripNotionIds, uniqueNames, type VaultFile,
} from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const file = (path: string, text: string | Uint8Array): VaultFile => ({ path, bytes: typeof text === 'string' ? enc.encode(text) : text });
const text = (files: VaultFile[], path: string) => dec.decode(files.find((f) => f.path === path)!.bytes);

describe('md5 (Evernote resource hashes)', () => {
  it('matches RFC 1321 test vectors', () => {
    expect(md5Hex(enc.encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(enc.encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(enc.encode('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
});

describe('HTML to Markdown', () => {
  it('keeps structure: headings, emphasis, lists, links, tables, code, checkboxes', () => {
    const md = htmlToMarkdown('<h2>Plan</h2><p>Ship <b>Friday</b> &amp; <i>tell</i> <a href="https://x.example/a(b)">Ana</a>.</p><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol><li>first</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>1|2</td><td>3</td></tr></table><pre>  keep   spaces</pre><div><en-todo checked="true"/>done</div>');
    expect(md).toContain('## Plan');
    expect(md).toContain('Ship **Friday** & _tell_ [Ana](https://x.example/a%28b%29).');
    expect(md).toMatch(/- one\n {2}- nested\n- two/);
    expect(md).toContain('1. first');
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1\\|2 | 3 |');
    expect(md).toContain('  keep   spaces');
    expect(md).toContain('[x] done');
  });
  it('drops scripts, styles and dangerous links', () => {
    const md = htmlToMarkdown('<script>alert(1)</script><style>p{}</style><p><a href="javascript:alert(1)">click</a> <img src="x" onerror="alert(1)" alt="pic"></p>');
    expect(md).not.toMatch(/alert|javascript|onerror/);
    expect(md).toContain('click');
  });
});

describe('Evernote (.enex)', () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const pdf = enc.encode('%PDF-1.4 fake');
  const enex = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20261101T120000Z" application="Evernote" version="10.105">
  <note>
    <title>Trip &amp; plans</title>
    <created>20250102T030405Z</created><updated>20250103T000000Z</updated>
    <tag>travel</tag><tag>kyoto 2025</tag>
    <note-attributes><source-url>https://example.com/kyoto</source-url><author>Ana</author></note-attributes>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Book the <b>ryokan</b></div><div><en-todo checked="false"/>pack</div><en-media hash="${md5Hex(png)}" type="image/png"/><en-crypt hint="pw">U2FsdGVk</en-crypt></en-note>]]></content>
    <resource><data encoding="base64">${b64(png)}</data><mime>image/png</mime><resource-attributes><file-name>map.png</file-name></resource-attributes></resource>
    <resource><data encoding="base64">${b64(pdf)}</data><mime>application/pdf</mime><resource-attributes><file-name>tickets.pdf</file-name></resource-attributes></resource>
  </note>
  <note><title>Empty</title><content><![CDATA[<en-note/>]]></content></note>
</en-export>`;

  it('parses dates, tags, attributes and resources with their MD5 hashes', () => {
    expect(enexDate('20250102T030405Z')).toBe(Date.UTC(2025, 0, 2, 3, 4, 5));
    const [n] = parseEnex(enex);
    expect(n!.title).toBe('Trip & plans');
    expect(n!.tags).toEqual(['travel', 'kyoto 2025']);
    expect(n!.sourceUrl).toBe('https://example.com/kyoto');
    expect(n!.resources.map((r) => r.hash)).toEqual([md5Hex(png), md5Hex(pdf)]);
    expect(n!.resources[0]!.bytes).toEqual(png);
  });

  it('becomes notes with attachments in place, unplaced ones at the end, encrypted text reported', () => {
    const r = enexToNotes('Travel.enex', enex);
    expect(r.notes).toBe(2);
    expect(r.attachments).toBe(2);
    expect(r.warnings.join()).toMatch(/encrypted text/);
    const files = notesToVaultFiles(r.items);
    const md = text(files, 'Travel/Trip & plans.md');
    expect(md).toMatch(/^---\ntags:/);
    expect(md).toContain('kyoto-2025');
    expect(md).toContain('source: https://example.com/kyoto');
    expect(md).toContain('Book the **ryokan**');
    expect(md).toContain('[ ] pack');
    expect(md).toContain('![](<_attachments/Trip & plans/map.png>)');
    expect(md).toContain('![tickets.pdf](<_attachments/Trip & plans/tickets.pdf>)');
    expect(md).toContain('Encrypted text left out');
    expect(files.find((f) => f.path === 'Travel/_attachments/Trip & plans/map.png')!.bytes).toEqual(png);
  });

  it('imports into a vault through the Markdown importer', async () => {
    const v = new Vault(new MemoryFS());
    await v.init();
    const rep = await importObsidianVault(v, forMarkdownImport(notesToVaultFiles(enexToNotes('Travel.enex', enex).items)), { paper: { style: 'blank', tint: 'white', texture: 'standard', spacing: 0 }, pageSize: { name: 'A4', width: 793.7, height: 1122.5 }, origin: 'import' });
    expect(rep.noteIds.length).toBe(2);
    const notes = await v.listNotes();
    expect(notes.map((n) => n.title).sort()).toEqual(['Empty', 'Trip & plans']);
    expect(notes.find((n) => n.title === 'Trip & plans')!.tags).toContain('travel');
    expect((await v.listNotebooks()).map((b) => b.name)).toContain('Travel');
    const trip = notes.find((n) => n.title === 'Trip & plans')!;
    const pages = await v.readPages(trip);
    expect(pages.flatMap((p) => p.texts ?? []).every((t) => t.origin === 'import')).toBe(true);
    expect(pages.flatMap((p) => p.images ?? []).length).toBeGreaterThan(0);
  });
});

describe('Notion (Markdown & CSV export)', () => {
  const ID1 = '0123456789abcdef0123456789abcdef';
  const ID2 = 'fedcba9876543210fedcba9876543210';
  const ID3 = '00112233445566778899aabbccddeeff';
  const exportFiles = [
    file(`Roadmap ${ID1}.md`, `# Roadmap\n\nTags: planning, Q4 goals\nOwner: Ana\n\nSee [Launch](Roadmap%20${ID1}/Launch%20${ID2}.md) and ![](Roadmap%20${ID1}/chart.png).\nExternal [site](https://notion.so/x).\n`),
    file(`Roadmap ${ID1}/Launch ${ID2}.md`, '# Launch\n\nShip Friday.\n'),
    file(`Roadmap ${ID1}/chart.png`, new Uint8Array([1, 2, 3])),
    file(`Tasks ${ID3}.csv`, 'Name,Status,Notes\nWrite docs,Done,"multi\nline"\n'),
    file(`Tasks ${ID3}_all.csv`, 'Name,Status,Notes\nWrite docs,Done,"multi\nline"\nShip,"In progress","a, b"\n'),
    file(`Tasks ${ID3}/Write docs ${ID2}.md`, '# Write docs\n\nDone.\n'),
  ];
  it('strips ids from paths and links, drops the repeated title, turns Tags into tags', () => {
    expect(stripNotionIds(`A ${ID1}/B ${ID2}.md`)).toBe('A/B.md');
    const r = notionToVaultFiles(exportFiles);
    const roadmap = text(r.files, 'Roadmap.md');
    expect(roadmap).toMatch(/^---\ntags: \["planning", "Q4-goals"\]\n---\n\nOwner: Ana/);
    expect(roadmap).toContain('[Launch](<Roadmap/Launch.md>)');
    expect(roadmap).toContain('![](<Roadmap/chart.png>)');
    expect(roadmap).toContain('[site](https://notion.so/x)');
    expect(text(r.files, 'Roadmap/Launch.md')).toBe('Ship Friday.\n');
    expect(r.files.some((f) => f.path === 'Roadmap/chart.png')).toBe(true);
  });
  it('makes each database a table note from its _all.csv, linking rows that have pages', () => {
    expect(parseCsvRows('a,"b ""q""",c\r\n1,2\n')).toEqual([['a', 'b "q"', 'c'], ['1', '2']]);
    const r = notionToVaultFiles(exportFiles);
    const db = text(r.files, 'Tasks.md');
    expect(db).toContain('2 rows');
    expect(db).toContain('| [[Write docs]] | Done | multi line |');
    expect(db).toContain('| [[Ship]] | In progress | a, b |');
    expect(r.notes).toBe(4);
    expect(r.attachments).toBe(1);
  });
  it('refuses what is not a Notion export', () => {
    expect(() => notionToVaultFiles([file('notes/plain.md', 'x')])).toThrow(/Notion/);
  });
});

describe('OneNote exports', () => {
  const docx = (body: string | string[]) => [
    { path: 'word/document.xml', bytes: enc.encode(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${[body].flat().join("")}</w:body></w:document>`) },
    { path: 'word/_rels/document.xml.rels', bytes: enc.encode('<Relationships><Relationship Id="rId5" Type="image" Target="media/image1.png"/></Relationships>') },
    { path: 'word/media/image1.png', bytes: new Uint8Array([9, 9, 9]) },
  ];
  const para = (text: string, style?: string, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

  it('reads a Word export: title, headings, lists, bold runs, pictures', () => {
    const r = docxToMarkdown(docx([
      para('Meeting', 'Title'),
      para('Agenda', 'Heading1'),
      para('First item', undefined, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Decided</w:t></w:r><w:r><w:t xml:space="preserve">: ship it</w:t></w:r></w:p>',
      '<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>',
    ]));
    expect(r.title).toBe('Meeting');
    expect(r.markdown).toContain('# Agenda');
    expect(r.markdown).toMatch(/- First item/);
    expect(r.markdown).toContain('**Decided**: ship it');
    expect(r.images.map((i) => i.name)).toEqual(['image1.png']);
    expect(r.markdown).toContain('![](<image1.png>)');
  });

  it('reads a single-file web page (.mht) with its pictures', () => {
    const mht = [
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="----=_NextPart_01"',
      '',
      '------=_NextPart_01',
      'Content-Location: file:///C:/page.htm',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<html><head><title>Ideas</title></head><body><p>Caf=C3=A9 plan =3D good</p><img src=3D"page_files/image001.png"></body></html>',
      '',
      '------=_NextPart_01',
      'Content-Location: file:///C:/page_files/image001.png',
      'Content-Transfer-Encoding: base64',
      'Content-Type: image/png',
      '',
      b64(new Uint8Array([7, 7, 7])),
      '',
      '------=_NextPart_01--',
    ].join('\r\n');
    const r = mhtmlToNote(mht);
    expect(r.title).toBe('Ideas');
    expect(r.markdown).toContain('Café plan = good');
    expect(r.images).toEqual([{ name: 'image001.png', bytes: new Uint8Array([7, 7, 7]) }]);
  });

  it('turns a folder of exports into notes, and explains .one files', () => {
    const { items, warnings } = oneNoteToNotes([
      { path: 'Work/Standup.docx', bytes: new Uint8Array([0]) },
      { path: 'Work/Notes.html', bytes: enc.encode('<html><head><meta charset="utf-8"><title>Notes</title></head><body><p>Hello <img src="Notes_files/a.png"></p></body></html>') },
      { path: 'Work/Notes_files/a.png', bytes: new Uint8Array([5]) },
      { path: 'Work/Section.one', bytes: new Uint8Array([0]) },
    ], () => docx(para('Standup', 'Title') + para('Blocked on review')), 'Work');
    expect(items.map((i) => i.title)).toEqual(['Standup', 'Notes']);
    expect(items[1]!.attachments!.map((a) => a.name)).toEqual(['a.png']);
    expect(warnings.join()).toMatch(/Section\.one.*File › Export/);
  });
});

describe('PDF notebooks (GoodNotes, Notability)', () => {
  it('names the app from the PDF metadata', () => {
    expect(pdfNotebookApp({ producer: 'GoodNotes 6.4' })).toBe('goodnotes');
    expect(pdfNotebookApp({ creator: 'Notability' })).toBe('notability');
    expect(pdfNotebookApp({ producer: 'Skia/PDF' })).toBeNull();
  });
  it('splits at top-level outline entries, covering every page once', () => {
    expect(planPdfSections('Biology', 10, [{ title: 'Cells', page: 2 }, { title: 'Genetics', page: 6 }])).toEqual([
      { title: 'Biology', from: 0, to: 1 }, { title: 'Cells', from: 2, to: 5 }, { title: 'Genetics', from: 6, to: 9 },
    ]);
    expect(planPdfSections('Biology', 10, null)).toEqual([{ title: 'Biology', from: 0, to: 9 }]);
    expect(planPdfSections('B', 10, [{ title: 'Only', page: 3 }])).toEqual([{ title: 'B', from: 0, to: 9 }]);
    // A page-by-page index is not sections.
    expect(planPdfSections('B', 5, Array.from({ length: 5 }, (_, i) => ({ title: `Page ${i + 1}`, page: i })))).toEqual([{ title: 'B', from: 0, to: 4 }]);
    expect(planPdfSections('B', 4, [{ title: 'x', page: null }, { title: 'A', page: 1 }, { title: 'C', page: 3 }, { title: 'beyond', page: 9 }])).toEqual([{ title: 'B', from: 0, to: 0 }, { title: 'A', from: 1, to: 2 }, { title: 'C', from: 3, to: 3 }]);
  });
});

describe('web clips', () => {
  const clip = { v: 1 as const, title: 'A long read', url: 'https://example.com/post?id=1', text: '# Heading\n\nFirst paragraph.\n\n- item', site: 'Example', byline: 'Ana', savedAt: Date.UTC(2026, 10, 2) };
  it('round-trips through the URL fragment', () => {
    const frag = encodeClip(clip);
    expect(frag.startsWith('clip=')).toBe(true);
    expect(frag).toMatch(/^clip=[A-Za-z0-9_-]+$/);
    expect(decodeClip(`#${frag}`)).toEqual(clip);
    expect(decodeClip('#note/123')).toBeNull();
  });
  it('treats the payload as untrusted: http(s) only, size limits, plain text', () => {
    const bad = (c: unknown) => `#clip=${Buffer.from(JSON.stringify(c)).toString('base64url')}`;
    expect(() => decodeClip(bad({ ...clip, url: 'javascript:alert(1)' }))).toThrow(/http and https/);
    expect(() => decodeClip(bad({ ...clip, url: undefined }))).toThrow(/no url/);
    expect(() => decodeClip('#clip=@@@')).toThrow(/damaged/);
    const long = decodeClip(bad({ ...clip, title: 'x'.repeat(5000), text: 'y'.repeat(CLIP_LIMITS.text + 10) }))!;
    expect(long.title.length).toBe(CLIP_LIMITS.title);
    expect(long.text.length).toBe(CLIP_LIMITS.text);
  });
  it('becomes a note that says where it came from', () => {
    const md = clipToMarkdown(clip);
    expect(md).toMatch(/^> Clipped from \[Example\]\(https:\/\/example\.com\/post\?id=1\) on 2026-11-02 · by Ana\n\n# Heading/);
  });
});

describe('vault files', () => {
  it('makes attachment names unique per note and titles unique per folder', () => {
    expect(uniqueNames(['a.png', 'A.png', 'b', 'a.png'])).toEqual(['a.png', 'A (2).png', 'b', 'a (3).png']);
    const files = notesToVaultFiles([{ folder: 'X', title: 'Same', body: 'one' }, { folder: 'X', title: 'Same', body: 'two' }, { folder: 'X/../Y', title: 'a/b', body: '' }]);
    expect(files.map((f) => f.path)).toEqual(['X/Same.md', 'X/Same (2).md', expect.stringMatching(/^X\/[^/]*\/Y\/a[^/]*b\.md$|^X\/\.\.\/Y/)]);
    expect(files.every((f) => !f.path.split('/').includes('..'))).toBe(true);
  });
});
