/**
 * Daily notes ("Today") and the small template language shared with note templates.
 *
 * A daily note is titled with its local calendar day in ISO form (`2026-11-01`) — sortable,
 * unambiguous in every language, and what Obsidian's daily notes use, so `[[2026-11-01]]` links
 * work in both apps. It also carries `daily: "2026-11-01"` so it is found again even if renamed.
 */
import type { NoteMeta, NotebookMeta } from './model.ts';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local calendar day as `YYYY-MM-DD`. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses a `YYYY-MM-DD` key as local midnight; null when it isn't one. */
export function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/** Title of the daily note for a day. */
export function dailyTitle(d: Date): string {
  return dayKey(d);
}

/** The daily note for [key]: one marked with that day first, else one titled with it. */
export function findDailyNote(notes: readonly NoteMeta[], key: string): NoteMeta | undefined {
  const live = notes.filter((n) => n.trashedAt == null);
  return live.filter((n) => n.daily === key).sort((a, b) => a.createdAt - b.createdAt)[0]
    ?? live.filter((n) => n.title.trim() === key).sort((a, b) => a.createdAt - b.createdAt)[0];
}

/** Name of the notebook daily notes live in. */
export const JOURNAL_NAME = 'Journal';

/** The Journal notebook: by remembered id, else by name (top level preferred). */
export function findJournal(notebooks: readonly NotebookMeta[], id?: string | null): NotebookMeta | undefined {
  if (id) {
    const byId = notebooks.find((n) => n.id === id);
    if (byId) return byId;
  }
  const named = notebooks.filter((n) => n.name.trim().toLowerCase() === JOURNAL_NAME.toLowerCase());
  return named.find((n) => !n.parentId) ?? named[0];
}

// ---- Template placeholders -------------------------------------------------------------------

/**
 * Formats a date with Moment-style tokens (the ones Obsidian templates use): `YYYY YY MMMM MMM MM
 * M DD D dddd ddd HH H hh h mm A`. Text in `[brackets]` is kept literally.
 */
export function formatDate(d: Date, format: string, locale?: string): string {
  const month = (style: 'long' | 'short') => new Intl.DateTimeFormat(locale, { month: style }).format(d);
  const weekday = (style: 'long' | 'short') => new Intl.DateTimeFormat(locale, { weekday: style }).format(d);
  const h12 = d.getHours() % 12 || 12;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => pad(d.getFullYear() % 100),
    MMMM: () => month('long'),
    MMM: () => month('short'),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => weekday('long'),
    ddd: () => weekday('short'),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(h12),
    h: () => String(h12),
    mm: () => pad(d.getMinutes()),
    A: () => (d.getHours() < 12 ? 'AM' : 'PM'),
  };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|A/g, (m, lit: string | undefined) => (lit !== undefined ? lit : tokens[m]!()));
}

export interface TemplateContext {
  date: Date;
  title: string;
  locale?: string;
}

/**
 * Expands `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{time:FORMAT}}`, `{{title}}`, `{{weekday}}`
 * (and `{{yesterday}}` / `{{tomorrow}}` as links-ready day keys) in template text.
 */
export function expandTemplate(text: string, ctx: TemplateContext): string {
  if (!text.includes('{{')) return text;
  const shift = (days: number) => { const d = new Date(ctx.date); d.setDate(d.getDate() + days); return d; };
  return text.replace(/\{\{\s*(date|time|title|weekday|yesterday|tomorrow)\s*(?::([^}]*))?\}\}/gi, (_m, key: string, fmt?: string) => {
    switch (key.toLowerCase()) {
      case 'date': return fmt ? formatDate(ctx.date, fmt.trim(), ctx.locale) : dayKey(ctx.date);
      case 'time': return formatDate(ctx.date, fmt?.trim() || 'HH:mm', ctx.locale);
      case 'title': return ctx.title;
      case 'weekday': return formatDate(ctx.date, 'dddd', ctx.locale);
      case 'yesterday': return fmt ? formatDate(shift(-1), fmt.trim(), ctx.locale) : dayKey(shift(-1));
      default: return fmt ? formatDate(shift(1), fmt.trim(), ctx.locale) : dayKey(shift(1));
    }
  });
}
