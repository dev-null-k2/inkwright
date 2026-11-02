import { describeDataset } from '@inkwright/core';
import type { AgentTool } from '@inkwright/ai';
import { activeSession } from '../lib/session.ts';
import { useApp } from '../state/app.ts';
import { aiCanSee } from '../lib/trust/state.ts';
import { askData, noteDatasets, resultForAgent } from './data.ts';

/**
 * The assistant's data tools. `query_data` runs read-only SQL over a note's datasets through the
 * repair loop: the agent's SQL (or a question in words) runs; an engine error goes back to the
 * model verbatim for a fix, at most three attempts; every attempt is logged in the note's
 * `data-queries.jsonl` and returned, so the agent sees what failed and why.
 */
async function noteFor(noteId?: string) {
  const open = activeSession()?.doc;
  const id = noteId ?? open?.meta.id;
  if (!id) throw new Error('Which note? Pass noteId (the open note is used by default).');
  if (!aiCanSee(id)) throw new Error('This note is not available to AI.');
  if (open && open.meta.id === id) return open;
  const vault = useApp.getState().vault;
  const meta = await vault?.vault.readNote(id);
  if (!meta) throw new Error(`No note with id "${id}"`);
  return { meta };
}

export function dataTools(): AgentTool[] {
  const list: AgentTool<{ noteId?: string }> = {
    name: 'list_datasets',
    description: 'List the data tables attached to a note (CSV/JSON/spreadsheets dropped on it): table names, typed columns, row counts and a few sample rows. Defaults to the open note.',
    parameters: { type: 'object', properties: { noteId: { type: 'string' } } },
    readOnly: true,
    async execute(a) {
      const vault = useApp.getState().vault!;
      const doc = await noteFor(a.noteId);
      const ds = await noteDatasets(vault, doc.meta.id);
      return { noteId: doc.meta.id, tables: ds.map(describeDataset) };
    },
  };
  const query: AgentTool<{ noteId?: string; question: string; sql?: string }> = {
    name: 'query_data',
    description: 'Answer a question about a note\'s data with read-only SQL (DuckDB, or SQLite when DuckDB is unavailable). Pass `sql` to run your own query; errors are sent back to you with the failed SQL to fix, at most 3 attempts in all. Without `sql`, the SQL is written for the `question`. Returns columns, up to 50 rows and every attempt.',
    parameters: { type: 'object', properties: { noteId: { type: 'string' }, question: { type: 'string' }, sql: { type: 'string' } }, required: ['question'] },
    readOnly: true,
    async execute(a, ctx) {
      const vault = useApp.getState().vault!;
      const doc = await noteFor(a.noteId);
      const out = await askData({ vault, doc, question: a.question, ...(a.sql ? { sql: a.sql } : {}), by: 'assistant', ...(ctx?.signal ? { signal: ctx.signal } : {}) });
      return {
        ok: out.ok,
        engine: out.engine,
        sql: out.sql,
        attempts: out.attempts.map((x) => ({ sql: x.sql, ok: x.ok, ...(x.error ? { error: x.error } : {}), ...(x.rowCount != null ? { rows: x.rowCount } : {}) })),
        ...(out.result ? { columns: out.result.columns, rowCount: out.result.rows.length, table: resultForAgent(out.result) } : { error: out.error }),
      };
    },
  };
  return [list as AgentTool, query as AgentTool];
}
