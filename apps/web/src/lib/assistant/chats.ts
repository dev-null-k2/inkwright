/**
 * Assistant conversations that survive closing the panel and restarting the app: one thread per
 * note (what you asked about this note) plus general threads, each with what the panel shows and
 * the turns the model is given next time ("is there no memory?" — there is now, for every engine).
 *
 * Kept in IndexedDB on this device only, like the memory index's vectors: chats can quote notes,
 * including local-only ones, so they are not synced. Images are never stored (a lasso picture is
 * re-made when needed); history is capped so a long chat stays fast to load.
 */
import type { ChatMessage, ContentPart } from '@inkwright/ai';

export const GENERAL_SCOPE = 'general';

export interface StoredChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  tool?: { name: string; ok?: boolean; detail?: string };
}

export interface ChatThread {
  id: string;
  /** The note id, or `general`. */
  scope: string;
  /** The first question, shortened. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** What the panel shows. */
  items: StoredChatItem[];
  /** What the model is given as earlier turns (text only). */
  history: ChatMessage[];
}

export type ChatSummary = Pick<ChatThread, 'id' | 'scope' | 'title' | 'createdAt' | 'updatedAt'> & { turns: number };

const DB = 'inkwright-chats';
const STORE = 'threads';
export const MAX_ITEMS = 200;
export const MAX_HISTORY = 60;

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('scope', 'scope');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const r = run(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

/** Text only: images dropped (a placeholder keeps the turn's meaning), tool turns kept as text. */
export function storableHistory(history: readonly ChatMessage[]): ChatMessage[] {
  return history.slice(-MAX_HISTORY).map((m) => {
    if (typeof m.content === 'string') return m;
    const parts: ContentPart[] = m.content.map((p) => (p.type === 'image' ? { type: 'text', text: '[image]' } : p));
    return { ...m, content: parts };
  });
}

export function chatTitle(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  return q.length > 60 ? `${q.slice(0, 57).trimEnd()}…` : q || 'New chat';
}

export function newThread(scope: string, now = Date.now()): ChatThread {
  return { id: `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, scope, title: 'New chat', createdAt: now, updatedAt: now, items: [], history: [] };
}

export async function saveChat(t: ChatThread): Promise<void> {
  if (!t.items.length) return; // an empty chat is not worth keeping
  const stored: ChatThread = { ...t, items: t.items.slice(-MAX_ITEMS), history: storableHistory(t.history) };
  await tx('readwrite', (s) => s.put(stored));
}

export function getChat(id: string): Promise<ChatThread | null> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<ChatThread | undefined>).then((t) => t ?? null);
}

export async function deleteChat(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

/** Chats, newest first; for one scope when given (a note's id or `general`). */
export async function listChats(scope?: string): Promise<ChatSummary[]> {
  const all = await tx('readonly', (s) => (scope ? s.index('scope').getAll(scope) : s.getAll()) as IDBRequest<ChatThread[]>);
  return all
    .map((t) => ({ id: t.id, scope: t.scope, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, turns: t.items.filter((i) => i.role === 'user').length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recent chat for a scope, to continue where the person left off. */
export async function latestChat(scope: string): Promise<ChatThread | null> {
  const [first] = await listChats(scope);
  return first ? getChat(first.id) : null;
}

/** Tests only. */
export async function clearChatsForTests(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}
