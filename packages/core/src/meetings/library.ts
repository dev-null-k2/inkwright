/**
 * Your own templates and recipes, and meeting settings shared by your devices:
 * `ai/meetings/library.json`. Merged by id (newest edit wins); a deletion is kept as a
 * tombstone so a device that still has the item doesn't bring it back.
 */
import type { MeetingTemplate, Recipe, TemplateSection } from './templates.ts';

export const MEETINGS_LIBRARY_PATH = 'ai/meetings/library.json';

export interface MeetingsLibrary {
  formatVersion: 1;
  templates: MeetingTemplate[];
  recipes: Recipe[];
  /** Ids deleted, with when (tombstones, kept 90 days). */
  deleted: Record<string, number>;
  updatedAt: number;
}

export const emptyLibrary = (): MeetingsLibrary => ({ formatVersion: 1, templates: [], recipes: [], deleted: {}, updatedAt: 0 });

const ID = /^[0-9A-Za-z_-]{1,64}$/;
const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function decodeTemplate(v: unknown): MeetingTemplate | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id) || !s(o.name, 120).trim()) return null;
  const sections = (Array.isArray(o.sections) ? o.sections : []).flatMap((x): TemplateSection[] => {
    if (!x || typeof x !== 'object') return [];
    const xo = x as Record<string, unknown>;
    const heading = s(xo.heading, 120).trim();
    return heading ? [{ heading, guide: s(xo.guide, 600), ...(xo.actions === true ? { actions: true } : {}) }] : [];
  }).slice(0, 20);
  if (!sections.length) return null;
  return {
    id: o.id, name: s(o.name, 120).trim(), description: s(o.description, 400), sections,
    ...(s(o.match, 300) ? { match: s(o.match, 300) } : {}),
    ...(s(o.context, 2000) ? { context: s(o.context, 2000) } : {}),
    updatedAt: Number(o.updatedAt) || 0,
  };
}

function decodeRecipe(v: unknown): Recipe | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id) || !s(o.name, 120).trim() || !s(o.prompt, 4000).trim()) return null;
  return {
    id: o.id, name: s(o.name, 120).trim(), description: s(o.description, 400), prompt: s(o.prompt, 4000).trim(),
    scope: o.scope === 'many' ? 'many' : 'meeting',
    ...(s(o.icon, 32) ? { icon: s(o.icon, 32) } : {}),
    updatedAt: Number(o.updatedAt) || 0,
  };
}

export function decodeMeetingsLibrary(json: string | null): MeetingsLibrary {
  if (!json) return emptyLibrary();
  const o = JSON.parse(json) as Record<string, unknown>;
  const deleted: Record<string, number> = {};
  if (o.deleted && typeof o.deleted === 'object') for (const [k, v] of Object.entries(o.deleted)) if (ID.test(k) && Number(v) > 0) deleted[k] = Number(v);
  return {
    formatVersion: 1,
    templates: (Array.isArray(o.templates) ? o.templates : []).map(decodeTemplate).filter((x): x is MeetingTemplate => !!x),
    recipes: (Array.isArray(o.recipes) ? o.recipes : []).map(decodeRecipe).filter((x): x is Recipe => !!x),
    deleted,
    updatedAt: Number(o.updatedAt) || 0,
  };
}

export function encodeMeetingsLibrary(l: MeetingsLibrary): string {
  return `${JSON.stringify(l, null, 2)}\n`;
}

/** Adds or replaces a template or recipe (by id). */
export function upsertInLibrary(l: MeetingsLibrary, kind: 'templates' | 'recipes', item: MeetingTemplate | Recipe, now = Date.now()): MeetingsLibrary {
  const list = (l[kind] as Array<MeetingTemplate | Recipe>).filter((x) => x.id !== item.id);
  const deleted = { ...l.deleted };
  delete deleted[item.id];
  return { ...l, [kind]: [...list, { ...item, builtIn: undefined, updatedAt: now }], deleted, updatedAt: now };
}

export function removeFromLibrary(l: MeetingsLibrary, id: string, now = Date.now()): MeetingsLibrary {
  return { ...l, templates: l.templates.filter((x) => x.id !== id), recipes: l.recipes.filter((x) => x.id !== id), deleted: { ...l.deleted, [id]: now }, updatedAt: now };
}

const TOMBSTONE_MS = 90 * 24 * 3600_000;

/** Two-way union (base not needed): newest edit wins per id; a deletion newer than the edit wins. */
export function mergeMeetingsLibraries(a: MeetingsLibrary, b: MeetingsLibrary, now = Date.now()): MeetingsLibrary {
  const deleted: Record<string, number> = {};
  for (const [k, v] of [...Object.entries(a.deleted), ...Object.entries(b.deleted)]) if (now - v < TOMBSTONE_MS) deleted[k] = Math.max(deleted[k] ?? 0, v);
  const pick = <T extends { id: string; updatedAt?: number }>(x: T[], y: T[]): T[] => {
    const m = new Map<string, T>();
    for (const it of [...x, ...y]) {
      const cur = m.get(it.id);
      if (!cur || (it.updatedAt ?? 0) > (cur.updatedAt ?? 0)) m.set(it.id, it);
    }
    return [...m.values()].filter((it) => !(deleted[it.id] && deleted[it.id]! >= (it.updatedAt ?? 0))).sort((p, q) => (p.updatedAt ?? 0) - (q.updatedAt ?? 0));
  };
  return { formatVersion: 1, templates: pick(a.templates, b.templates), recipes: pick(a.recipes, b.recipes), deleted, updatedAt: Math.max(a.updatedAt, b.updatedAt) };
}
