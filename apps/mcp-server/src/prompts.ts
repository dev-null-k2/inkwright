import { z } from 'zod';
import type { GetPromptResult } from '@modelcontextprotocol/server';
import { requireId, type ServerContext } from './context.ts';
import { noteMarkdown, recentNotesMarkdown } from './tools.ts';

// Prompt arguments are always strings in MCP.

export const summarizeNoteArgs = { id: z.string().describe('Note id (from list_notes or search_notes).') };
export const dailyReviewArgs = { date: z.string().optional().describe('Day to review as YYYY-MM-DD (server local time). Default: today.') };
export const todosFromNotesArgs = {
  days: z.string().optional().describe('Look back this many days (default 7).'),
  notebook: z.string().optional().describe('Only this notebook (id or name).'),
};

const user = (text: string): GetPromptResult['messages'][number] => ({ role: 'user', content: { type: 'text', text } });

export async function summarizeNotePrompt(ctx: ServerContext, args: { id: string }): Promise<GetPromptResult> {
  const id = requireId(args.id.trim(), 'note id');
  await ctx.refresh();
  const { note, markdown } = await noteMarkdown(ctx, id);
  return {
    description: `Summarize "${note.title}"`,
    messages: [
      user(
        `Summarize my handwritten note "${note.title}" below in 3-6 bullet points, then list any action items, dates and open questions.\n` +
          `Recognized handwriting can contain OCR mistakes; fix obvious ones silently. If a page says its handwriting is not yet recognized, ` +
          `use the get_page_image tool (noteId ${note.id}) to look at it.\n` +
          `Finally, offer to save a one-sentence summary to the note with update_note (summary field).\n\n<note>\n${markdown}\n</note>`,
      ),
    ],
  };
}

function dayRange(date: string | undefined, now: number): { start: number; end: number; label: string } {
  let d: Date;
  if (date?.trim()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!m) throw new Error(`Invalid date "${date}"; use YYYY-MM-DD.`);
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    const n = new Date(now);
    d = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: d.getTime(), end: end.getTime(), label };
}

export async function dailyReviewPrompt(ctx: ServerContext, args: { date?: string }): Promise<GetPromptResult> {
  const { start, end, label } = dayRange(args.date, ctx.clock());
  const { count, markdown } = await recentNotesMarkdown(ctx, start, { until: end, limit: 50 });
  const body = count ? markdown : '_No notes were written or edited on this day._';
  return {
    description: `Daily review for ${label}`,
    messages: [
      user(
        `Here is everything I wrote in Inkwright on ${label} (${count} note${count === 1 ? '' : 's'}). Write my daily review:\n` +
          `1. Key points and decisions\n2. Action items (as a Markdown checklist, with the note each came from)\n3. Open questions and follow-ups\n4. Anything worth scheduling\n` +
          `Recognized handwriting may contain OCR errors. If a page is not yet recognized, look at it with get_page_image.\n` +
          `Offer to save the review as a new note with create_note (title "Daily review ${label}", tag "review").\n\n<notes>\n${body}\n</notes>`,
      ),
    ],
  };
}

export async function todosFromNotesPrompt(ctx: ServerContext, args: { days?: string; notebook?: string }): Promise<GetPromptResult> {
  const days = args.days?.trim() ? Number(args.days) : 7;
  if (!Number.isFinite(days) || days <= 0 || days > 366) throw new Error(`Invalid days "${args.days}"; use a number from 1 to 366.`);
  const since = ctx.clock() - days * 864e5;
  const { count, markdown } = await recentNotesMarkdown(ctx, since, { limit: 50, notebook: args.notebook?.trim() || undefined });
  const scope = args.notebook?.trim() ? ` in notebook "${args.notebook.trim()}"` : '';
  return {
    description: `To-dos from the last ${days} day(s)${scope}`,
    messages: [
      user(
        `Extract every to-do, task, commitment and follow-up from my notes of the last ${days} day(s)${scope} (${count} note${count === 1 ? '' : 's'}) below.\n` +
          `Return a Markdown checklist grouped by note title, with due dates and people when mentioned; mark items that look already done ` +
          `(crossed out, "done", ✓) as checked. Do not invent tasks. Recognized handwriting may contain OCR errors.\n` +
          `Offer to save the list as a note with create_note (tag "todo").\n\n<notes>\n${count ? markdown : '_No notes in this period._'}\n</notes>`,
      ),
    ],
  };
}
