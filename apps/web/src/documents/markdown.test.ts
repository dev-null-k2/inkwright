import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { documentExtensions } from './extensions.ts';
import { markdownToHtml, prepareHtml, toMarkdown, type PMNode } from './markdown.ts';

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });

/** Markdown → editor (as the document editor loads it) → Markdown (as it saves it). */
function roundTrip(md: string, resolve?: (n: string) => string | undefined): { md: string; json: PMNode } {
  const e = new Editor({ extensions: documentExtensions(), content: markdownToHtml(md, resolve) });
  editors.push(e);
  const json = e.getJSON() as PMNode;
  return { md: toMarkdown(json), json };
}

const SAMPLE = `# Quarterly report

Revenue grew **12 %** this quarter, *mostly* from ~~old~~ new customers and <u>renewals</u>. See [the dashboard](https://example.com/q3) and \`npm run report\`.

## Highlights

- North region
  - Two new partners
- South region

1. Draft
2. Review
3. Ship

- [x] Close the books
- [ ] Send to the board

> Numbers are unaudited.

\`\`\`ts
const total = a + b;

console.log(total);
\`\`\`

| Region | Revenue |
| --- | --- |
| North | 1 200 |
| South | 900 |

---

<div class="page-break"></div>

![Chart](assets/chart-1.png)

Line one\\
line two
`;

describe('document Markdown', () => {
  it('round-trips every kind of block and mark unchanged', () => {
    const { md } = roundTrip(SAMPLE, (n) => `blob:test/${n}`);
    expect(md).toBe(SAMPLE);
    // And again: saving an unchanged document changes nothing.
    expect(roundTrip(md).md).toBe(md);
  });

  it('maps the editor nodes onto the expected schema', () => {
    const { json } = roundTrip(SAMPLE, (n) => `blob:test/${n}`);
    const types = (json.content ?? []).map((n) => n.type);
    expect(types).toEqual(['heading', 'paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'horizontalRule', 'pageBreak', 'image', 'paragraph']);
    const task = json.content!.find((n) => n.type === 'taskList')!;
    expect(task.content!.map((i) => i.attrs?.checked)).toEqual([true, false]);
    const img = json.content!.find((n) => n.type === 'image')!;
    expect(img.attrs).toMatchObject({ asset: 'chart-1.png', src: 'blob:test/chart-1.png', alt: 'Chart' });
    const marks = json.content![1]!.content!.flatMap((t) => (t.marks ?? []).map((m) => m.type));
    expect(new Set(marks)).toEqual(new Set(['bold', 'italic', 'strike', 'underline', 'link', 'code']));
  });

  it('escapes text that would otherwise turn into Markdown syntax', () => {
    const json: PMNode = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '# not a heading, 2 * 3 = 6, a_b, [x], <b>' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '1. not a list' }] },
    ] };
    const md = toMarkdown(json);
    const back = roundTrip(md).json;
    expect(back.content!.map((p) => p.type)).toEqual(['paragraph', 'paragraph']);
    expect(back.content![0]!.content![0]!.text).toBe('# not a heading, 2 * 3 = 6, a_b, [x], <b>');
    expect(back.content![1]!.content![0]!.text).toBe('1. not a list');
  });

  it('keeps spaces outside marks and merges adjacent marked runs', () => {
    const json: PMNode = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'and italic', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { type: 'text', text: ' end' },
    ] }] };
    expect(toMarkdown(json)).toBe('a **bold *and italic*** end\n');
    expect(roundTrip(toMarkdown(json)).md).toBe(toMarkdown(json));
  });

  it('writes code spans that contain backticks and table cells with pipes', () => {
    const json: PMNode = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'use `x`', marks: [{ type: 'code' }] }] },
    ] };
    expect(toMarkdown(json)).toBe('`` use `x` ``\n');
    expect(roundTrip(toMarkdown(json)).json.content![0]!.content![0]!.text).toBe('use `x`');
    const table = roundTrip('| a | b |\n| --- | --- |\n| x \\| y | z |\n');
    expect(table.md).toBe('| a | b |\n| --- | --- |\n| x \\| y | z |\n');
  });

  it('an empty document is empty', () => {
    expect(roundTrip('').md).toBe('');
  });

  it('sanitises HTML: no scripts or handlers reach the editor', () => {
    const html = prepareHtml('<p onclick="alert(1)">Hi<script>alert(2)</script><img src="x" onerror="alert(3)"></p>');
    expect(html).not.toMatch(/script|onclick|onerror/);
    expect(markdownToHtml('<iframe src="https://evil"></iframe>\n\nText')).not.toContain('iframe');
  });
});
