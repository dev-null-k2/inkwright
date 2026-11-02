import type { FormFieldValue, InkStroke, NoteMeta, PageInk } from '@inkwright/core';

/**
 * PDF form fields (AcroForm) as Inkwright sees them: what pdf.js reports for each widget, mapped to
 * a small model the Fill & sign layer can show as tappable fields at any zoom, and the values
 * pdf.js needs to draw them. Values themselves live in `NoteMeta.forms[asset][fieldName]`
 * (docs/VAULT_FORMAT.md); the PDF file is never modified in the vault.
 */

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'choice' | 'signature';

/** One place a field appears. `rect` is in PDF user space (points, y up), as stored in the file. */
export interface FieldWidget {
  /** pdf.js annotation id (object reference, e.g. "12R"). */
  id: string;
  pageNumber: number;
  rect: [number, number, number, number];
  /** Checkbox / radio: the appearance state this widget turns on ("Yes", "red"…). */
  onValue?: string;
}

export interface FieldOption { value: string; label: string }

export interface PdfField {
  /** Fully qualified name ("applicant.name"): the key values are stored under. */
  name: string;
  kind: FieldKind;
  /** Tooltip / alternate text, used as an accessible label. */
  label: string;
  widgets: FieldWidget[];
  multiline: boolean;
  /** Maximum characters (0 = no limit). */
  maxLen: number;
  /** Comb field: `maxLen` evenly spaced boxes, one character each. */
  comb: boolean;
  readOnly: boolean;
  required: boolean;
  password: boolean;
  options: FieldOption[];
  /** Choice: a dropdown (true) or a list box (false). */
  combo: boolean;
  multiSelect: boolean;
  /** Value saved in the PDF itself, shown until the user changes it. */
  initial: FormFieldValue | undefined;
  /** Font size in points from the field's default appearance; 0 = auto-fit. */
  fontSize: number;
  align: 'left' | 'center' | 'right';
}

/** The subset of pdf.js annotation data this module reads (see pdf.js `WidgetAnnotation`). */
export interface AnnotationLike {
  id: string;
  subtype?: string;
  fieldName?: string;
  fieldType?: string;
  fieldValue?: unknown;
  alternativeText?: string;
  rect: number[];
  readOnly?: boolean;
  required?: boolean;
  hidden?: boolean;
  password?: boolean;
  multiLine?: boolean;
  maxLen?: number | null;
  comb?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: { exportValue: string; displayValue: string }[];
  combo?: boolean;
  multiSelect?: boolean;
  textAlignment?: number | null;
  defaultAppearanceData?: { fontSize?: number };
}

/** Groups widget annotations by field and maps them to `PdfField`s (pure; unit-tested). */
export function fieldsFromAnnotations(pages: { pageNumber: number; annotations: AnnotationLike[] }[]): PdfField[] {
  const byName = new Map<string, PdfField>();
  const order: string[] = [];
  for (const { pageNumber, annotations } of pages) {
    for (const a of annotations) {
      if (a.subtype !== 'Widget' || !a.fieldName || !a.fieldType || a.hidden) continue;
      if (a.fieldType === 'Btn' && a.pushButton) continue; // buttons run scripts; nothing to fill
      const widget: FieldWidget = { id: a.id, pageNumber, rect: [a.rect[0]!, a.rect[1]!, a.rect[2]!, a.rect[3]!] };
      if (a.fieldType === 'Btn') widget.onValue = a.radioButton ? a.buttonValue : a.exportValue;
      let f = byName.get(a.fieldName);
      if (!f) {
        const kind: FieldKind = a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Ch' ? 'choice' : a.fieldType === 'Sig' ? 'signature' : a.radioButton ? 'radio' : 'checkbox';
        f = {
          name: a.fieldName,
          kind,
          label: (a.alternativeText || '').trim() || humanize(a.fieldName),
          widgets: [],
          multiline: !!a.multiLine,
          maxLen: a.maxLen && a.maxLen > 0 ? a.maxLen : 0,
          comb: !!a.comb && !!a.maxLen,
          readOnly: !!a.readOnly,
          required: !!a.required,
          password: !!a.password,
          options: (a.options ?? []).map((o) => ({ value: o.exportValue, label: o.displayValue || o.exportValue })),
          combo: !!a.combo,
          multiSelect: !!a.multiSelect,
          initial: undefined,
          fontSize: a.defaultAppearanceData?.fontSize ?? 0,
          align: a.textAlignment === 1 ? 'center' : a.textAlignment === 2 ? 'right' : 'left',
        };
        byName.set(a.fieldName, f);
        order.push(a.fieldName);
      }
      f.widgets.push(widget);
      if (f.initial === undefined) f.initial = initialValue(f.kind, a);
    }
  }
  const out = order.map((n) => byName.get(n)!);
  for (const f of out) {
    // A checkbox whose widgets turn on different states behaves like a radio group.
    if (f.kind === 'checkbox' && new Set(f.widgets.map((w) => w.onValue)).size > 1) {
      f.kind = 'radio';
      if (typeof f.initial === 'boolean') f.initial = 'Off';
    }
    if (f.kind === 'checkbox') {
      const on = f.widgets[0]?.onValue;
      // pdf.js reports the field's current state name; checked means it equals our on-state.
      f.initial = typeof f.initial === 'string' ? f.initial !== 'Off' && f.initial !== '' && (on == null || f.initial === on) : !!f.initial;
    }
  }
  return out;
}

function initialValue(kind: FieldKind, a: AnnotationLike): FormFieldValue | undefined {
  const v = a.fieldValue;
  switch (kind) {
    case 'text': return typeof v === 'string' ? v : Array.isArray(v) ? v.join('\n') : '';
    case 'checkbox': return typeof v === 'string' ? v : false;
    case 'radio': return typeof v === 'string' && v ? v : 'Off';
    case 'choice': {
      const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];
      return a.multiSelect ? list : (list[0] ?? '');
    }
    default: return undefined;
  }
}

/** "applicant.first_name" → "First name". */
export function humanize(name: string): string {
  const last = name.split('.').pop() ?? name;
  const s = last.replace(/\[\d+\]$/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : name;
}

/** The value to show: what the user entered in Inkwright, else what the PDF came with. */
export function effectiveValue(field: PdfField, stored: Record<string, FormFieldValue> | undefined): FormFieldValue {
  const v = stored?.[field.name];
  if (v !== undefined) return coerce(field, v);
  return field.initial ?? (field.kind === 'checkbox' ? false : field.kind === 'radio' ? 'Off' : field.multiSelect ? [] : '');
}

/** Coerces a stored value to the field's type (values may come from another device or version). */
export function coerce(field: PdfField, v: FormFieldValue): FormFieldValue {
  switch (field.kind) {
    case 'checkbox': return typeof v === 'boolean' ? v : Array.isArray(v) ? v.length > 0 : v !== '' && v !== 'Off';
    case 'radio': return typeof v === 'string' ? v : 'Off';
    case 'choice': {
      const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? (v ? [v] : []) : [];
      return field.multiSelect ? list : (list[0] ?? '');
    }
    case 'text': return clampText(field, Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : '');
    default: return v;
  }
}

/** Applies max length and single-line rules to typed text. */
export function clampText(field: Pick<PdfField, 'maxLen' | 'multiline'>, text: string): string {
  let t = field.multiline ? text : text.replace(/\r?\n/g, ' ');
  if (field.maxLen > 0) t = [...t].slice(0, field.maxLen).join('');
  return t;
}

/** Fields that must be filled and are still empty. */
export function missingRequired(fields: PdfField[], stored: Record<string, FormFieldValue> | undefined): PdfField[] {
  return fields.filter((f) => {
    if (!f.required || f.readOnly || f.kind === 'signature') return false;
    const v = effectiveValue(f, stored);
    return v === '' || v === false || v === 'Off' || (Array.isArray(v) && v.length === 0);
  });
}

/**
 * Entries for pdf.js `annotationStorage`, keyed by widget id, so a page render
 * (`AnnotationMode.ENABLE_STORAGE`) draws the filled-in values exactly like a PDF viewer would.
 */
export function storageEntries(field: PdfField, value: FormFieldValue): [string, Record<string, unknown>][] {
  return field.widgets.map((w) => {
    switch (field.kind) {
      case 'checkbox': return [w.id, { value: value === true }];
      case 'radio': return [w.id, { value: value !== 'Off' && w.onValue === value }];
      case 'choice': return [w.id, { value: Array.isArray(value) ? value : value ? [value] : [] }];
      default: return [w.id, { value: typeof value === 'string' ? value : String(value) }];
    }
  });
}

// ---- Geometry ------------------------------------------------------------------------------------

/** Page units (1/96 in) per PDF point. */
export const UNITS_PER_POINT = 96 / 72;

/**
 * Maps a PDF user-space point to page units on the displayed page — the same transform as a pdf.js
 * viewport: `view` is the page's visible box [x1, y1, x2, y2] and `rotate` its total clockwise
 * rotation (the PDF's /Rotate plus any turn the user added).
 */
export function pdfToPage(x: number, y: number, view: number[], rotate: number, s = UNITS_PER_POINT): { x: number; y: number } {
  const [x1, y1, x2, y2] = view as [number, number, number, number];
  switch (((rotate % 360) + 360) % 360) {
    case 90: return { x: (y - y1) * s, y: (x - x1) * s };
    case 180: return { x: (x2 - x) * s, y: (y - y1) * s };
    case 270: return { x: (y2 - y) * s, y: (x2 - x) * s };
    default: return { x: (x - x1) * s, y: (y2 - y) * s };
  }
}

export function rectToPage(rect: number[], view: number[], rotate: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const a = pdfToPage(rect[0]!, rect[1]!, view, rotate);
  const b = pdfToPage(rect[2]!, rect[3]!, view, rotate);
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

// ---- Reading a PDF -----------------------------------------------------------------------------

export interface PdfFormInfo {
  fields: PdfField[];
  /** Per 1-based page number: visible box and the page's own /Rotate. */
  pages: { view: number[]; rotate: number }[];
}

/**
 * Reads the AcroForm fields of a PDF with pdf.js. `pdfjs` is the pdf.js module (the app passes
 * its lazily loaded one; tests pass the Node build).
 */
export async function readPdfForm(bytes: Uint8Array, pdfjs: any): Promise<PdfFormInfo> {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  try {
    return await readPdfFormFromDoc(await task.promise);
  } finally {
    await task.destroy?.();
  }
}

/** Same as `readPdfForm` for an already loaded pdf.js document (shared with rendering). */
export async function readPdfFormFromDoc(doc: any): Promise<PdfFormInfo> {
  const pages: PdfFormInfo['pages'] = [];
  const annots: { pageNumber: number; annotations: AnnotationLike[] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push({ view: [...page.view], rotate: page.rotate ?? 0 });
    annots.push({ pageNumber: i, annotations: await page.getAnnotations({ intent: 'display' }) });
  }
  return { fields: fieldsFromAnnotations(annots), pages };
}

/** A widget placed on a note page: which field, which page of the note, where (page units). */
export interface PlacedWidget {
  field: PdfField;
  widget: FieldWidget;
  pageIndex: number;
  rect: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Where each widget of a PDF asset shows up in a note: a PDF page may appear several times (or
 * not at all) after pages were duplicated, moved or deleted, and may have been rotated.
 */
export function placeWidgets(info: PdfFormInfo, asset: string, pages: readonly PageInk[]): PlacedWidget[] {
  const out: PlacedWidget[] = [];
  pages.forEach((p, pageIndex) => {
    const bg = p.background;
    if (!bg || bg.kind !== 'pdf' || bg.asset !== asset) return;
    const n = bg.pageNumber ?? 1;
    const pg = info.pages[n - 1];
    if (!pg) return;
    const rot = pg.rotate + (bg.rotation ?? 0);
    for (const field of info.fields) {
      for (const widget of field.widgets) {
        if (widget.pageNumber !== n) continue;
        out.push({ field, widget, pageIndex, rect: rectToPage(widget.rect, pg.view, rot) });
      }
    }
  });
  return out;
}

/** PDF assets shown as page backgrounds in a note, most used first. */
export function pdfAssetsOf(pages: readonly PageInk[]): string[] {
  const count = new Map<string, number>();
  for (const p of pages) if (p.background?.kind === 'pdf') count.set(p.background.asset, (count.get(p.background.asset) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
}

/** Returns meta with one field value set (or removed with `undefined`). */
export function withFormValue(meta: NoteMeta, asset: string, name: string, value: FormFieldValue | undefined): NoteMeta {
  const forms = { ...(meta.forms ?? {}) };
  const values = { ...(forms[asset] ?? {}) };
  if (value === undefined) delete values[name];
  else values[name] = value;
  if (Object.keys(values).length) forms[asset] = values;
  else delete forms[asset];
  return { ...meta, forms: Object.keys(forms).length ? forms : undefined };
}

// ---- Handwriting into fields --------------------------------------------------------------------

/** Whether a stroke was written into a field: its centre lies in the box (a little slack above/below). */
export function strokeInField(s: InkStroke, r: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  if (!s.points.length) return false;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of s.points) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return cx >= r.minX && cx <= r.maxX && cy >= r.minY - 6 && cy <= r.maxY + 6;
}

/** A text field's value after recognized handwriting is added to what it already says. */
export function appendRecognized(field: Pick<PdfField, 'maxLen' | 'multiline'>, prev: FormFieldValue, recognized: string): string {
  const text = recognized.replace(/\s+/g, ' ').trim();
  const before = typeof prev === 'string' ? prev : '';
  return clampText(field, before && text ? `${before} ${text}` : before || text);
}
