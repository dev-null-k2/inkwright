/**
 * Word documents (.docx, Office Open XML) for document notes — written and read here, with
 * fflate for the zip, instead of a general-purpose library: the subset documents use (headings,
 * paragraphs with bold/italic/underline/strike/code/links, bullet, numbered and check lists,
 * quotes, code blocks, tables, images, rules and page breaks) is small, and this keeps a megabyte
 * of dependencies out of the app (and the Android APK).
 *
 * - {@link toDocx} turns the editor's JSON into a .docx that Word, Google Docs, LibreOffice and
 *   Pages open with real styles (Heading 1…6, Quote, Code, List Paragraph), real numbering and
 *   embedded pictures.
 * - {@link fromDocx} reads a .docx into HTML for the editor: the same subset, from any producer,
 *   mapping styles by name and outline level and lists through numbering.xml.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { PMNode } from './markdown.ts';

// ---- Writing -----------------------------------------------------------------------------------

export interface DocxImage {
  /** The image's bytes (PNG or JPEG), its pixel size, by `src` or asset name as the node has it. */
  bytes: Uint8Array;
  type: 'png' | 'jpeg';
  width: number;
  height: number;
}

export interface DocxOptions {
  title?: string;
  /** Bytes of an image node's picture (asset name first, else its src); null leaves it out. */
  image?: (node: PMNode) => Promise<DocxImage | null>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Usable width of an A4 page with 2.5 cm margins, in EMU (1 inch = 914400). */
const CONTENT_EMU = Math.round((21 - 5) / 2.54 * 914400);

interface WriteCtx {
  rels: { id: string; type: string; target: string; external?: boolean }[];
  media: { name: string; bytes: Uint8Array }[];
  /** Numbering instances: one per list, so each numbered list restarts at its own start. */
  nums: { id: number; abstract: 1 | 2; start: number }[];
  images: Map<PMNode, DocxImage | null>;
  drawingId: number;
}

function rel(ctx: WriteCtx, type: string, target: string, external = false): string {
  const id = `rId${ctx.rels.length + 10}`;
  ctx.rels.push({ id, type, target, external });
  return id;
}

function runProps(marks: PMNode['marks']): string {
  const has = (t: string) => marks?.some((m) => m.type === t);
  let p = '';
  if (has('link')) p += '<w:rStyle w:val="Hyperlink"/>';
  if (has('code')) p += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
  if (has('bold')) p += '<w:b/>';
  if (has('italic')) p += '<w:i/>';
  if (has('strike')) p += '<w:strike/>';
  if (has('underline') && !has('link')) p += '<w:u w:val="single"/>';
  if (has('code')) p += '<w:shd w:val="clear" w:color="auto" w:fill="F1EFF3"/>';
  return p ? `<w:rPr>${p}</w:rPr>` : '';
}

function textRun(text: string, marks: PMNode['marks']): string {
  // Tabs and line feeds have their own elements in WordprocessingML.
  const parts = text.split(/(\t|\n)/).filter((x) => x !== '');
  const body = parts.map((x) => (x === '\t' ? '<w:tab/>' : x === '\n' ? '<w:br/>' : `<w:t xml:space="preserve">${esc(x)}</w:t>`)).join('');
  return `<w:r>${runProps(marks)}${body}</w:r>`;
}

function inlineXml(nodes: PMNode[] | undefined, ctx: WriteCtx): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') { out += '<w:r><w:br/></w:r>'; continue; }
    if (n.type === 'image') { out += drawing(n, ctx); continue; }
    if (n.type !== 'text' || !n.text) continue;
    const link = n.marks?.find((m) => m.type === 'link');
    const run = textRun(n.text, n.marks);
    if (link?.attrs?.href) out += `<w:hyperlink r:id="${rel(ctx, `${R_NS}/hyperlink`, String(link.attrs.href), true)}" w:history="1">${run}</w:hyperlink>`;
    else out += run;
  }
  return out;
}

function drawing(n: PMNode, ctx: WriteCtx): string {
  const img = ctx.images.get(n);
  if (!img) return '';
  const name = `image${ctx.media.length + 1}.${img.type === 'png' ? 'png' : 'jpeg'}`;
  ctx.media.push({ name, bytes: img.bytes });
  const rid = rel(ctx, `${R_NS}/image`, `media/${name}`);
  // 96 px per inch on screen; never wider than the page.
  let cx = Math.round((img.width / 96) * 914400);
  let cy = Math.round((img.height / 96) * 914400);
  if (cx > CONTENT_EMU) { cy = Math.round(cy * (CONTENT_EMU / cx)); cx = CONTENT_EMU; }
  const id = ++ctx.drawingId;
  const alt = esc(String(n.attrs?.alt ?? ''));
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

const para = (pPr: string, content: string) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;

function blockXml(n: PMNode, ctx: WriteCtx, list?: { numId: number; level: number }, style?: string): string {
  const styleXml = (s?: string) => (s ? `<w:pStyle w:val="${s}"/>` : '');
  switch (n.type) {
    case 'paragraph': {
      const numPr = list ? `<w:numPr><w:ilvl w:val="${list.level}"/><w:numId w:val="${list.numId}"/></w:numPr>` : '';
      return para(styleXml(list ? 'ListParagraph' : style) + numPr, inlineXml(n.content, ctx));
    }
    case 'heading': return para(styleXml(`Heading${Math.min(6, Number(n.attrs?.level ?? 1))}`), inlineXml(n.content, ctx));
    case 'blockquote': return (n.content ?? []).map((c) => blockXml(c, ctx, undefined, 'Quote')).join('');
    case 'codeBlock': return (((n.content ?? []).map((t) => t.text ?? '').join('')).split('\n')).map((line) => para(styleXml('Code'), line ? textRun(line, undefined) : '')).join('');
    case 'horizontalRule': return para('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="AAAAAA"/></w:pBdr>', '');
    case 'pageBreak': return para('', '<w:r><w:br w:type="page"/></w:r>');
    case 'image': return para('<w:jc w:val="center"/>', drawing(n, ctx));
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const level = list ? list.level + 1 : 0;
      let numId = list?.numId ?? 0;
      if (n.type !== 'taskList' && (!list || level === 0 || n.type === 'orderedList')) {
        numId = ctx.nums.length + 1;
        ctx.nums.push({ id: numId, abstract: n.type === 'orderedList' ? 2 : 1, start: Number(n.attrs?.start ?? 1) || 1 });
      }
      return (n.content ?? []).map((item) => {
        const [first, ...rest] = item.content ?? [];
        let head = '';
        if (n.type === 'taskList') {
          // Word has no plain-XML checkbox; a ballot box character reads the same everywhere.
          const box = textRun(item.attrs?.checked ? '☒ ' : '☐ ', undefined);
          head = para(`${styleXml('ListParagraph')}<w:ind w:left="${360 * (level + 1)}"/>`, box + (first ? inlineXml(first.content, ctx) : ''));
        } else head = first ? blockXml(first, ctx, { numId, level }) : '';
        return head + rest.map((c) => blockXml(c, ctx, { numId, level })).join('');
      }).join('');
    }
    case 'table': {
      const rows = n.content ?? [];
      const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).length));
      const colW = Math.floor(9000 / cols);
      const tr = rows.map((r, i) => {
        const header = i === 0 && (r.content ?? []).every((c) => c.type === 'tableHeader');
        const cells = (r.content ?? []).map((c) => {
          const inner = (c.content ?? []).map((b) => blockXml(b, ctx)).join('') || para('', '');
          return `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F1EFF3"/>' : ''}</w:tcPr>${header ? inner.replace(/<w:r>(<w:rPr>)?/g, (_m, p) => (p ? '<w:r><w:rPr><w:b/>' : '<w:r><w:rPr><w:b/></w:rPr>')) : inner}</w:tc>`;
        }).join('');
        return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
      }).join('');
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${Array(cols).fill(`<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>${tr}</w:tbl>` + para('', '');
    }
    default: return n.content ? n.content.map((c) => blockXml(c, ctx)).join('') : '';
  }
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6].map((l) => `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${l < 3 ? 320 : 200}" w:after="120"/><w:outlineLvl w:val="${l - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[40, 32, 28, 26, 24, 22][l - 1]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BBBBBB"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F1EFF3"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F5F9F"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join('')}</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

function numberingXml(nums: WriteCtx['nums']): string {
  const bullets = ['•', '◦', '▪'];
  const lvl = (abstract: 1 | 2, i: number) => abstract === 1
    ? `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${bullets[i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + 360 * i}" w:hanging="360"/></w:pPr></w:lvl>`
    : `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][i % 3]}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + 360 * i}" w:hanging="360"/></w:pPr></w:lvl>`;
  const abstracts = ([1, 2] as const).map((a) => `<w:abstractNum w:abstractNumId="${a}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(a, i)).join('')}</w:abstractNum>`).join('');
  const instances = nums.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.abstract}"/>${n.abstract === 2 ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride>` : ''}</w:num>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">${abstracts}${instances}</w:numbering>`;
}

function collectImages(n: PMNode, out: PMNode[]) {
  if (n.type === 'image') out.push(n);
  for (const c of n.content ?? []) collectImages(c, out);
}

/** The editor's document as a .docx file. */
export async function toDocx(doc: PMNode, opts: DocxOptions = {}): Promise<Uint8Array> {
  const ctx: WriteCtx = { rels: [], media: [], nums: [], images: new Map(), drawingId: 0 };
  const imgs: PMNode[] = [];
  collectImages(doc, imgs);
  for (const n of imgs) ctx.images.set(n, opts.image ? await opts.image(n).catch(() => null) : null);
  const body = (doc.content ?? []).map((n) => blockXml(n, ctx)).join('');
  const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body || para('', '')}${sect}</w:body></w:document>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R_NS}/numbering" Target="numbering.xml"/>` +
    ctx.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') + '</Relationships>';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'docProps/core.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(opts.title ?? '')}</dc:title><dc:creator>Inkwright</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(STYLES),
    'word/numbering.xml': strToU8(numberingXml(ctx.nums)),
    'word/_rels/document.xml.rels': strToU8(docRels),
  };
  for (const m of ctx.media) files[`word/media/${m.name}`] = m.bytes;
  return zipSync(files, { level: 6 });
}

// ---- Reading -----------------------------------------------------------------------------------

export interface DocxReadResult {
  /** HTML for the editor (images refer to `data-asset` names in `images`). */
  html: string;
  images: { name: string; bytes: Uint8Array; mime: string }[];
  title?: string;
}

/** Children of `el` with the given WordprocessingML local name (prefixes vary by producer). */
const kids = (el: Element, name: string) => [...el.children].filter((c) => c.localName === name);
const kid = (el: Element | undefined | null, name: string) => (el ? kids(el, name)[0] : undefined);
const attr = (el: Element | undefined | null, name: string) => el?.getAttributeNS(W_NS, name) ?? el?.getAttribute(`w:${name}`) ?? null;
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parseXml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');

/** A .docx file as editor HTML plus the pictures it embeds. Throws on files that aren't Word documents. */
export function fromDocx(bytes: Uint8Array, assetPrefix = 'docx'): DocxReadResult {
  let zip: Record<string, Uint8Array>;
  try { zip = unzipSync(bytes); } catch { throw new Error('This file is not a Word document (.docx).'); }
  const text = (p: string) => (zip[p] ? strFromU8(zip[p]!) : null);
  const docXml = text('word/document.xml');
  if (!docXml) throw new Error('This file is not a Word document (.docx).');
  const rels = new Map<string, string>();
  const relXml = text('word/_rels/document.xml.rels');
  if (relXml) for (const r of [...parseXml(relXml).getElementsByTagName('Relationship')]) rels.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');

  // Style ids → heading level / quote / code, by name (ids are localised in some producers).
  const styleKind = new Map<string, { heading?: number; quote?: boolean; code?: boolean; title?: boolean }>();
  const stylesXml = text('word/styles.xml');
  if (stylesXml) {
    for (const s of [...parseXml(stylesXml).getElementsByTagNameNS(W_NS, 'style')]) {
      const id = attr(s, 'styleId') ?? '';
      const name = (attr(kid(s, 'name'), 'val') ?? id).toLowerCase();
      const outline = attr(kid(kid(s, 'pPr'), 'outlineLvl'), 'val');
      const h = /heading\s*(\d)/.exec(name) ?? /^heading(\d)$/i.exec(id);
      styleKind.set(id, {
        heading: h ? Number(h[1]) : outline != null && Number(outline) < 6 ? Number(outline) + 1 : undefined,
        title: name === 'title',
        quote: /quote/.test(name),
        code: /code|source|preformatted|html pre/.test(name),
      });
    }
  }
  // numId → (level → bullet?) from numbering.xml.
  const numFmt = new Map<string, Map<number, string>>();
  const numXml = text('word/numbering.xml');
  if (numXml) {
    const nd = parseXml(numXml);
    const abstract = new Map<string, Map<number, string>>();
    for (const a of [...nd.getElementsByTagNameNS(W_NS, 'abstractNum')]) {
      const lv = new Map<number, string>();
      for (const l of kids(a, 'lvl')) lv.set(Number(attr(l, 'ilvl') ?? 0), attr(kid(l, 'numFmt'), 'val') ?? 'bullet');
      abstract.set(attr(a, 'abstractNumId') ?? '', lv);
    }
    for (const n of [...nd.getElementsByTagNameNS(W_NS, 'num')]) numFmt.set(attr(n, 'numId') ?? '', abstract.get(attr(kid(n, 'abstractNumId'), 'val') ?? '') ?? new Map());
  }

  const images: DocxReadResult['images'] = [];
  const imageFor = (rid: string): string => {
    const target = rels.get(rid);
    if (!target) return '';
    const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`;
    const data = zip[path];
    if (!data) return '';
    const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? 'png').toLowerCase().replace('jpg', 'jpeg');
    if (!['png', 'jpeg', 'gif', 'webp'].includes(ext)) return '';
    const name = `${assetPrefix}-${images.length + 1}.${ext === 'jpeg' ? 'jpg' : ext}`;
    images.push({ name, bytes: data, mime: `image/${ext}` });
    return name;
  };

  const runsHtml = (p: Element): string => {
    let out = '';
    for (const c of [...p.children]) {
      if (c.localName === 'r') out += runHtml(c);
      else if (c.localName === 'hyperlink') {
        const href = rels.get(c.getAttributeNS(R_NS, 'id') ?? c.getAttribute('r:id') ?? '');
        const inner = kids(c, 'r').map(runHtml).join('');
        out += href ? `<a href="${escHtml(href)}">${inner}</a>` : inner;
      } else if (c.localName === 'ins' || c.localName === 'smartTag' || c.localName === 'sdt' || c.localName === 'fldSimple') {
        // Tracked insertions, smart tags and content controls hold ordinary runs.
        const inner = c.localName === 'sdt' ? kid(c, 'sdtContent') : c;
        if (inner) out += runsHtml(inner);
      }
    }
    return out;
  };
  const runHtml = (r: Element): string => {
    const pr = kid(r, 'rPr');
    const on = (n: string) => { const e = kid(pr, n); return !!e && !/^(0|false|none)$/.test(attr(e, 'val') ?? ''); };
    let t = '';
    for (const c of [...r.children]) {
      if (c.localName === 't') t += escHtml(c.textContent ?? '');
      else if (c.localName === 'tab') t += '\t';
      else if (c.localName === 'br') t += attr(c, 'type') === 'page' ? '\u000c' : '<br>';
      else if (c.localName === 'drawing' || c.localName === 'pict') {
        const blip = c.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0] ?? c.getElementsByTagName('v:imagedata')[0];
        const rid = blip?.getAttributeNS(R_NS, 'embed') ?? blip?.getAttributeNS(R_NS, 'id') ?? blip?.getAttribute('r:embed') ?? '';
        const name = rid ? imageFor(rid) : '';
        const alt = c.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')[0]?.getAttribute('descr') ?? '';
        if (name) t += `\u000b${name}\u0001${escHtml(alt).replace(/"/g, '&quot;')}\u000b`;
      }
    }
    if (!t) return '';
    const mono = /courier|consolas|mono/i.test(kid(pr, 'rFonts')?.getAttributeNS(W_NS, 'ascii') ?? '');
    if (mono) t = `<code>${t}</code>`;
    if (on('strike') || on('dstrike')) t = `<s>${t}</s>`;
    if (kid(pr, 'u') && attr(kid(pr, 'u'), 'val') !== 'none') t = `<u>${t}</u>`;
    if (on('i')) t = `<em>${t}</em>`;
    if (on('b')) t = `<strong>${t}</strong>`;
    return t;
  };

  const out: string[] = [];
  /** Open lists while walking paragraphs: [tag, level]. */
  const lists: { tag: 'ul' | 'ol'; level: number }[] = [];
  const closeLists = (toLevel = -1) => { while (lists.length && lists[lists.length - 1]!.level > toLevel) out.push(`</li></${lists.pop()!.tag}>`); };

  const paragraphHtml = (p: Element, inTable: boolean): string => {
    const pr = kid(p, 'pPr');
    const style = styleKind.get(attr(kid(pr, 'pStyle'), 'val') ?? '') ?? {};
    let inner = runsHtml(p);
    // Pictures become their own blocks; a page break splits the paragraph.
    const blocks: string[] = [];
    const parts = inner.split('\u000c');
    parts.forEach((part, i) => {
      const segs = part.split('\u000b');
      segs.forEach((seg, k) => {
        if (k % 2 === 1) { const [name, alt] = seg.split('\u0001'); blocks.push(`<img data-asset="${name}" alt="${alt ?? ''}">`); return; }
        if (!seg.replace(/<br>/g, '').trim() && segs.length > 1) return;
        const tag = style.heading ? `h${Math.min(6, style.heading)}` : style.title ? 'h1' : 'p';
        blocks.push(`<${tag}>${seg}</${tag}>`);
      });
      if (i < parts.length - 1) blocks.push('<div class="page-break"></div>');
    });
    inner = blocks.join('');
    if (!inTable && style.quote) return `<blockquote>${inner}</blockquote>`;
    return inner;
  };

  const tableHtml = (tbl: Element): string => {
    const rows = kids(tbl, 'tr');
    return `<table><tbody>${rows.map((tr, i) => {
      const header = i === 0 && !!kid(kid(tr, 'trPr'), 'tblHeader');
      return `<tr>${kids(tr, 'tc').map((tc) => {
        const tag = header ? 'th' : 'td';
        const span = Number(attr(kid(kid(tc, 'tcPr'), 'gridSpan'), 'val') ?? 1);
        let body = [...tc.children].map((c) => (c.localName === 'p' ? paragraphHtml(c, true) : c.localName === 'tbl' ? tableHtml(c) : '')).join('') || '<p></p>';
        // Header cells are bold by being headers; the runs' own bold would come back as **…**.
        if (header) body = body.replace(/<\/?strong>/g, '');
        return `<${tag}${span > 1 ? ` colspan="${span}"` : ''}>${body}</${tag}>`;
      }).join('')}</tr>`;
    }).join('')}</tbody></table>`;
  };

  let codeLines: string[] | null = null;
  const flushCode = () => { if (codeLines) { out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`); codeLines = null; } };
  let quote: string[] | null = null;
  const flushQuote = () => { if (quote) { out.push(`<blockquote>${quote.join('')}</blockquote>`); quote = null; } };

  const body = parseXml(docXml).getElementsByTagNameNS(W_NS, 'body')[0];
  for (const el of body ? [...body.children] : []) {
    if (el.localName === 'tbl') { flushCode(); flushQuote(); closeLists(); out.push(tableHtml(el)); continue; }
    if (el.localName !== 'p') continue;
    const pr = kid(el, 'pPr');
    const style = styleKind.get(attr(kid(pr, 'pStyle'), 'val') ?? '') ?? {};
    if (style.code) {
      closeLists(); flushQuote();
      (codeLines ??= []).push([...el.getElementsByTagNameNS(W_NS, 't')].map((t) => escHtml(t.textContent ?? '')).join(''));
      continue;
    }
    flushCode();
    const numPr = kid(pr, 'numPr');
    const numId = attr(kid(numPr, 'numId'), 'val');
    const plainText = el.textContent ?? '';
    const isTask = /^[☐☑☒]\s?/.test(plainText);
    if ((numPr && numId && numId !== '0') || isTask) {
      flushQuote();
      const level = Number(attr(kid(numPr, 'ilvl'), 'val') ?? 0);
      const fmt = numFmt.get(numId ?? '')?.get(level) ?? 'bullet';
      const tag: 'ul' | 'ol' = isTask || fmt === 'bullet' || fmt === 'none' ? 'ul' : 'ol';
      const top = lists[lists.length - 1];
      if (top && top.level === level && top.tag !== tag) closeLists(level - 1);
      const cur = lists[lists.length - 1];
      if (!cur || cur.level < level) { out.push(`<${tag}>`); lists.push({ tag, level }); out.push('<li>'); }
      else { closeLists(level); out.push('</li><li>'); }
      let html = paragraphHtml(el, false);
      if (isTask) {
        const checked = /^<p>(<[^>]+>)*[☑☒]/.test(html);
        html = html.replace(/[☐☑☒]\s?/, '');
        out[out.length - 1] = out[out.length - 1]!.replace(/<li>$/, '');
        out.push(`<li data-checked="${checked}"><input type="checkbox"${checked ? ' checked' : ''}>`);
      }
      out.push(html);
      continue;
    }
    closeLists();
    const html = paragraphHtml(el, false);
    if (style.quote) { (quote ??= []).push(html.replace(/^<blockquote>|<\/blockquote>$/g, '')); continue; }
    flushQuote();
    // Empty paragraphs are Word's spacing, not content.
    if (html === '<p></p>') continue;
    out.push(html);
  }
  flushCode(); flushQuote(); closeLists();

  const core = text('docProps/core.xml');
  const title = core ? (parseXml(core).getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent ?? undefined) : undefined;
  return { html: out.join('').replace(/<li><\/li>/g, ''), images, ...(title?.trim() ? { title: title.trim() } : {}) };
}
