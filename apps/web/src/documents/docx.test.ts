import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { strFromU8, unzipSync } from 'fflate';
import { documentExtensions } from './extensions.ts';
import { markdownToHtml, prepareHtml, toMarkdown, type PMNode } from './markdown.ts';
import { fromDocx, toDocx } from './docx.ts';

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });
const load = (html: string) => { const e = new Editor({ extensions: documentExtensions(), content: html }); editors.push(e); return e.getJSON() as PMNode; };

/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const MD = `# Field notes

A **bold** claim, *italic* aside, <u>underlined</u>, ~~struck~~ and \`code\` with [a link](https://example.com/).

## Lists

- Apples
  - Green ones
- Pears

3. Third
4. Fourth

- [x] Done
- [ ] To do

> A quotation.

\`\`\`
line 1
line 2
\`\`\`

| Name | Qty |
| --- | --- |
| Ink | 2 |

<div class="page-break"></div>

![Diagram](assets/d.png)

After the break.
`;

describe('docx', () => {
  it('writes a valid package with styles, numbering, a picture and a title', async () => {
    const json = load(markdownToHtml(MD, (n) => `blob:x/${n}`));
    const bytes = await toDocx(json, { title: 'Field notes', image: async () => ({ bytes: PNG, type: 'png', width: 200, height: 100 }) });
    const zip = unzipSync(bytes);
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/media/image1.png', 'docProps/core.xml']));
    const xml = strFromU8(zip['word/document.xml']!);
    // Well-formed XML that a Word parser accepts.
    expect(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:br w:type="page"/>');
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(strFromU8(zip['word/_rels/document.xml.rels']!)).toContain('Target="https://example.com/" TargetMode="External"');
    expect(strFromU8(zip['docProps/core.xml']!)).toContain('<dc:title>Field notes</dc:title>');
    // The numbered list restarts at 3.
    expect(strFromU8(zip['word/numbering.xml']!)).toContain('<w:startOverride w:val="3"/>');
  });

  it('reads its own output back into the same document', async () => {
    const json = load(markdownToHtml(MD, (n) => `blob:x/${n}`));
    const bytes = await toDocx(json, { title: 'Field notes', image: async () => ({ bytes: PNG, type: 'png', width: 200, height: 100 }) });
    const read = fromDocx(bytes, 'imp');
    expect(read.title).toBe('Field notes');
    expect(read.images).toHaveLength(1);
    expect(read.images[0]!.name).toBe('imp-1.png');
    const back = toMarkdown(load(prepareHtml(read.html, (n) => `blob:x/${n}`)));
    expect(back).toBe(MD.replace('assets/d.png', 'assets/imp-1.png').replace('3. Third\n4. Fourth', '1. Third\n2. Fourth'));
  });

  it('rejects files that are not Word documents', () => {
    expect(() => fromDocx(new Uint8Array([1, 2, 3]))).toThrow(/not a Word document/);
  });
});
