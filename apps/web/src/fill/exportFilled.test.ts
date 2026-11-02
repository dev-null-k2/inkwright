import { describe, expect, it } from 'vitest';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } from 'pdf-lib';
import { newNote, newPage, type InkStroke, type NoteMeta, type PageInk } from '@inkwright/core';
import { displayToUserMatrix, exportFilledPdf } from './exportFilled.ts';
import { fillPdfForm } from './formWriter.ts';
import { pdfToPage, readPdfForm } from './pdfForm.ts';
import { fillableFixture } from './fixtures.ts';

const pdfjs = (): Promise<any> => import('pdfjs-dist/legacy/build/pdf.mjs');

function ink(id: string, pts: [number, number][]): InkStroke {
  return { id, pen: 'ballpoint', color: '#FF1B3A8C', size: 2, createdAt: 1, points: pts.map(([x, y], i) => ({ x, y, t: i * 8, p: 0.5, tilt: -1, orient: -1 })) };
}

const values = { 'applicant.name': 'Ada Lovelace', notes: 'Line one\nLine two', zip: '75070', agree: true, color: 'blue', state: 'NJ', langs: ['English', 'Telugu'], city: 'McKinney' };

async function setup(extraPages: PageInk[] = []) {
  const bytes = await fillableFixture();
  const meta: NoteMeta = { ...newNote({ id: 'n', title: 'Form', pageId: 'p1', now: 1 }), forms: { 'form.pdf': values } };
  const pages: PageInk[] = [
    { ...newPage('p1'), background: { kind: 'pdf', asset: 'form.pdf', pageNumber: 1 }, size: { name: 'PDF', width: 816, height: 1056 }, strokes: [ink('sig', [[100, 900], [140, 880], [180, 905], [220, 885]])] },
    ...extraPages,
    { ...newPage('p2'), background: { kind: 'pdf', asset: 'form.pdf', pageNumber: 2 }, size: { name: 'PDF', width: 1056, height: 816 } },
  ];
  const readAsset = async (name: string) => (name === 'form.pdf' ? bytes : null);
  return { meta, pages, readAsset, bytes };
}

async function pageText(bytes: Uint8Array, n: number): Promise<string> {
  const task = (await pdfjs()).getDocument({ data: bytes.slice(), isEvalSupported: false });
  const page = await (await task.promise).getPage(n);
  const tc = await page.getTextContent();
  const s = tc.items.map((i: any) => i.str).join(' ');
  await task.destroy();
  return s;
}

async function opCount(bytes: Uint8Array, n: number): Promise<number> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const ops = await (await (await task.promise).getPage(n)).getOperatorList();
  const fills = ops.fnArray.filter((f: number) => f === lib.OPS.constructPath || f === lib.OPS.fill || f === lib.OPS.eoFill).length;
  await task.destroy();
  return fills;
}

describe('export filled PDF', () => {
  it('writes values into the original form, keeps the original text, adds ink, keeps fields editable', async () => {
    const { meta, pages, readAsset, bytes } = await setup();
    const { bytes: out, report } = await exportFilledPdf(meta, pages, readAsset);
    expect(report.skipped).toEqual([]);
    expect(report.filled.sort()).toEqual(Object.keys(values).sort());
    const doc = await PDFDocument.load(out);
    const form = doc.getForm();
    expect((form.getField('applicant.name') as PDFTextField).getText()).toBe('Ada Lovelace');
    expect((form.getField('notes') as PDFTextField).getText()).toBe('Line one\nLine two');
    expect((form.getField('zip') as PDFTextField).getText()).toBe('75070');
    expect((form.getField('ref') as PDFTextField).getText()).toBe('A-17');
    expect((form.getField('agree') as PDFCheckBox).isChecked()).toBe(true);
    expect((form.getField('color') as PDFRadioGroup).getSelected()).toBe('blue');
    expect((form.getField('state') as PDFDropdown).getSelected()).toEqual(['NJ']);
    expect((form.getField('langs') as PDFOptionList).getSelected()).toEqual(['English', 'Telugu']);
    expect((form.getField('city') as PDFTextField).getText()).toBe('McKinney');
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    expect(await pageText(out, 1)).toContain('Applicant name');
    // The ink stroke is drawn on top as a vector fill.
    expect(await opCount(out, 1)).toBeGreaterThan(await opCount(bytes, 1));
    // pdf.js sees the values too (what other viewers show).
    const back = await readPdfForm(out, await pdfjs());
    const initial = Object.fromEntries(back.fields.map((f) => [f.name, f.initial]));
    expect(initial).toMatchObject({ 'applicant.name': 'Ada Lovelace', agree: true, color: 'blue', state: 'NJ', langs: ['English', 'Telugu'], zip: '75070' });
  });

  it('flattening turns values into page text and removes the fields', async () => {
    const { meta, pages, readAsset } = await setup();
    const { bytes: out, report } = await exportFilledPdf(meta, pages, readAsset, { flatten: true });
    expect(report.flattened).toBe(true);
    const doc = await PDFDocument.load(out);
    expect(doc.getForm().getFields()).toHaveLength(0);
    const text = await pageText(out, 1);
    expect(text).toContain('Applicant name');
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('NJ');
    expect(await pageText(out, 2)).toContain('McKinney');
  });

  it('follows the note’s pages: reordered, rotated, blank and duplicated pages', async () => {
    const { meta, pages, readAsset } = await setup([{ ...newPage('blank'), strokes: [ink('b', [[10, 10], [50, 50]])] }]);
    // Order: page 2 (turned once more), blank, page 1, page 1 again.
    const p1 = pages[0]!, blank = pages[1]!, p2 = pages[2]!;
    const order: PageInk[] = [
      { ...p2, background: { ...p2.background!, rotation: 90 }, size: { name: 'PDF', width: 816, height: 1056 } },
      blank,
      p1,
      { ...p1, id: 'copy' },
    ];
    const { bytes: out } = await exportFilledPdf(meta, order, readAsset);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPage(0).getRotation().angle).toBe(180);
    expect(await pageText(out, 1)).toContain('Second page');
    expect(await pageText(out, 3)).toContain('Applicant name');
    // The second copy is a flattened picture of page 1, values included.
    expect(await pageText(out, 4)).toContain('Ada Lovelace');
    expect((doc.getForm().getField('applicant.name') as PDFTextField).getText()).toBe('Ada Lovelace');
  });

  it('leaves out original pages the note deleted, and their fields', async () => {
    const { meta, pages, readAsset } = await setup();
    const { bytes: out } = await exportFilledPdf(meta, [pages[0]!], readAsset);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getForm().getFields().map((f) => f.getName())).not.toContain('city');
  });

  it('display → user space matrix is the inverse of the viewer transform for every rotation', () => {
    const crop = { x: 10, y: 20, width: 600, height: 800 };
    const view = [10, 20, 610, 820];
    for (const rot of [0, 90, 180, 270]) {
      const [a, b, c, d, e, f] = displayToUserMatrix(crop, rot);
      const H = rot % 180 ? crop.width : crop.height;
      for (const [vx, vy] of [[0, 0], [100, 50], [300, 400]] as const) {
        const ux = a * vx + c * vy + e, uy = b * vx + d * vy + f;
        const back = pdfToPage(ux, uy, view, rot, 1);
        expect(back.x).toBeCloseTo(vx);
        expect(back.y).toBeCloseTo(H - vy);
      }
    }
  });

  it('a stored value an option list does not have is skipped, not fatal; no values = form untouched', async () => {
    const pdf = await PDFDocument.load(await fillableFixture());
    const r = await fillPdfForm(pdf, { color: 'green', 'applicant.name': 'Bo' });
    expect(r.skipped).toEqual(['color']);
    expect(r.filled).toEqual(['applicant.name']);
    const untouched = await fillPdfForm(await PDFDocument.load(await fillableFixture()), undefined);
    expect(untouched.filled).toEqual([]);
  });

  it('fails clearly when the note has no PDF', async () => {
    const meta = newNote({ id: 'n', title: 'x', pageId: 'p', now: 0 });
    await expect(exportFilledPdf(meta, [newPage('p')], async () => null)).rejects.toThrow(/no PDF/);
  });
});
