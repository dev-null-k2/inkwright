/**
 * MCP tools over the store of originals (originals.ts) that the context-saving proxy shares:
 *
 * - `compress_and_store` — an agent hands over a large text (a log, a tool's output) and gets
 *   back a shortened version plus a handle, keeping the full text on this computer.
 * - `retrieve_original` — the full text (or only the parts mentioning a query) behind a handle,
 *   whether the proxy or `compress_and_store` made it. Clients that offer this tool to their model
 *   let the proxy shorten even streamed requests without touching the stream (docs/PROXY.md).
 *
 * Neither touches the vault; both work in read-only mode. `--no-context-tools` turns them off.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { ContextBudgeter, estimateTokens, RETRIEVE_TOOL_DEF } from '@inkwright/ai';
import type { ServerContext } from '../context.ts';
import { jsonResult, type ToolDef } from '../tools.ts';
import { DiskContentStore, defaultOriginalsDir } from './originals.ts';

const stores = new Map<string, DiskContentStore>();
function storeFor(ctx: ServerContext): DiskContentStore {
  const dir = ctx.features?.originalsDir ?? defaultOriginalsDir();
  let s = stores.get(dir);
  if (!s) stores.set(dir, (s = new DiskContentStore(dir)));
  return s;
}

export const compressShape = {
  text: z.string().min(1).max(20_000_000).describe('The large text to shorten: a log, a command or tool output, a file.'),
  query: z.string().max(2000).optional().describe('What you are looking for in it: matching items and passages are kept.'),
  min_tokens: z.number().int().min(50).max(100_000).optional().describe('Leave the text alone below this many (estimated) tokens (default: the AI policy’s, 600).'),
};

async function compressAndStore(ctx: ServerContext, a: { text: string; query?: string; min_tokens?: number }): Promise<CallToolResult> {
  await ctx.policy.refresh();
  const store = storeFor(ctx);
  const minTokens = a.min_tokens ?? ctx.policy.current.compression.minTokens;
  const b = new ContextBudgeter(store, { minTokens });
  const { messages, items } = await b.apply([{ role: 'tool', toolCallId: 'x', content: a.text }, { role: 'user', content: a.query ?? '' }], { canRetrieve: true, ...(a.query ? { query: a.query } : {}) });
  const ref = items[0]?.ref || (await store.put(a.text));
  const text = messages[0]!.content as string;
  return jsonResult({
    ref,
    shortened: text !== a.text,
    original_tokens: estimateTokens(a.text),
    tokens: estimateTokens(text),
    ...(items[0] ? { method: items[0].method } : {}),
    text: text !== a.text ? text : a.text,
    note: text !== a.text ? `Full text: retrieve_original with ref "${ref}".` : 'Too short to shorten; stored anyway, so the ref works.',
  });
}

export const retrieveShape = {
  ref: z.string().regex(/^"?[0-9a-f]{16}"?$/).describe('The ref from a shortened block.'),
  query: z.string().max(2000).optional().describe('Only the parts that mention these words.'),
};

async function retrieveOriginal(ctx: ServerContext, a: { ref: string; query?: string }): Promise<CallToolResult> {
  const r = await new ContextBudgeter(storeFor(ctx), { minTokens: 1e9 }).retrieve(a);
  return { content: [{ type: 'text', text: r.text }], ...(r.ok ? {} : { isError: true }) };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;

export const CONTEXT_TOOLS: ToolDef[] = [
  {
    name: 'compress_and_store',
    title: 'Compress and store',
    description: 'Shorten a large text (a log, a command or tool output) to the parts that matter for a query, keeping the full original on this computer. Returns the shortened text and a ref for retrieve_original. Lists keep matching items, logs keep errors with context, tables keep the header and matching rows.',
    inputSchema: compressShape,
    write: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Compress and store' },
    handler: (ctx, args) => compressAndStore(ctx, args as never),
  },
  {
    name: 'retrieve_original',
    title: 'Retrieve original',
    description: RETRIEVE_TOOL_DEF.description,
    inputSchema: retrieveShape,
    write: false,
    annotations: { ...READ, title: 'Retrieve original' },
    handler: (ctx, args) => retrieveOriginal(ctx, args as never),
  },
];
