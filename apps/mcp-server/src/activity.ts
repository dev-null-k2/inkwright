/**
 * Logs the changes outside agents make through this server into the vault's AI activity log
 * (`ai/activity/<runId>.json`, docs/VAULT_FORMAT.md), so the Inkstone app shows them next to its
 * own assistant's runs — with Undo. One run per MCP connection; each write tool call adds
 * reversible operations derived from the vault before and after the call.
 *
 * The format is the contract shared with @inkstone/ai's `ActivityRun` (not imported here: the
 * server is bundled on its own).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { VaultLayout, newId, type NoteMeta } from '@inkstone/core';
import { readNoteFresh, type ServerContext } from './context.ts';

interface MetaFields {
  title?: string;
  tags?: string[];
  notebookId?: string | null;
  pinned?: boolean;
  summary?: string | null;
}

type Op = { id: string; at: number; tool: string; summary: string } & (
  | { kind: 'note_created'; noteId: string; title: string }
  | { kind: 'note_trashed'; noteId: string; title: string }
  | { kind: 'text_appended'; noteId: string; title: string; pageId: string; textId: string; text: string; addedPage?: boolean }
  | { kind: 'meta_changed'; noteId: string; title: string; before: MetaFields; after: MetaFields }
  | { kind: 'notebook_created'; notebookId: string; name: string }
  | { kind: 'handwriting_recognized'; noteId: string; title: string; pageId: string; text: string }
);

export type NewOp = Op extends infer T ? (T extends Op ? Omit<T, 'id' | 'at'> : never) : never;

interface Run {
  id: string;
  source: 'external';
  label: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done';
  ops: Op[];
}

const q = (s: string) => `“${(s || 'Untitled').slice(0, 60)}”`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fields(n: NoteMeta): MetaFields {
  return { title: n.title, tags: [...n.tags], notebookId: n.notebookId ?? null, pinned: n.pinned, summary: n.summary ?? null };
}

function describeMeta(b: MetaFields, a: MetaFields): string {
  const out: string[] = [];
  if (a.title !== undefined && a.title !== b.title) out.push(`renamed ${q(b.title ?? '')} → ${q(a.title)}`);
  if (a.tags) {
    const added = a.tags.filter((t) => !(b.tags ?? []).includes(t));
    const removed = (b.tags ?? []).filter((t) => !a.tags!.includes(t));
    if (added.length) out.push(`tagged ${added.map((t) => `#${t}`).join(' ')}`);
    if (removed.length) out.push(`removed ${removed.map((t) => `#${t}`).join(' ')}`);
  }
  if (a.notebookId !== undefined && a.notebookId !== b.notebookId) out.push(a.notebookId ? 'moved to another notebook' : 'unfiled');
  if (a.pinned !== undefined && a.pinned !== b.pinned) out.push(a.pinned ? 'pinned' : 'unpinned');
  if (a.summary !== undefined && a.summary !== b.summary) out.push(a.summary ? 'set the summary' : 'cleared the summary');
  return out.join(', ') || 'no visible change';
}

const META_ARG: Record<string, keyof MetaFields> = { title: 'title', tags: 'tags', notebookId: 'notebookId', pinned: 'pinned', summary: 'summary' };

function resultJson(r: CallToolResult): Record<string, any> | null {
  const t = r.content?.find((c) => c.type === 'text') as { text?: string } | undefined;
  try {
    return t?.text ? JSON.parse(t.text) : null;
  } catch {
    return null;
  }
}

export class ActivityLog {
  private run: Run | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** When this log last recorded something (or was created). */
  lastUsed: number;

  /** `label` names the connected agent, e.g. "Claude Desktop (MCP)". */
  constructor(private ctx: ServerContext, private label: () => string) {
    this.lastUsed = ctx.clock();
  }

  /** Records one change (the server's own long-running tools log through this too). */
  push(op: NewOp) {
    const now = this.ctx.clock();
    this.lastUsed = now;
    this.run ??= { id: newId(now), source: 'external', label: this.label(), startedAt: now, status: 'running', ops: [] };
    this.run.ops.push({ ...op, id: newId(now), at: now } as Op);
    this.run.endedAt = now;
    const snapshot = JSON.stringify(this.run, null, 1);
    const path = `ai/activity/${this.run.id}.json`;
    this.saving = this.saving.then(() => this.ctx.fs.writeText(path, snapshot)).catch(() => {});
  }

  /** Waits for pending log writes (tests, shutdown). */
  flush(): Promise<void> { return this.saving; }

  /** Runs a write tool and logs what it changed. Failed calls log nothing. */
  async record(tool: string, args: Record<string, any>, call: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const noteId = typeof args.id === 'string' ? args.id : null;
    const before = noteId && tool !== 'create_note' && tool !== 'create_notebook' ? await readNoteFresh(this.ctx, noteId).catch(() => null) : null;
    const beforeTexts = new Map<string, Set<string>>();
    if (before && tool === 'append_to_note') {
      for (const p of before.note.pageIds) beforeTexts.set(p, new Set(((await this.ctx.vault.readPage(before.note.id, p)).texts ?? []).map((t) => t.id)));
    }
    const result = await call();
    if (result.isError) return result;
    try {
      await this.derive(tool, args, result, before?.note ?? null, beforeTexts);
    } catch {
      /* logging must never fail the tool call */
    }
    return result;
  }

  private async derive(tool: string, args: Record<string, any>, result: CallToolResult, before: NoteMeta | null, beforeTexts: Map<string, Set<string>>) {
    const j = resultJson(result);
    switch (tool) {
      case 'create_note':
        if (j?.created && j.id) this.push({ kind: 'note_created', tool, noteId: j.id, title: j.title ?? '', summary: `Created ${q(j.title ?? '')}` });
        return;
      case 'create_notebook':
        if (j?.created && j.notebook?.id) this.push({ kind: 'notebook_created', tool, notebookId: j.notebook.id, name: j.notebook.name, summary: `Created the notebook ${q(j.notebook.name)}` });
        return;
      case 'trash_note':
        if (before && before.trashedAt == null) this.push({ kind: 'note_trashed', tool, noteId: before.id, title: before.title, summary: `Moved ${q(before.title)} to Trash` });
        return;
      case 'update_note': {
        if (!before) return;
        const after = (await readNoteFresh(this.ctx, before.id))?.note;
        if (!after) return;
        const keys = Object.keys(args).map((k) => META_ARG[k]).filter((k): k is keyof MetaFields => !!k);
        const b: MetaFields = {};
        const a: MetaFields = {};
        for (const k of keys) {
          (b as Record<string, unknown>)[k] = fields(before)[k];
          (a as Record<string, unknown>)[k] = fields(after)[k];
        }
        this.push({ kind: 'meta_changed', tool, noteId: before.id, title: before.title, before: b, after: a, summary: `${q(before.title)}: ${describeMeta(b, a)}` });
        return;
      }
      case 'append_to_note': {
        if (!before) return;
        const after = (await readNoteFresh(this.ctx, before.id))?.note;
        if (!after) return;
        for (const pageId of after.pageIds) {
          const known = beforeTexts.get(pageId);
          const raw = await this.ctx.fs.readText(VaultLayout.pageInk(after.id, pageId));
          if (raw == null) continue;
          for (const t of (await this.ctx.vault.readPage(after.id, pageId)).texts ?? []) {
            if (known?.has(t.id)) continue;
            this.push({ kind: 'text_appended', tool, noteId: after.id, title: after.title, pageId, textId: t.id, text: t.text, ...(known ? {} : { addedPage: true }), summary: `Added “${clip(t.text.replace(/\s+/g, ' '), 70)}” to ${q(after.title)}` });
          }
        }
        return;
      }
    }
  }
}

/**
 * One activity run per connected agent, across requests. Over stateless HTTP every request gets a
 * fresh MCP server, so without this each write would become its own run in the app's Activity
 * list. Writes from the same agent (same name and principal) within `idleMs` join one run.
 */
export class ActivitySessions {
  private logs = new Map<string, ActivityLog>();

  constructor(private ctx: ServerContext, private idleMs = 15 * 60_000) {}

  /** The log for `key` (agent + principal), labelled `label`. */
  get(key: string, label: string): ActivityLog {
    const now = this.ctx.clock();
    for (const [k, l] of this.logs) if (now - l.lastUsed > this.idleMs) this.logs.delete(k);
    let log = this.logs.get(key);
    if (!log) {
      log = new ActivityLog(this.ctx, () => label);
      this.logs.set(key, log);
    }
    return log;
  }

  /** Waits for every pending log write. */
  async flush(): Promise<void> {
    await Promise.all([...this.logs.values()].map((l) => l.flush()));
  }
}
