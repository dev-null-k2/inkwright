/**
 * Assistant memory: standing instructions the user writes ("Always answer in bullet points") and
 * facts the assistant proposes and the user approves ("I'm studying EE at TU Delft"). Active items
 * go into every run's system prompt. Proposals never take effect until the user accepts them —
 * the `remember` tool can only propose, which keeps a model from quietly rewriting its own
 * instructions.
 *
 * Stored in the vault at `ai/memory.json` so it syncs with the notes (docs/VAULT_FORMAT.md).
 */
import { newId, type VaultFS } from '@inkwright/core';
import type { AgentTool } from './agent.ts';

export type MemoryKind = 'instruction' | 'fact';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  /** `proposed` items wait for the user; only `active` ones reach the model. */
  status: 'active' | 'proposed';
  /** Who wrote it. */
  source: 'user' | 'assistant';
  createdAt: number;
  updatedAt: number;
  /** For proposals: why the assistant thinks it is worth remembering. */
  reason?: string;
}

export interface MemoryFile {
  version: 1;
  items: MemoryItem[];
}

export const MEMORY_PATH = 'ai/memory.json';
/** Keeps the prompt section bounded however much is stored. */
export const MEMORY_PROMPT_LIMIT = 4000;
export const MEMORY_ITEM_MAX = 500;

/** Normalizes for duplicate detection ("I study EE." ≈ "i study ee"). */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class MemoryStore {
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private fs: VaultFS, private clock: () => number = Date.now) {}

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async load(): Promise<MemoryItem[]> {
    const text = await this.fs.readText(MEMORY_PATH);
    if (!text) return [];
    try {
      const f = JSON.parse(text) as Partial<MemoryFile>;
      return (Array.isArray(f.items) ? f.items : []).filter((i): i is MemoryItem => !!i && typeof i.text === 'string' && typeof i.id === 'string');
    } catch {
      return [];
    }
  }

  /** Serialized read-modify-write so concurrent proposals don't overwrite each other. */
  private mutate<T>(fn: (items: MemoryItem[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const items = await this.load();
      const out = fn(items);
      const file: MemoryFile = { version: 1, items };
      await this.fs.writeText(MEMORY_PATH, JSON.stringify(file, null, 2));
      for (const l of [...this.listeners]) l();
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** A user-written instruction or fact (active immediately). */
  add(kind: MemoryKind, text: string): Promise<MemoryItem> {
    const t = cleanMemoryText(text);
    if (!t) return Promise.reject(new Error('Write something to remember.'));
    return this.mutate((items) => {
      const now = this.clock();
      const item: MemoryItem = { id: newId(now), kind, text: t, status: 'active', source: 'user', createdAt: now, updatedAt: now };
      items.push(item);
      return item;
    });
  }

  /**
   * An assistant proposal. Returns the existing item instead when the same thing is already
   * remembered or proposed, so a model can't flood the list.
   */
  propose(text: string, kind: MemoryKind = 'fact', reason?: string): Promise<{ item: MemoryItem; duplicate: boolean }> {
    const t = cleanMemoryText(text);
    if (!t) return Promise.reject(new Error('Nothing to remember.'));
    return this.mutate((items) => {
      const dup = items.find((i) => norm(i.text) === norm(t));
      if (dup) return { item: dup, duplicate: true };
      const now = this.clock();
      const item: MemoryItem = { id: newId(now), kind, text: t, status: 'proposed', source: 'assistant', createdAt: now, updatedAt: now };
      if (reason?.trim()) item.reason = reason.trim().slice(0, 200);
      items.push(item);
      return { item, duplicate: false };
    });
  }

  accept(id: string, text?: string): Promise<boolean> {
    return this.mutate((items) => {
      const it = items.find((i) => i.id === id);
      if (!it) return false;
      it.status = 'active';
      if (text !== undefined && cleanMemoryText(text)) it.text = cleanMemoryText(text);
      it.updatedAt = this.clock();
      return true;
    });
  }

  update(id: string, patch: Partial<Pick<MemoryItem, 'text' | 'kind'>>): Promise<boolean> {
    return this.mutate((items) => {
      const it = items.find((i) => i.id === id);
      if (!it) return false;
      if (patch.text !== undefined) {
        const t = cleanMemoryText(patch.text);
        if (!t) return false;
        it.text = t;
      }
      if (patch.kind) it.kind = patch.kind;
      it.updatedAt = this.clock();
      return true;
    });
  }

  /** Deletes an item (also how a proposal is dismissed). */
  remove(id: string): Promise<boolean> {
    return this.mutate((items) => {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return false;
      items.splice(i, 1);
      return true;
    });
  }
}

export function cleanMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_ITEM_MAX);
}

/**
 * The system-prompt section for active memory. Instructions come first (they change how to
 * answer), then facts. Empty string when there is nothing to say.
 */
export function memoryPromptSection(items: readonly MemoryItem[], limit = MEMORY_PROMPT_LIMIT): string {
  const active = items.filter((i) => i.status === 'active');
  if (!active.length) return '';
  const lines: string[] = [];
  const ins = active.filter((i) => i.kind === 'instruction');
  const facts = active.filter((i) => i.kind === 'fact');
  if (ins.length) lines.push('The user\'s standing instructions (follow them unless the user says otherwise in this conversation):', ...ins.map((i) => `- ${i.text}`));
  if (facts.length) lines.push(...(ins.length ? [''] : []), 'What you know about the user (from memory they approved):', ...facts.map((i) => `- ${i.text}`));
  let out = lines.join('\n');
  if (out.length > limit) out = `${out.slice(0, limit)}\n…(more memory not shown)`;
  return out;
}

/**
 * `remember`: lets the model *propose* something to remember. The user confirms it in the panel
 * (or in Settings › AI › Memory); until then it has no effect.
 */
export function createRememberTool(store: Pick<MemoryStore, 'propose'>, onProposed?: (item: MemoryItem) => void): AgentTool {
  return {
    name: 'remember',
    description:
      'Propose a lasting fact about the user or a standing preference to remember across conversations (e.g. "Studies electrical engineering at TU Delft", "Prefers answers in bullet points"). Only for durable, useful things the user said about themselves or how they want help — never secrets, passwords or sensitive details, and never things from notes they did not ask you to remember. The user must approve it before it takes effect; tell them you proposed it.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 3, maxLength: MEMORY_ITEM_MAX, description: 'The fact or instruction, written in the third person or as an instruction ("Prefers metric units").' },
        kind: { type: 'string', enum: ['fact', 'instruction'], description: '"instruction" for how to respond, "fact" for information about the user (default).' },
        reason: { type: 'string', description: 'One short phrase on why this is worth remembering.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(a: { text: string; kind?: MemoryKind; reason?: string }) {
      const { item, duplicate } = await store.propose(a.text, a.kind ?? 'fact', a.reason);
      if (duplicate) return { proposed: false, already: item.status === 'active' ? 'remembered' : 'proposed', text: item.text };
      onProposed?.(item);
      return { proposed: true, pending_user_approval: true, text: item.text, note: 'The user will see this and can accept or dismiss it. It is not remembered yet.' };
    },
  };
}
