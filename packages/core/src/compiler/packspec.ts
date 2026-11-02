/**
 * Validator for the Personal Context Pack format, version 1 (spec/personal-context/v1.md, JSON
 * Schema in spec/personal-context/v1.schema.json): the JSON document `buildContextPack` writes and
 * any other tool may produce or consume.
 *
 * It checks everything the JSON Schema checks — so a producer can use either — and the rules a
 * schema can't express: unique note ids, `link`s that agree with their source's note and page,
 * base64 that decodes, image names that are safe file names, and dates that are real dates.
 * Errors carry a JSON Pointer to the offending value. Pure and dependency-free, so the app, the
 * server and `inkwright context validate` share it.
 */

export const CONTEXT_PACK_FORMAT = 'inkwright-context-pack/1';

export interface PackIssue {
  /** JSON Pointer (RFC 6901) to the value, "" for the document. */
  path: string;
  message: string;
  /** `error`: not conformant. `warning`: conformant, but consumers may struggle. */
  level: 'error' | 'warning';
}

export interface PackValidation {
  ok: boolean;
  /** The format identifier found (when it is one this validator knows). */
  format: string | null;
  issues: PackIssue[];
}

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const ptr = (base: string, k: string | number) => `${base}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ID = /^[0-9A-Za-z_-]{1,64}$/;
const LINK = /^#mem\/([^/]+)\/(\d+)(?:\/(-?\d+),(-?\d+),(\d+),(\d+))?(?:@([^:]+):(\d+))?$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TAGS = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'];

function isDate(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const m = RFC3339.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && se <= 60;
}

/** Checks a parsed document against version 1 of the format. */
export function validateContextPack(doc: unknown): PackValidation {
  const issues: PackIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, level: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, level: 'warning' });
  const str = (o: J, k: string, base: string, opts: { required?: boolean; max?: number; min?: number } = {}): string | undefined => {
    const v = o[k];
    if (v === undefined) {
      if (opts.required) err(ptr(base, k), `${k} is required`);
      return undefined;
    }
    if (typeof v !== 'string') {
      err(ptr(base, k), `${k} must be a string`);
      return undefined;
    }
    if (opts.min !== undefined && v.length < opts.min) err(ptr(base, k), `${k} must not be empty`);
    if (opts.max !== undefined && v.length > opts.max) err(ptr(base, k), `${k} is longer than ${opts.max} characters`);
    return v;
  };
  const arr = (o: J, k: string, base: string, required = true): unknown[] => {
    const v = o[k];
    if (v === undefined) {
      if (required) err(ptr(base, k), `${k} is required`);
      return [];
    }
    if (!Array.isArray(v)) {
      err(ptr(base, k), `${k} must be an array`);
      return [];
    }
    return v;
  };
  const strings = (o: J, k: string, base: string, required = true) => arr(o, k, base, required).forEach((x, i) => typeof x !== 'string' && err(ptr(ptr(base, k), i), 'must be a string'));
  const noExtra = (o: J, allowed: string[], base: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k) && !k.startsWith('x-')) err(ptr(base, k), `unknown property ${k} (extensions must start with "x-")`);
  };

  if (!isObj(doc)) {
    err('', 'a context pack is a JSON object');
    return { ok: false, format: null, issues };
  }
  const format = typeof doc.format === 'string' ? doc.format : null;
  if (format !== CONTEXT_PACK_FORMAT) {
    err('/format', format && /^inkwright-context-pack\/\d+$/.test(format) ? `version ${format.split('/')[1]} is not supported by this validator (it knows ${CONTEXT_PACK_FORMAT})` : `format must be "${CONTEXT_PACK_FORMAT}"`);
    return { ok: false, format, issues };
  }
  noExtra(doc, ['$schema', 'format', 'id', 'title', 'createdAt', 'memory', 'compiled', 'notes', 'images', 'truncated'], '');
  const id = str(doc, 'id', '', { required: true });
  if (id !== undefined && !ID.test(id)) err('/id', 'id must be 1–64 characters of [0-9A-Za-z_-]');
  str(doc, 'title', '', { required: true, min: 1, max: 500 });
  if (doc.createdAt === undefined) err('/createdAt', 'createdAt is required');
  else if (!isDate(doc.createdAt)) err('/createdAt', 'createdAt must be an RFC 3339 date-time');

  // memory
  if (doc.memory === undefined) err('/memory', 'memory is required (use empty lists)');
  else if (!isObj(doc.memory)) err('/memory', 'memory must be an object');
  else {
    noExtra(doc.memory, ['instructions', 'facts'], '/memory');
    strings(doc.memory, 'instructions', '/memory');
    strings(doc.memory, 'facts', '/memory');
  }

  // notes
  const noteIds = new Map<string, number>();
  arr(doc, 'notes', '').forEach((n, i) => {
    const base = ptr('/notes', i);
    if (!isObj(n)) return void err(base, 'a note must be an object');
    noExtra(n, ['id', 'title', 'notebook', 'tags', 'updatedAt', 'summary', 'pages'], base);
    const nid = str(n, 'id', base, { required: true });
    if (nid !== undefined) {
      if (!ID.test(nid)) err(ptr(base, 'id'), 'note ids are 1–64 characters of [0-9A-Za-z_-]');
      if (noteIds.has(nid)) err(ptr(base, 'id'), `note id ${nid} appears twice (also at /notes/${noteIds.get(nid)})`);
      noteIds.set(nid, i);
    }
    str(n, 'title', base, { required: true });
    if (n.notebook !== undefined && n.notebook !== null) str(n, 'notebook', base);
    strings(n, 'tags', base);
    if (n.updatedAt === undefined) err(ptr(base, 'updatedAt'), 'updatedAt is required');
    else if (!isDate(n.updatedAt)) err(ptr(base, 'updatedAt'), 'updatedAt must be an RFC 3339 date-time');
    if (n.summary !== undefined && n.summary !== null) str(n, 'summary', base);
    const seen = new Set<number>();
    arr(n, 'pages', base).forEach((p, k) => {
      const pb = ptr(ptr(base, 'pages'), k);
      if (!isObj(p)) return void err(pb, 'a page must be an object');
      noExtra(p, ['index', 'text'], pb);
      if (!Number.isInteger(p.index) || (p.index as number) < 0) err(ptr(pb, 'index'), 'index must be an integer ≥ 0 (0-based)');
      else if (seen.has(p.index as number)) err(ptr(pb, 'index'), `page index ${p.index} appears twice`);
      else seen.add(p.index as number);
      str(p, 'text', pb, { required: true });
    });
  });

  // compiled
  arr(doc, 'compiled', '').forEach((page, i) => {
    const base = ptr('/compiled', i);
    if (!isObj(page)) return void err(base, 'a compiled page must be an object');
    noExtra(page, ['title', 'kind', 'claims'], base);
    str(page, 'title', base, { required: true, min: 1 });
    str(page, 'kind', base, { required: true, min: 1 });
    arr(page, 'claims', base).forEach((c, k) => {
      const cb = ptr(ptr(base, 'claims'), k);
      if (!isObj(c)) return void err(cb, 'a claim must be an object');
      noExtra(c, ['text', 'tag', 'confidence', 'sources'], cb);
      str(c, 'text', cb, { required: true, min: 1 });
      if (!TAGS.includes(c.tag as string)) err(ptr(cb, 'tag'), `tag must be one of ${TAGS.join(', ')}`);
      if (c.confidence !== undefined && c.confidence !== null && (typeof c.confidence !== 'number' || c.confidence < 0 || c.confidence > 1)) err(ptr(cb, 'confidence'), 'confidence must be a number from 0 to 1');
      const sources = arr(c, 'sources', cb);
      if (c.tag === 'EXTRACTED' && Array.isArray(c.sources) && !sources.length) err(ptr(cb, 'sources'), 'an EXTRACTED claim must cite at least one source');
      sources.forEach((s, m) => {
        const sb = ptr(ptr(cb, 'sources'), m);
        if (typeof s === 'string') return void warn(sb, 'an unresolved source (a string); consumers can show it but not open it');
        if (!isObj(s)) return void err(sb, 'a source is an object (or, unresolved, a string)');
        noExtra(s, ['noteId', 'note', 'page', 'rect', 'recording', 'ms', 'link'], sb);
        const sid = str(s, 'noteId', sb, { required: true });
        if (sid !== undefined && !ID.test(sid)) err(ptr(sb, 'noteId'), 'note ids are 1–64 characters of [0-9A-Za-z_-]');
        if (!Number.isInteger(s.page) || (s.page as number) < 1) err(ptr(sb, 'page'), 'page must be an integer ≥ 1 (1-based)');
        if (s.note !== undefined) str(s, 'note', sb);
        if (s.rect !== undefined) {
          const r = s.rect;
          if (!isObj(r) || !['minX', 'minY', 'maxX', 'maxY'].every((x) => typeof r[x] === 'number') || (r.maxX as number) < (r.minX as number) || (r.maxY as number) < (r.minY as number)) err(ptr(sb, 'rect'), 'rect is {minX, minY, maxX, maxY} with max ≥ min');
        }
        if ((s.recording === undefined) !== (s.ms === undefined)) err(sb, 'recording and ms go together');
        if (s.recording !== undefined) str(s, 'recording', sb, { min: 1 });
        if (s.ms !== undefined && (!Number.isInteger(s.ms) || (s.ms as number) < 0)) err(ptr(sb, 'ms'), 'ms must be an integer ≥ 0');
        const link = str(s, 'link', sb, { required: true });
        if (link !== undefined) {
          const lm = LINK.exec(link);
          if (!lm) err(ptr(sb, 'link'), 'link must look like #mem/<noteId>/<page>[/x,y,w,h][@<recording>:<ms>]');
          else {
            if (sid !== undefined && decodeURIComponent(lm[1]!) !== sid) err(ptr(sb, 'link'), `link points at note ${decodeURIComponent(lm[1]!)}, not ${sid}`);
            if (Number.isInteger(s.page) && Number(lm[2]) !== s.page) err(ptr(sb, 'link'), `link points at page ${lm[2]}, not ${s.page}`);
          }
        }
        if (sid !== undefined && !noteIds.has(sid)) warn(ptr(sb, 'noteId'), `cites note ${sid}, which is not in this pack (consumers can't show its text)`);
      });
    });
  });

  // images
  const names = new Set<string>();
  arr(doc, 'images', '').forEach((im, i) => {
    const base = ptr('/images', i);
    if (!isObj(im)) return void err(base, 'an image must be an object');
    noExtra(im, ['name', 'noteId', 'page', 'alt', 'mediaType', 'base64'], base);
    const name = str(im, 'name', base, { required: true, min: 1, max: 255 });
    if (name !== undefined) {
      if (!/^[^/\\:*?"<>|\u0000-\u001f]+$/.test(name) || name === '.' || name === '..') err(ptr(base, 'name'), 'name must be a plain file name (no folders)');
      if (names.has(name)) err(ptr(base, 'name'), `image name ${name} appears twice`);
      names.add(name);
    }
    str(im, 'noteId', base, { required: true });
    if (!Number.isInteger(im.page) || (im.page as number) < 1) err(ptr(base, 'page'), 'page must be an integer ≥ 1 (1-based)');
    str(im, 'alt', base, { required: true });
    const mt = str(im, 'mediaType', base, { required: true });
    if (mt !== undefined && !/^image\/[a-z0-9.+-]+$/i.test(mt)) err(ptr(base, 'mediaType'), 'mediaType must be an image type');
    const b = str(im, 'base64', base, { required: true });
    if (b !== undefined && !B64.test(b)) err(ptr(base, 'base64'), 'base64 is not valid (standard alphabet, padded)');
  });

  strings(doc, 'truncated', '');
  return { ok: !issues.some((x) => x.level === 'error'), format, issues };
}

/** Parses JSON text and validates it; a syntax error becomes an issue at the document. */
export function validateContextPackText(text: string): PackValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, format: null, issues: [{ path: '', message: `not JSON: ${(e as Error).message}`, level: 'error' }] };
  }
  return validateContextPack(doc);
}
