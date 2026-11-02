import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

/**
 * A fillable PDF for tests: page 1 has a printed label and text / multiline / comb / read-only
 * fields, a checkbox, a radio group, a dropdown and a multi-select list; page 2 is turned 90° with
 * one more text field. Built with pdf-lib so the fixture is generated, not committed.
 */
export async function fillableFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([612, 792]);
  p1.drawText('Applicant name', { x: 50, y: 725, size: 12, font });
  const form = pdf.getForm();
  const name = form.createTextField('applicant.name');
  name.setMaxLength(12);
  name.enableRequired();
  name.addToPage(p1, { x: 50, y: 700, width: 200, height: 20, font });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(p1, { x: 50, y: 600, width: 300, height: 60, font });
  const zip = form.createTextField('zip');
  zip.setMaxLength(5);
  zip.enableCombing();
  zip.addToPage(p1, { x: 300, y: 700, width: 100, height: 20, font });
  const ref = form.createTextField('ref');
  ref.setText('A-17');
  ref.enableReadOnly();
  ref.addToPage(p1, { x: 420, y: 700, width: 100, height: 20, font });
  const agree = form.createCheckBox('agree');
  agree.addToPage(p1, { x: 50, y: 560, width: 15, height: 15 });
  const color = form.createRadioGroup('color');
  color.addOptionToPage('red', p1, { x: 50, y: 520, width: 15, height: 15 });
  color.addOptionToPage('blue', p1, { x: 80, y: 520, width: 15, height: 15 });
  const state = form.createDropdown('state');
  state.addOptions(['TX', 'NJ', 'CA']);
  state.addToPage(p1, { x: 50, y: 470, width: 100, height: 20, font });
  const langs = form.createOptionList('langs');
  langs.addOptions(['English', 'French', 'Telugu']);
  langs.enableMultiselect();
  langs.addToPage(p1, { x: 200, y: 420, width: 120, height: 60, font });
  const p2 = pdf.addPage([612, 792]);
  p2.setRotation(degrees(90));
  p2.drawText('Second page', { x: 50, y: 740, size: 12, font });
  const city = form.createTextField('city');
  city.addToPage(p2, { x: 100, y: 650, width: 150, height: 20, font });
  return pdf.save();
}
