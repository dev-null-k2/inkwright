import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerContext } from './context.ts';
import { dailyReviewArgs, dailyReviewPrompt, summarizeNoteArgs, summarizeNotePrompt, todosFromNotesArgs, todosFromNotesPrompt } from './prompts.ts';
import { NOTE_TEMPLATE, PAGE_SVG_TEMPLATE, listNoteResources, readNoteResource, readPageSvgResource } from './resources.ts';
import { TOOLS, type ToolDef } from './tools.ts';
import { VERSION } from './version.ts';

const INSTRUCTIONS = `Inkstone is the user's handwriting notebook app. This server reads and writes their notes vault (plain files synced across their devices).
- Find notes with search_notes (searches recognized handwriting too) or list_notes; read one with read_note.
- Handwriting that has not been recognized yet can be seen with get_page_image (PNG).
- "What did I write today?" -> get_recent_handwriting.
- Writes (create_note, append_to_note, update_note, create_notebook, trash_note) appear in the app on all devices. Never trash notes without the user's go-ahead; trash is reversible with restore_note.`;

/** Write tools available for this context (none in read-only mode). */
export function activeTools(ctx: ServerContext): ToolDef[] {
  return TOOLS.filter((t) => !t.write || !ctx.readOnly);
}

function errorResult(e: unknown): CallToolResult {
  const err = e as { issues?: Array<{ path: PropertyKey[]; message: string }>; message?: string };
  const msg = Array.isArray(err?.issues)
    ? 'Invalid arguments: ' + err.issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ')
    : String(err?.message ?? e);
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

/** An MCP server exposing the vault in `ctx`. One instance per connection/transport. */
export function createMcpServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: 'inkstone', title: 'Inkstone notes', version: VERSION },
    { instructions: INSTRUCTIONS + (ctx.readOnly ? '\nThis vault is mounted read-only: write tools are disabled.' : '') },
  );

  for (const tool of activeTools(ctx)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: unknown) => {
        try {
          return await tool.handler(ctx, args ?? {});
        } catch (e) {
          return errorResult(e);
        }
      },
    );
  }

  server.registerResource(
    'note',
    new ResourceTemplate(NOTE_TEMPLATE, { list: () => listNoteResources(ctx) }),
    { title: 'Inkstone note', description: 'A note as Markdown: front matter, typed text and recognized handwriting per page.', mimeType: 'text/markdown' },
    (_uri, vars) => readNoteResource(ctx, vars.id),
  );
  server.registerResource(
    'page-svg',
    new ResourceTemplate(PAGE_SVG_TEMPLATE, { list: undefined }),
    { title: 'Inkstone page (SVG)', description: 'One page of a note rendered as SVG (n is 1-based).', mimeType: 'image/svg+xml' },
    (_uri, vars) => readPageSvgResource(ctx, vars.id, vars.n),
  );

  server.registerPrompt(
    'summarize_note',
    { title: 'Summarize a note', description: 'Summarize one handwritten note and pull out action items.', argsSchema: summarizeNoteArgs },
    (args) => summarizeNotePrompt(ctx, args),
  );
  server.registerPrompt(
    'daily_review',
    { title: 'Daily review', description: 'Review everything written on a day (default today): key points, to-dos, open questions.', argsSchema: dailyReviewArgs },
    (args) => dailyReviewPrompt(ctx, args),
  );
  server.registerPrompt(
    'todos_from_notes',
    { title: 'To-dos from notes', description: 'Extract a to-do checklist from recent notes (default last 7 days), optionally one notebook.', argsSchema: todosFromNotesArgs },
    (args) => todosFromNotesPrompt(ctx, args),
  );

  return server;
}
