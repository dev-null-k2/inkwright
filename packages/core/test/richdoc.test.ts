import { describe, expect, it } from 'vitest';
import {
  applyDocumentEdit,
  documentBody,
  documentOutline,
  documentWords,
  isDocumentNote,
  joinBlocks,
  mergeDocumentMarkdown,
  mergeSequences,
  splitBlocks,
} from '../src/richdoc.ts';

const DOC = `# Trip plan

We leave on **Friday**.

## Packing

- [ ] Tent
- [x] Stove

\`\`\`sh
echo one

echo two
\`\`\`

## Budget

| Item | Cost |
| --- | --- |
| Fuel | 40 |
`;

describe('blocks', () => {
  it('splits on blank lines and keeps fenced code (with its blank lines) whole', () => {
    const b = splitBlocks(DOC);
    expect(b[0]).toBe('# Trip plan');
    expect(b).toContain('```sh\necho one\n\necho two\n```');
    expect(b[b.length - 1]).toBe('| Item | Cost |\n| --- | --- |\n| Fuel | 40 |');
    expect(splitBlocks(joinBlocks(b))).toEqual(b);
  });

  it('normalises Windows line endings', () => {
    expect(splitBlocks('a\r\n\r\nb')).toEqual(['a', 'b']);
  });
});

describe('three-way merge', () => {
  it('keeps edits to different paragraphs from both sides', () => {
    const base = 'Intro\n\nMiddle\n\nEnd\n';
    const local = 'Intro, edited here\n\nMiddle\n\nEnd\n';
    const remote = 'Intro\n\nMiddle\n\nEnd, edited there\n';
    expect(mergeDocumentMarkdown(base, local, remote)).toBe('Intro, edited here\n\nMiddle\n\nEnd, edited there');
  });

  it('takes a one-sided change, and an identical change once', () => {
    expect(mergeDocumentMarkdown('a\n\nb', 'a\n\nb', 'a\n\nB')).toBe('a\n\nB');
    expect(mergeDocumentMarkdown('a\n\nb', 'a\n\nX', 'a\n\nX')).toBe('a\n\nX');
  });

  it('keeps both versions of a paragraph edited differently on both sides (never loses text)', () => {
    const merged = mergeDocumentMarkdown('One\n\nTwo\n\nThree', 'One\n\nTwo (mine)\n\nThree', 'One\n\nTwo (theirs)\n\nThree');
    expect(splitBlocks(merged)).toEqual(['One', 'Two (mine)', 'Two (theirs)', 'Three']);
  });

  it('applies a deletion on one side and an insertion on the other', () => {
    const merged = mergeDocumentMarkdown('A\n\nB\n\nC', 'A\n\nC', 'A\n\nB\n\nB2\n\nC');
    expect(splitBlocks(merged)).toEqual(['A', 'B2', 'C']);
  });

  it('interleaves concurrent appends without duplicating shared blocks', () => {
    expect(mergeSequences(['a'], ['a', 'x'], ['a', 'y'])).toEqual(['a', 'x', 'y']);
    expect(mergeSequences(['a'], ['a', 'x', 'z'], ['a', 'x', 'y'])).toEqual(['a', 'x', 'z', 'y']);
  });

  it('without a base keeps everything from both sides once', () => {
    expect(splitBlocks(mergeDocumentMarkdown(null, 'a\n\nb', 'a\n\nc'))).toEqual(['a', 'b', 'c']);
  });

  it('handles long documents with a small change quickly', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i}`);
    const a = [...base]; a[10] = 'Changed early';
    const b = [...base]; b[2990] = 'Changed late';
    const t = performance.now();
    const out = mergeSequences(base, a, b);
    expect(performance.now() - t).toBeLessThan(500);
    expect(out[10]).toBe('Changed early');
    expect(out[2990]).toBe('Changed late');
    expect(out).toHaveLength(3000);
  });
});

describe('reading', () => {
  it('lists headings outside code blocks', () => {
    expect(documentOutline(`${DOC}\n\`\`\`\n# not a heading\n\`\`\`\n`)).toEqual([
      { level: 1, text: 'Trip plan' },
      { level: 2, text: 'Packing' },
      { level: 2, text: 'Budget' },
    ]);
    expect(documentOutline('## **Bold** [link](https://x) <u>u</u>')).toEqual([{ level: 2, text: 'Bold link u' }]);
  });

  it('counts words, not Markdown or HTML', () => {
    expect(documentWords('# Hello world\n\n- [ ] one **two**\n\n<u>three</u> [four](https://example.com/a-b)')).toBe(6);
    expect(documentWords('')).toBe(0);
    expect(documentWords("It's 3.5 km — don’t stop")).toBe(5);
  });

  it('finds the body and recognises document notes', () => {
    expect(documentBody({ texts: [{ id: 'x', role: 'document' } as never] })?.id).toBe('x');
    expect(documentBody({ texts: [] })).toBeUndefined();
    expect(isDocumentNote({ document: { width: 720 } })).toBe(true);
    expect(isDocumentNote({})).toBe(false);
  });
});

describe('edits', () => {
  it('appends and prepends', () => {
    expect(applyDocumentEdit('# A\n\nText\n', { op: 'append', markdown: 'More' })).toBe('# A\n\nText\n\nMore\n');
    expect(applyDocumentEdit('Text\n', { op: 'prepend', markdown: '# Title' })).toBe('# Title\n\nText\n');
  });

  it('replaces exact text once, or everywhere when asked, and explains failures', () => {
    expect(applyDocumentEdit('a b a', { op: 'replace_text', find: 'b', replace: 'c' })).toBe('a c a\n');
    expect(() => applyDocumentEdit('a b a', { op: 'replace_text', find: 'a', replace: 'x' })).toThrow(/appears 2 times/);
    expect(applyDocumentEdit('a b a', { op: 'replace_text', find: 'a', replace: 'x', all: true })).toBe('x b x\n');
    expect(() => applyDocumentEdit('a', { op: 'replace_text', find: 'zzz', replace: 'x' })).toThrow(/not in the document/);
    // "$&" in the replacement is literal text, not a regex back-reference.
    expect(applyDocumentEdit('cost', { op: 'replace_text', find: 'cost', replace: '$& $5' })).toBe('$& $5\n');
  });

  it('replaces or extends a section up to the next heading of the same level', () => {
    const replaced = applyDocumentEdit(DOC, { op: 'replace_section', heading: 'Packing', markdown: '- [ ] Map' });
    expect(replaced).toContain('## Packing\n\n- [ ] Map\n\n## Budget');
    expect(replaced).not.toContain('Tent');
    const added = applyDocumentEdit(DOC, { op: 'append_to_section', heading: '## packing', markdown: '- [ ] Map' });
    expect(added).toContain('```\n\n- [ ] Map\n\n## Budget');
    expect(added).toContain('Tent');
    expect(() => applyDocumentEdit(DOC, { op: 'replace_section', heading: 'Nope', markdown: '' })).toThrow(/headings are: "trip plan", "packing", "budget"/);
  });
});

describe('note.md of a document', () => {
  it('is the document\'s own Markdown, with its ink linked after it', async () => {
    const { exportMarkdown, newNote } = await import('../src/index.ts');
    const note = { ...newNote({ id: 'D', title: 'Plan', pageId: 'P', now: 0 }), document: { width: 720 } };
    const page = { id: 'P', formatVersion: 2, strokes: [{ id: 's', pen: 'fountain' as const, color: '#FF000000', size: 2, createdAt: 0, points: [{ x: 1, y: 1, t: 0, p: 0.5, tilt: -1, orient: -1 }] }], texts: [{ id: 'B', role: 'document' as const, x: 0, y: 0, width: 600, text: '## Goals\n\n- [ ] Ship\n', fontSize: 16, color: '#FF000000', font: 'sans' as const, createdAt: 0 }] };
    const md = exportMarkdown(note, [page]);
    expect(md).toContain('kind: document');
    expect(md).toContain('# Plan\n\n## Goals\n\n- [ ] Ship\n\nInk on this document: ![Annotations](pages/P.svg)');
    expect(md).not.toContain('## Page 1');
  });
});
