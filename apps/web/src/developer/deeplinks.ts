/**
 * The URL API: links that make Inkstone do something, for Shortcuts, Tasker, launchers, bookmarks
 * and other apps (docs/API.md § Links).
 *
 *   inkstone://new?title=Groceries&text=-%20milk&tags=home      a new note (typed text)
 *   inkstone://open?note=<id>&page=2                              open a note (or ?title=…)
 *   inkstone://search?q=pricing                                   search everything
 *   inkstone://capture?url=https://…&title=…&text=…               save a link (and a quote)
 *   inkstone://today                                              today's daily note
 *
 * The same actions work as web links — `https://<app>/?action=new&title=…` — and through the
 * installed web app's protocol handler `web+inkstone://…` (browsers only allow `web+` schemes
 * for web apps; the Android app registers `inkstone://`). Links never delete, change or reveal
 * anything: they create notes, open them or search, all in front of the user.
 */
import { useApp } from '../state/app.ts';
import { isNative } from '../platform/env.ts';
import { isModuleOn } from '../modules/registry.ts';

export type DeepLinkAction =
  | { action: 'new'; title?: string; text?: string; tags: string[]; notebook?: string }
  | { action: 'open'; note?: string; title?: string; page?: number }
  | { action: 'search'; q: string }
  | { action: 'capture'; url: string; title?: string; text?: string; tags: string[] }
  | { action: 'today' };

const ACTIONS = new Set(['new', 'open', 'search', 'capture', 'today']);
const MAX_TEXT = 50_000;

const clip = (v: string | null, max: number) => (v == null ? undefined : v.slice(0, max));
const tagList = (v: string | null) => (v ? v.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 20) : []);

/**
 * Parses a link into an action, or null when it is not one of ours. Accepts `inkstone://`,
 * `web+inkstone://`, an app URL with `?action=…`, or an app URL carrying a protocol-handler
 * `?link=web+inkstone://…`.
 */
export function parseDeepLink(raw: string): DeepLinkAction | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const inner = u.searchParams.get('link');
  if (inner && /^(web\+)?inkstone:/i.test(inner)) return parseDeepLink(inner);
  let action: string | null;
  if (/^(web\+)?inkstone:$/i.test(u.protocol)) {
    // inkstone://new?… (host = action) and inkstone:new?… (path = action) both appear in the wild.
    action = (u.host || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  } else if (u.protocol === 'https:' || u.protocol === 'http:') {
    action = u.searchParams.get('action')?.toLowerCase() ?? null;
  } else return null;
  if (!action || !ACTIONS.has(action)) return null;
  const q = u.searchParams;
  switch (action) {
    case 'new':
      return { action, ...(q.get('title') ? { title: clip(q.get('title'), 300) } : {}), ...(q.get('text') ? { text: clip(q.get('text'), MAX_TEXT) } : {}), tags: tagList(q.get('tags')), ...(q.get('notebook') ? { notebook: clip(q.get('notebook'), 200) } : {}) };
    case 'open': {
      const note = q.get('note') ?? q.get('id');
      const page = Number(q.get('page'));
      if (!note && !q.get('title')) return null;
      if (note && !/^[0-9A-Za-z_-]{1,64}$/.test(note)) return null;
      return { action, ...(note ? { note } : {}), ...(q.get('title') ? { title: clip(q.get('title'), 300) } : {}), ...(Number.isInteger(page) && page >= 1 ? { page } : {}) };
    }
    case 'search': {
      const s = q.get('q') ?? q.get('query');
      return s?.trim() ? { action, q: s.trim().slice(0, 500) } : null;
    }
    case 'capture': {
      const url = q.get('url');
      if (!url) return null;
      try {
        const target = new URL(url);
        if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
      } catch {
        return null;
      }
      return { action, url: url.slice(0, 2000), ...(q.get('title') ? { title: clip(q.get('title'), 300) } : {}), ...(q.get('text') ? { text: clip(q.get('text'), MAX_TEXT) } : {}), tags: tagList(q.get('tags')) };
    }
    case 'today':
      return { action };
  }
  return null;
}

/** Markdown body of a captured link. */
export function captureMarkdown(a: Extract<DeepLinkAction, { action: 'capture' }>): string {
  const label = (a.title ?? new URL(a.url).hostname).replace(/[[\]]/g, '');
  const quote = a.text?.trim() ? `\n\n${a.text.trim().split('\n').map((l) => `> ${l}`).join('\n')}` : '';
  return `[${label}](${a.url})${quote}`;
}

/** Does what the link asks, in front of the user. */
export async function runDeepLink(a: DeepLinkAction): Promise<void> {
  const app = useApp.getState();
  const vault = app.vault;
  if (!vault) return;
  if (a.action === 'today') {
    const { openToday } = await import('../lib/knowledge.ts');
    await openToday();
    return;
  }
  if (a.action === 'open') {
    const notes = await vault.listNotes();
    const n = a.note ? notes.find((x) => x.id === a.note) : notes.find((x) => x.title.toLowerCase() === a.title!.toLowerCase());
    if (!n) return app.toast({ text: 'That link points to a note that isn’t on this device.', tone: 'error' });
    app.navigate({ name: 'editor', noteId: n.id, ...(a.page ? { page: Math.min(a.page, n.pageIds.length) - 1 } : {}) });
    return;
  }
  if (a.action === 'search') {
    if (isModuleOn('search')) {
      app.navigate({ name: 'library' });
      const { openPalette } = await import('../lib/palette.ts');
      openPalette({ query: a.q });
    } else {
      app.setFilter({ kind: 'all' });
      app.navigate({ name: 'library' });
      app.toast({ text: `Search everything is switched off (Settings › Modules); showing all notes.` });
    }
    return;
  }
  const notebooks = a.action === 'new' && a.notebook ? await vault.listNotebooks() : [];
  const notebookId = a.action === 'new' && a.notebook ? notebooks.find((n) => n.id === a.notebook || n.name.toLowerCase() === a.notebook!.toLowerCase())?.id : undefined;
  const title = a.action === 'new' ? a.title ?? `Note ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : a.title ?? new URL(a.url).hostname;
  const text = a.action === 'new' ? a.text ?? '' : captureMarkdown(a);
  const tags = a.action === 'capture' ? [...new Set(['captured', ...a.tags])] : a.tags;
  let id: string;
  if (text.trim()) {
    // Typed text marked as imported (not handwriting, not AI) for proof of authorship.
    const { AppNoteToolHost } = await import('../lib/ai.ts');
    id = (await new AppNoteToolHost(vault, null, 'import').createNote({ title, text, tags, ...(notebookId ? { notebookId } : {}) })).id;
  } else {
    const { createNote, setTags } = await import('../lib/actions.ts');
    const made = await createNote({ title, ...(notebookId ? { notebookId } : {}) });
    if (!made) return;
    id = made;
    if (tags.length) await setTags(id, tags);
  }
  app.navigate({ name: 'editor', noteId: id });
}

/** Handles the link the app was opened with, then removes it from the address bar. */
async function consumeLaunchUrl(): Promise<void> {
  const here = new URL(location.href);
  if (!here.searchParams.has('action') && !here.searchParams.has('link')) return;
  const a = parseDeepLink(here.href);
  for (const k of ['action', 'link', 'title', 'text', 'tags', 'notebook', 'note', 'id', 'page', 'q', 'query', 'url']) here.searchParams.delete(k);
  history.replaceState(history.state, '', here.href);
  if (a) await runDeepLink(a);
}

/** The "Links from other apps" module: launch URL, Android intents, PWA protocol handler. */
export function startDeepLinks(): () => void {
  const run = (url: string) => {
    const a = parseDeepLink(url);
    if (a) void runDeepLink(a).catch((e) => useApp.getState().fail((e as Error).message));
  };
  void consumeLaunchUrl().catch((e) => useApp.getState().fail((e as Error).message));
  let remove: (() => void) | null = null;
  if (isNative) {
    void import('@capacitor/app').then(async ({ App }) => {
      const launch = await App.getLaunchUrl().catch(() => undefined);
      if (launch?.url) run(launch.url);
      const h = await App.addListener('appUrlOpen', (e) => run(e.url));
      remove = () => void h.remove();
    });
  }
  return () => remove?.();
}
