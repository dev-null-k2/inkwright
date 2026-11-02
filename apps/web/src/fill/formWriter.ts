import { PDFBool, PDFCheckBox, PDFDropdown, PDFHexString, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField, StandardFonts, type PDFDocument, type PDFField } from 'pdf-lib';
import type { FormFieldValue } from '@inkwright/core';

/**
 * Writes Inkwright's stored form values into a PDF's AcroForm with pdf-lib, so the exported file is
 * a real filled-in form: values live in the fields (selectable, editable in any PDF viewer) with
 * appearances generated for viewers that don't make their own. Optionally flattens the form.
 */

export interface FillReport {
  /** Fields whose value was written. */
  filled: string[];
  /** Fields that could not take the stored value (e.g. an option that no longer exists). */
  skipped: string[];
  /** Some appearances couldn't be drawn with the standard font; viewers are asked to redraw them. */
  needAppearances: boolean;
  flattened: boolean;
}

const asList = (v: FormFieldValue): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? (v ? [v] : []) : []);

function setField(f: PDFField, v: FormFieldValue): void {
  if (f instanceof PDFTextField) {
    const text = Array.isArray(v) ? v.join('\n') : typeof v === 'boolean' ? (v ? 'Yes' : '') : v;
    const max = f.getMaxLength();
    const clean = f.isMultiline() ? text : text.replace(/\r?\n/g, ' ');
    f.setText(max != null ? [...clean].slice(0, max).join('') : clean);
  } else if (f instanceof PDFCheckBox) {
    if (typeof v === 'string' && v !== 'Off' && v !== '' && v !== 'Yes') {
      // A named on-state (checkbox groups that act like radios).
      f.acroField.setValue(PDFName.of(v));
      return;
    }
    if (v === true || v === 'Yes' || (Array.isArray(v) && v.length > 0)) f.check();
    else f.uncheck();
  } else if (f instanceof PDFRadioGroup) {
    const state = typeof v === 'string' ? v : '';
    if (!state || state === 'Off') f.clear();
    // Stored values are what pdf.js reports: the widget's appearance state name, or its /Opt
    // export value when the field has one. Match either so the right widget turns on.
    else if (f.acroField.getOnValues().some((n) => n.decodeText() === state)) f.acroField.setValue(PDFName.of(state));
    else f.select(state);
  } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
    const list = asList(v);
    if (!list.length) f.clear();
    // Low level: `select()` would mark a dropdown editable when an export value differs from its label.
    else f.acroField.setValues(list.map((x) => PDFHexString.fromText(x)));
  }
}

/** Fills `values` into the document's form; with `flatten` the fields become page content. */
export async function fillPdfForm(pdf: PDFDocument, values: Record<string, FormFieldValue> | undefined, opts: { flatten?: boolean } = {}): Promise<FillReport> {
  const report: FillReport = { filled: [], skipped: [], needAppearances: false, flattened: false };
  let form;
  try { form = pdf.getForm(); } catch { return report; }
  const fields = form.getFields();
  if (!fields.length) return report;
  for (const f of fields) {
    const v = values?.[f.getName()];
    if (v === undefined) continue;
    try {
      setField(f, v);
      form.markFieldAsDirty(f.ref);
      report.filled.push(f.getName());
    } catch (e) {
      console.warn(`Form field ${f.getName()} not filled`, e);
      report.skipped.push(f.getName());
    }
  }
  if (report.filled.length) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const f of fields) {
      if (!form.fieldIsDirty(f.ref)) continue;
      try {
        (f as PDFField & { defaultUpdateAppearances(font: unknown): void }).defaultUpdateAppearances(font);
        form.markFieldAsClean(f.ref);
      } catch {
        // Text the standard font can't encode (non-Latin scripts): the value is still in the field.
        report.needAppearances = true;
      }
    }
    if (report.needAppearances) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  }
  if (opts.flatten) {
    try {
      form.flatten({ updateFieldAppearances: false });
      report.flattened = true;
    } catch (e) {
      console.warn('Could not flatten the form; fields stay editable', e);
    }
  }
  return report;
}
