import { create } from 'zustand';
import type { NoteMeta, NotebookMeta } from '@inkwright/core';
import type { AppVault } from '../lib/vault.ts';

export type Route =
  | { name: 'library' }
  | { name: 'editor'; noteId: string; page?: number }
  | { name: 'settings'; section?: string }
  | { name: 'graph'; focus?: string };

export type LibraryFilter =
  | { kind: 'all' }
  | { kind: 'pinned' }
  | { kind: 'recent' }
  | { kind: 'unfiled' }
  | { kind: 'trash' }
  | { kind: 'notebook'; id: string }
  | { kind: 'tag'; tag: string };

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
}

interface AppState {
  ready: boolean;
  error: string | null;
  vault: AppVault | null;
  notes: NoteMeta[];
  trash: NoteMeta[];
  notebooks: NotebookMeta[];
  route: Route;
  filter: LibraryFilter;
  query: string;
  toasts: Toast[];
  setVault: (v: AppVault) => void;
  refresh: () => Promise<void>;
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
  setFilter: (f: LibraryFilter) => void;
  setQuery: (q: string) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  fail: (message: string) => void;
}

let toastSeq = 1;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  error: null,
  vault: null,
  notes: [],
  trash: [],
  notebooks: [],
  route: { name: 'library' },
  filter: { kind: 'all' },
  query: '',
  toasts: [],
  setVault: (v) => set({ vault: v }),
  refresh: async () => {
    const v = get().vault;
    if (!v) return;
    const all = await v.listNotes(true);
    set({
      notes: all.filter((n) => n.trashedAt == null),
      trash: all.filter((n) => n.trashedAt != null),
      notebooks: await v.listNotebooks(),
      ready: true,
    });
  },
  navigate: (r, opts) => {
    set({ route: r });
    try {
      const url = r.name === 'editor' ? `#note/${r.noteId}` : r.name === 'settings' ? `#settings${r.section ? '/' + r.section : ''}` : r.name === 'graph' ? '#graph' : '#';
      if (opts?.replace) history.replaceState(r, '', url);
      else history.pushState(r, '', url);
    } catch { /* sandboxed iframes may refuse history */ }
  },
  setFilter: (f) => set({ filter: f, query: '' }),
  setQuery: (q) => set({ query: q }),
  toast: (t) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] });
    setTimeout(() => get().dismissToast(id), t.action ? 6500 : 3200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
  fail: (message) => get().toast({ text: message, tone: 'error' }),
}));

export function routeFromHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  if (h.startsWith('note/')) return { name: 'editor', noteId: h.slice(5) };
  if (h.startsWith('settings')) return { name: 'settings', section: h.split('/')[1] };
  if (h === 'graph') return { name: 'graph' };
  return { name: 'library' };
}
