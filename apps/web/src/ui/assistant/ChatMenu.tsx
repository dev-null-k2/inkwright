import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { History, MessageSquarePlus, NotebookPen, Trash2 } from 'lucide-react';
import type { ChatMessage } from '@inkwright/ai';
import {
  GENERAL_SCOPE,
  chatTitle,
  deleteChat,
  getChat,
  latestChat,
  listChats,
  newThread,
  saveChat,
  type ChatSummary,
  type ChatThread,
  type StoredChatItem,
} from '../../lib/assistant/chats.ts';
import { IconButton, Menu, Popover, relativeTime } from '../primitives.tsx';

/** What the panel shows for one message (actions are rebuilt per session, never stored). */
export interface PanelItem extends StoredChatItem {
  actions?: { label: string; run: () => void }[];
}

const strip = ({ actions: _a, ...it }: PanelItem): StoredChatItem => it;
const signature = (items: readonly PanelItem[]) => `${items.length}:${items.at(-1)?.id ?? ''}:${items.at(-1)?.text.length ?? 0}`;

/**
 * Keeps the assistant panel's conversation: opens the note's latest chat when the panel opens,
 * saves after every finished turn, and switches between chats (this note's, or general ones).
 * `history` is the panel's model-facing transcript ref, restored with the chat.
 */
export function usePersistentChat(o: { scope: string; items: PanelItem[]; setItems: (items: PanelItem[]) => void; history: MutableRefObject<ChatMessage[]>; busy: boolean }) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const saved = useRef('');

  const load = (t: ChatThread) => {
    saved.current = signature(t.items);
    o.history.current = t.history;
    o.setItems(t.items);
    setThread(t);
  };

  useEffect(() => {
    let live = true;
    void latestChat(o.scope).catch(() => null).then((t) => {
      if (!live) return;
      if (t) load(t);
      else { saved.current = signature([]); setThread(newThread(o.scope)); }
    });
    return () => { live = false; };
  }, [o.scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save once a turn has finished (not on every streamed token).
  useEffect(() => {
    if (!thread || o.busy || !o.items.length) return;
    const sig = signature(o.items);
    if (sig === saved.current) return;
    saved.current = sig;
    const first = o.items.find((i) => i.role === 'user');
    const next: ChatThread = { ...thread, title: thread.title === 'New chat' && first ? chatTitle(first.text) : thread.title, items: o.items.map(strip), history: o.history.current, updatedAt: Date.now() };
    setThread(next);
    void saveChat(next).catch((e) => console.warn('Chat not saved', e));
  }, [o.items, o.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    thread,
    /** Starts an empty chat (this note's by default, or a general one). */
    startNew(scope = o.scope) {
      const t = newThread(scope);
      saved.current = signature([]);
      o.history.current = [];
      o.setItems([]);
      setThread(t);
    },
    async open(id: string) {
      const t = await getChat(id);
      if (t) load(t);
    },
  };
}

/**
 * The panel's chats menu: a new chat about this note, a new general chat, and past chats (this
 * note's first, then general ones) to continue.
 */
export function ChatMenu({ scope, current, onNew, onOpen }: { scope: string; current: ChatThread | null; onNew: (scope: string) => void; onOpen: (id: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = !!anchor;
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const refresh = () => void Promise.all([listChats(scope), scope === GENERAL_SCOPE ? Promise.resolve([]) : listChats(GENERAL_SCOPE)]).then(([mine, general]) => setChats([...mine, ...general].slice(0, 12))).catch(() => setChats([]));
  useEffect(() => { if (open) refresh(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => setAnchor(null);
  return (
    <>
      <IconButton label="Chats" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}><History size={17} /></IconButton>
      <Popover anchor={anchor} open={open} onClose={close} placement="below" title="Chats">
        <Menu onClose={close} items={[
          { label: scope === GENERAL_SCOPE ? 'New chat' : 'New chat about this note', icon: <NotebookPen size={15} />, onClick: () => onNew(scope) },
          ...(scope === GENERAL_SCOPE ? [] : [{ label: 'New general chat', icon: <MessageSquarePlus size={15} />, onClick: () => onNew(GENERAL_SCOPE) }]),
          ...(chats.length ? ['sep' as const] : []),
          ...chats.map((c) => ({
            label: `${c.id === current?.id ? '• ' : ''}${c.title}`,
            hint: `${c.scope === GENERAL_SCOPE && scope !== GENERAL_SCOPE ? 'General · ' : ''}${relativeTime(c.updatedAt)}`,
            onClick: () => onOpen(c.id),
          })),
        ]} />
        {current && current.items.length > 0 && (
          <button type="button" className="chat-delete" onClick={() => { close(); void deleteChat(current.id).then(() => onNew(current.scope)); }}>
            <Trash2 size={14} aria-hidden /> Delete this chat
          </button>
        )}
      </Popover>
    </>
  );
}
