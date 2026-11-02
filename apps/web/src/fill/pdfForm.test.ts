import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { newPage, type NoteMeta, type PageInk } from '@inkstone/core';
import { clampText, coerce, effectiveValue, fieldsFromAnnotations, humanize, missingRequired, pdfAssetsOf, pdfToPage, placeWidgets, readPdfForm, rectToPage, storageEntries, withFormValue, type PdfField } from './pdfForm.ts';
import { fillableFixture } from './fixtures.ts';

const pdfjs = (): Promise<any> => import('pdfjs-dist/legacy/build/pdf.mjs');
const byName = (fields: PdfField[], n: string) => fields.find((f) => f.name === n)!;

describe('reading AcroForm fields with pdf.js', () => {
  it('maps every field type and its rules', async () => {
    const info = await readPdfForm(await fillableFixture(), await pdfjs());
    const f = info.fields;
    expect(f.map((x) => x.name)).toEqual(['applicant.name', 'notes', 'zip', 'ref', 'agree', 'color', 'state', 'langs', 'city']);
    const name = byName(f, 'applicant.name');
    expect(name).toMatchObject({ kind: 'text', maxLen: 12, required: true, multiline: false, comb: false, label: 'Name' });
    expect(byName(f, 'notes')).toMatchObject({ kind: 'text', multiline: true });
    expect(byName(f, 'zip')).toMatchObject({ kind: 'text', comb: true, maxLen: 5 });
    expect(byName(f, 'ref')).toMatchObject({ kind: 'text', readOnly: true, initial: 'A-17' });
    expect(byName(f, 'agree')).toMatchObject({ kind: 'checkbox', initial: false });
    expect(byName(f, 'agree').widgets[0]!.onValue).toBeTruthy();
    const color = byName(f, 'color');
    expect(color.kind).toBe('radio');
    expect(color.widgets.map((w) => w.onValue)).toEqual(['red', 'blue']);
    expect(color.initial).toBe('Off');
    expect(byName(f, 'state')).toMatchObject({ kind: 'choice', combo: true, multiSelect: false, initial: '' });
    expect(byName(f, 'state').options.map((o) => o.value)).toEqual(['TX', 'NJ', 'CA']);
    expect(byName(f, 'langs')).toMatchObject({ kind: 'choice', combo: false, multiSelect: true, initial: [] });
    expect(info.pages[1]!.rotate).toBe(90);
  });

  it('places widgets on the note’s pages in page units, following rotation and page order', async () => {
    const info = await readPdfForm(await fillableFixture(), await pdfjs());
    const pages: PageInk[] = [
      { ...newPage('b'), background: { kind: 'pdf', asset: 'f.pdf', pageNumber: 2 } },
      { ...newPage('a'), background: { kind: 'pdf', asset: 'f.pdf', pageNumber: 1 } },
      newPage('blank'),
    ];
    const placed = placeWidgets(info, 'f.pdf', pages);
    const name = placed.find((p) => p.field.name === 'applicant.name')!;
    expect(name.pageIndex).toBe(1);
    // pdf-lib draws the widget 1pt outside its rect; ~ (50, 792-720) pt → page units ×96/72.
    expect(name.rect.minX).toBeCloseTo(49.5 * 96 / 72, 0);
    expect(name.rect.minY).toBeCloseTo((792 - 720.5) * 96 / 72, 0);
    expect(name.rect.maxX - name.rect.minX).toBeCloseTo(201 * 96 / 72, 0);
    // Page 2 is shown turned 90° clockwise: x comes from PDF y.
    const city = placed.find((p) => p.field.name === 'city')!;
    expect(city.pageIndex).toBe(0);
    expect(city.rect.minX).toBeCloseTo(649.5 * 96 / 72, 0);
    expect(city.rect.minY).toBeCloseTo(99.5 * 96 / 72, 0);
    expect(city.rect.maxY - city.rect.minY).toBeGreaterThan(city.rect.maxX - city.rect.minX);
    // A page the user rotated once more shows the widget turned too.
    pages[1] = { ...pages[1]!, background: { kind: 'pdf', asset: 'f.pdf', pageNumber: 1, rotation: 90 } };
    const turned = placeWidgets(info, 'f.pdf', pages).find((p) => p.field.name === 'applicant.name')!;
    expect(turned.rect.maxY - turned.rect.minY).toBeGreaterThan(turned.rect.maxX - turned.rect.minX);
  });
});

describe('field model', () => {
  const text = (over: Partial<PdfField> = {}): PdfField => ({ name: 't', kind: 'text', label: 'T', widgets: [{ id: '1R', pageNumber: 1, rect: [0, 0, 10, 10] }], multiline: false, maxLen: 0, comb: false, readOnly: false, required: false, password: false, options: [], combo: false, multiSelect: false, initial: '', fontSize: 0, align: 'left', ...over });

  it('maps signature fields and skips push buttons and hidden widgets', () => {
    const f = fieldsFromAnnotations([{ pageNumber: 1, annotations: [
      { id: '1R', subtype: 'Widget', fieldName: 'sig', fieldType: 'Sig', rect: [0, 0, 100, 30] },
      { id: '2R', subtype: 'Widget', fieldName: 'go', fieldType: 'Btn', pushButton: true, rect: [0, 0, 1, 1] },
      { id: '3R', subtype: 'Widget', fieldName: 'h', fieldType: 'Tx', hidden: true, rect: [0, 0, 1, 1] },
      { id: '4R', subtype: 'Link', rect: [0, 0, 1, 1] },
    ] }]);
    expect(f.map((x) => [x.name, x.kind])).toEqual([['sig', 'signature']]);
  });

  it('a checkbox group with different on-states acts like a radio group', () => {
    const f = fieldsFromAnnotations([{ pageNumber: 1, annotations: [
      { id: '1R', subtype: 'Widget', fieldName: 'size', fieldType: 'Btn', checkBox: true, exportValue: 'S', fieldValue: 'M', rect: [0, 0, 1, 1] },
      { id: '2R', subtype: 'Widget', fieldName: 'size', fieldType: 'Btn', checkBox: true, exportValue: 'M', fieldValue: 'M', rect: [2, 0, 3, 1] },
    ] }]);
    expect(f[0]).toMatchObject({ kind: 'radio', initial: 'M' });
    expect(storageEntries(f[0]!, 'S')).toEqual([['1R', { value: true }], ['2R', { value: false }]]);
  });

  it('enforces max length and single lines; coerces values from other versions', () => {
    expect(clampText({ maxLen: 5, multiline: false }, 'ab\ncdefgh')).toBe('ab cd');
    expect(clampText({ maxLen: 0, multiline: true }, 'a\nb')).toBe('a\nb');
    expect(coerce(text({ maxLen: 3 }), 'abcdef')).toBe('abc');
    expect(coerce(text({ kind: 'checkbox' }), 'Yes')).toBe(true);
    expect(coerce(text({ kind: 'choice', multiSelect: true }), 'x')).toEqual(['x']);
    expect(coerce(text({ kind: 'choice' }), ['x', 'y'])).toBe('x');
  });

  it('stored values win over the PDF’s own, and required fields are reported until filled', () => {
    const f = [text({ name: 'a', required: true, initial: '' }), text({ name: 'b', initial: 'pre' }), text({ name: 'c', kind: 'checkbox', required: true, initial: false })];
    expect(effectiveValue(f[1]!, undefined)).toBe('pre');
    expect(effectiveValue(f[1]!, { b: 'mine' })).toBe('mine');
    expect(missingRequired(f, {}).map((x) => x.name)).toEqual(['a', 'c']);
    expect(missingRequired(f, { a: 'x', c: true })).toEqual([]);
  });

  it('builds pdf.js storage entries per widget', () => {
    expect(storageEntries(text(), 'hi')).toEqual([['1R', { value: 'hi' }]]);
    expect(storageEntries(text({ kind: 'checkbox' }), true)).toEqual([['1R', { value: true }]]);
    expect(storageEntries(text({ kind: 'choice' }), 'NJ')).toEqual([['1R', { value: ['NJ'] }]]);
  });

  it('stores values in note meta per PDF and removes empty maps', () => {
    const meta = { forms: undefined } as unknown as NoteMeta;
    const a = withFormValue(meta, 'f.pdf', 'name', 'Ada');
    expect(a.forms).toEqual({ 'f.pdf': { name: 'Ada' } });
    expect(withFormValue(a, 'f.pdf', 'name', undefined).forms).toBeUndefined();
  });

  it('names and geometry helpers', () => {
    expect(humanize('applicant.first_name')).toBe('First name');
    expect(humanize('dateOfBirth')).toBe('Date of birth');
    expect(pdfToPage(72, 720, [0, 0, 612, 792], 0, 1)).toEqual({ x: 72, y: 72 });
    expect(rectToPage([0, 0, 72, 36], [0, 0, 612, 792], 0)).toEqual({ minX: 0, minY: 756 * 96 / 72, maxX: 96, maxY: 792 * 96 / 72 });
    const pages = [{ ...newPage('a'), background: { kind: 'pdf' as const, asset: 'x.pdf' } }, { ...newPage('b'), background: { kind: 'pdf' as const, asset: 'y.pdf' } }, { ...newPage('c'), background: { kind: 'pdf' as const, asset: 'y.pdf' } }];
    expect(pdfAssetsOf(pages)).toEqual(['y.pdf', 'x.pdf']);
  });

  it('the fixture is a valid PDF for pdf-lib too', async () => {
    const doc = await PDFDocument.load(await fillableFixture());
    expect(doc.getForm().getFields()).toHaveLength(9);
  });
});
