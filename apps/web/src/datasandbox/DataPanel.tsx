import { useEffect, useRef, useState } from 'react';
import { BarChart3, Copy, Play, Sparkles, Table2 } from 'lucide-react';
import { create } from 'zustand';
import { inferChart, describeValue, type Dataset, type NoteDocument, type QueryAttempt, type SqlResult } from '@inkstone/core';
import type { InkEngine } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { Dialog, cx } from '../ui/primitives.tsx';
import { isMac, isIOS } from '../platform/env.ts';
import { askData, engineFor, invalidateEngine, placeChart, placeResultTable, readQueryLog, runUserSql, type QueryLogEntry } from './data.ts';

/**
 * The data sandbox panel: the note's tables, a SQL editor (read-only queries; ⌘/Ctrl-Enter runs),
 * "Ask in words" through the AI repair loop (each attempt shown), results with "Put on page" as a
 * table and "Chart on page" as an image, and the query history from the note's log.
 */

interface PanelState { open: boolean; doc: NoteDocument | null; engine: InkEngine | null; vault: AppVault | null }
export const useDataPanel = create<PanelState>(() => ({ open: false, doc: null, engine: null, vault: null }));
export function openDataPanel(vault: AppVault, doc: NoteDocument, engine: InkEngine | null) {
  useDataPanel.setState({ open: true, vault, doc, engine });
}

export function DataPanelHost() {
  const s = useDataPanel();
  if (!s.open || !s.vault || !s.doc) return null;
  return <DataPanel vault={s.vault} doc={s.doc} engine={s.engine} onClose={() => useDataPanel.setState({ open: false })} />;
}

function DataPanel({ vault, doc, engine, onClose }: { vault: AppVault; doc: NoteDocument; engine: InkEngine | null; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [engineName, setEngineName] = useState<string>('');
  const [fallback, setFallback] = useState<string | undefined>();
  const [sql, setSql] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState<'' | 'run' | 'ask'>('');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<QueryAttempt[]>([]);
  const [history, setHistory] = useState<QueryLogEntry[]>([]);
  const sqlRef = useRef<HTMLTextAreaElement>(null);

  const refresh = async () => {
    invalidateEngine();
    try {
      const r = await engineFor(vault, doc.meta.id);
      setDatasets(r.datasets);
      setEngineName(r.engine.name);
      setFallback(r.fallbackReason);
      if (!sql && r.datasets[0]) setSql(`SELECT * FROM ${r.datasets[0].name} LIMIT 20`);
    } catch (e) {
      setDatasets([]);
      setError((e as Error).message);
    }
    setHistory((await readQueryLog(vault, doc.meta.id)).slice(-12).reverse());
  };
  useEffect(() => { void refresh(); }, [doc.meta.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!sql.trim() || busy) return;
    setBusy('run'); setError(null); setAttempts([]);
    try {
      const out = await runUserSql(vault, doc.meta.id, sql);
      if (out.ok) setResult(out.result!); else { setResult(null); setError(out.error ?? 'Query failed'); }
      setAttempts(out.attempts);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); setHistory((await readQueryLog(vault, doc.meta.id)).slice(-12).reverse()); }
  };

  const ask = async () => {
    if (!question.trim() || busy) return;
    setBusy('ask'); setError(null); setAttempts([]);
    try {
      const out = await askData({ vault, doc, question, by: 'you' });
      setAttempts(out.attempts);
      if (out.sql) setSql(out.sql);
      if (out.ok) setResult(out.result!); else { setResult(null); setError(`No working query after ${out.attempts.length} ${out.attempts.length === 1 ? 'try' : 'tries'}: ${out.error}`); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); setHistory((await readQueryLog(vault, doc.meta.id)).slice(-12).reverse()); }
  };

  const where = () => {
    const i = engine?.currentPageIndex ?? 0;
    const c = engine?.visibleCenter(i) ?? { x: 120, y: 160 };
    return { pageIndex: i, at: { x: Math.max(40, c.x - 160), y: Math.max(40, c.y - 80) } };
  };
  const chart = result ? inferChart(result) : null;
  const mod = isMac || isIOS ? '⌘' : 'Ctrl';

  return (
    <Dialog open title="Data" wide onClose={onClose} actions={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="ia-data">
        <section aria-label="Tables" className="ia-data-tables">
          {datasets == null ? <p className="ia-muted">Loading…</p> : datasets.length === 0 ? (
            <p className="ia-muted">No data on this note yet. Drop a CSV, JSON or spreadsheet file on the page, or use ••• › Add data.</p>
          ) : (
            <ul className="ia-chips">
              {datasets.map((d) => (
                <li key={d.name}>
                  <button type="button" className="chip" onClick={() => setSql(`SELECT * FROM ${d.name} LIMIT 20`)} title={d.columns.map((c) => `${c.name} (${c.type})`).join(', ')}>
                    <Table2 size={14} aria-hidden /> {d.name} <span className="ia-muted">{d.rows.length} rows</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {engineName && <p className="ia-note">Runs on this device in {engineName}{fallback ? ` (DuckDB could not start: ${fallback})` : ''}. Nothing is uploaded.</p>}
        </section>
        <label className="ia-field">
          <span className="field-label">SQL</span>
          <textarea ref={sqlRef} className="ia-sql" value={sql} spellCheck={false} rows={4} onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => { if ((isMac || isIOS ? e.metaKey : e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }} aria-describedby="ia-sql-hint" />
          <span id="ia-sql-hint" className="ia-muted">{mod}-Enter runs. Queries only read; nothing can change your data.</span>
        </label>
        <div className="ia-row">
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={!!busy || !sql.trim()}><Play size={15} aria-hidden /> {busy === 'run' ? 'Running…' : 'Run'}</button>
          <form className="ia-ask" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask in words, e.g. total by region" aria-label="Ask about the data in words" />
            <button type="submit" className="btn" disabled={!!busy || !question.trim()}><Sparkles size={15} aria-hidden /> {busy === 'ask' ? 'Asking…' : 'Ask'}</button>
          </form>
        </div>
        {attempts.length > 0 && (
          <details className="ia-attempts" open={attempts.some((a) => !a.ok)}>
            <summary>{attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'}{attempts.some((a) => !a.ok) && attempts[attempts.length - 1]!.ok ? ' (fixed after an error)' : ''}</summary>
            <ol>{attempts.map((a, i) => <li key={i} className={cx(!a.ok && 'is-error')}><code>{a.sql}</code>{a.ok ? <span> — {a.rowCount} rows, {a.ms} ms</span> : <span> — {a.error}</span>}</li>)}</ol>
          </details>
        )}
        {error && <p className="ia-error" role="alert">{error}</p>}
        {result && (
          <section aria-label="Result" className="ia-result">
            <div className="ia-row">
              <span className="ia-muted" role="status">{result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'}</span>
              <span className="ia-spacer" />
              <button type="button" className="btn btn-sm" onClick={() => { const w = where(); placeResultTable(doc, w.pageIndex, result, w.at, sql); toast({ text: 'Table added to the page', action: { label: 'Undo', run: () => (engine ? engine.undo() : doc.undo()) } }); }}><Table2 size={14} aria-hidden /> Put on page</button>
              {chart && <button type="button" className="btn btn-sm" onClick={() => { const w = where(); void placeChart(vault, doc, w.pageIndex, chart, result, w.at).then(() => toast({ text: 'Chart added to the page', action: { label: 'Undo', run: () => (engine ? engine.undo() : doc.undo()) } })); }}><BarChart3 size={14} aria-hidden /> Chart on page</button>}
              <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(describeValue({ kind: 'table', columns: result.columns, rows: result.rows }, 500)).then(() => toast({ text: 'Copied as Markdown' }))}><Copy size={14} aria-hidden /> Copy</button>
            </div>
            <div className="ia-grid-wrap" tabIndex={0} aria-label="Result rows">
              <table className="ia-grid">
                <thead><tr>{result.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                <tbody>{result.rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'is-num' : undefined}>{v == null ? '' : String(v)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </section>
        )}
        {history.length > 0 && (
          <details className="ia-history">
            <summary>Query history</summary>
            <ul>{history.map((h, i) => {
              const last = h.attempts[h.attempts.length - 1];
              return <li key={i}><button type="button" className="ia-link" onClick={() => last && setSql(last.sql)}>{h.question ? `“${h.question}” → ` : ''}<code>{last?.sql}</code></button> <span className="ia-muted">{h.by === 'assistant' ? 'assistant, ' : ''}{h.attempts.length} {h.attempts.length === 1 ? 'try' : 'tries'}{h.ok ? '' : ', failed'}</span></li>;
            })}</ul>
          </details>
        )}
      </div>
    </Dialog>
  );
}
