import { useEffect, useMemo, useState } from 'react';
import { Code2, ExternalLink } from 'lucide-react';
import {
  formatReceipt, layoutDiagram, markCodeRefReviewed, parseDiagramInput, searchSymbols, validateDiagram,
  type CodeSymbol, type DiagramIR, type DriftItem, type RepairReceipt,
} from '@inkwright/core';
import { codeRefResolver } from '@inkwright/ai';
import { noteChanged } from '../lib/actions.ts';
import { activeSession } from '../lib/session.ts';
import { useApp } from '../state/app.ts';
import { Dialog, cx } from '../ui/primitives.tsx';
import { allDrift, useDev } from './store.ts';
import { SymbolCard, driftWord } from './SymbolCard.tsx';

// ---- Pick a code symbol -------------------------------------------------------------------------

/** Search the mounted code and pick a symbol (binding lassoed ink to code). */
export function CodePickerDialog({ open, onPick, onClose }: { open: boolean; onPick: (s: CodeSymbol) => void; onClose: () => void }) {
  const graphs = useDev((s) => s.graphs);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  useEffect(() => { if (open) { setQ(''); setActive(0); } }, [open]);
  const hits = useMemo(() => searchSymbols(graphs, q, { limit: 12 }).map((h) => h.symbol), [graphs, q]);
  return (
    <Dialog open={open} title="Link to code" onClose={onClose}>
      {!graphs.length ? <p className="muted">Add a code source first (Settings › Developer).</p> : (
        <div className="dev-picker">
          <input autoFocus className="input" placeholder="Function, class, route…" value={q} aria-label="Search code"
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              if (e.key === 'Enter' && hits[active]) onPick(hits[active]!);
            }} />
          <ul className="dev-picker-list" role="listbox" aria-label="Symbols">
            {hits.map((s, i) => (
              <li key={s.id} role="option" aria-selected={i === active}>
                <button type="button" className={cx('dev-picker-item', i === active && 'is-on')} onMouseEnter={() => setActive(i)} onClick={() => onPick(s)}>
                  <Code2 size={14} /><span className="dev-picker-name">{s.qualified}</span><span className="muted small">{s.kind} · {s.file}</span>
                </button>
              </li>
            ))}
            {!hits.length && <li className="muted small">Nothing matches.</li>}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

// ---- Verified diagram -------------------------------------------------------------------------

export const EXAMPLE_DIAGRAM: DiagramIR = {
  title: 'Request path',
  nodes: [
    { id: 'web', label: 'Web app', kind: 'client' },
    { id: 'api', label: 'API', kind: 'service' },
    { id: 'db', label: 'Database', kind: 'database' },
  ],
  edges: [{ from: 'web', to: 'api', label: 'HTTPS' }, { from: 'api', to: 'db', kind: 'data' }],
};

/**
 * Write or paste a diagram's IR, check it, place it. The same validator the assistant's
 * create_diagram uses: "Place" stays off until the receipt is clean.
 */
export function DiagramDialog({ open, initial, onPlace, onClose }: { open: boolean; initial?: DiagramIR; onPlace: (ir: DiagramIR) => void; onClose: () => void }) {
  const graphs = useDev((s) => s.graphs);
  const [text, setText] = useState('');
  useEffect(() => { if (open) setText(JSON.stringify(initial ?? EXAMPLE_DIAGRAM, null, 2)); }, [open, initial]);
  const { receipt, ir } = useMemo((): { receipt: RepairReceipt; ir: unknown } => {
    const p = parseDiagramInput(text);
    if (p.error) return { ir: null, receipt: { ok: false, errors: [p.error], warnings: [], stats: { nodes: 0, edges: 0, groups: 0 } } };
    return { ir: p.ir, receipt: validateDiagram(p.ir, { resolveCode: codeRefResolver(graphs) }) };
  }, [text, graphs]);
  const scene = useMemo(() => (receipt.ok ? layoutDiagram(ir as DiagramIR) : null), [receipt, ir]);
  return (
    <Dialog open={open} title={initial ? 'Edit diagram' : 'Insert diagram'} onClose={onClose} wide
      actions={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!receipt.ok} onClick={() => onPlace(ir as DiagramIR)}>{initial ? 'Update' : 'Place on page'}</button>
      </>}>
      <p className="muted small">Nodes with kinds ({'service, database, queue, cache, storage, client, user, gateway, function, job, external'}), edges and groups. It is checked before it is placed.</p>
      <textarea className="dev-ir" value={text} spellCheck={false} aria-label="Diagram IR (JSON)" onChange={(e) => setText(e.target.value)} />
      <div className={cx('dev-receipt', receipt.ok ? 'is-ok' : 'is-bad')} role="status" aria-live="polite" data-testid="diagram-receipt">
        {receipt.ok ? <p>{formatReceipt(receipt)}</p> : (
          <ol>{receipt.errors.map((e, i) => <li key={i}><code>{e.path || '/'}</code> {e.message}{e.hint ? <span className="muted"> {e.hint}</span> : null}</li>)}</ol>
        )}
      </div>
      {scene && <p className="muted small">{scene.boxes.length} nodes, laid out {Math.round(scene.width)} × {Math.round(scene.height)}.</p>}
    </Dialog>
  );
}

// ---- Drift list ---------------------------------------------------------------------------------

/** Every drifted code link across the notes, with old vs new and "Mark reviewed". */
export function DriftDialog({ open, onClose, noteId }: { open: boolean; onClose: () => void; noteId?: string }) {
  const { navigate, toast } = useApp();
  const version = useDev((s) => s.version);
  const [items, setItems] = useState<DriftItem[] | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const reload = () => void allDrift().then((all) => setItems(noteId ? all.filter((d) => d.noteId === noteId) : all));
  useEffect(() => { if (open) { setItems(null); reload(); } }, [open, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const review = async (d: DriftItem) => {
    const session = activeSession();
    if (session?.doc.meta.id === d.noteId) session.doc.updateMeta((m) => markCodeRefReviewed(m, d, Date.now()));
    else {
      const v = useApp.getState().vault;
      await v?.vault.updateNote(d.noteId, (m) => markCodeRefReviewed(m, d, Date.now()));
      await noteChanged(d.noteId);
    }
    toast({ text: 'Marked reviewed', tone: 'success' });
    reload();
  };

  return (
    <Dialog open={open} title={noteId ? 'Code drift in this note' : 'Code drift'} onClose={onClose} wide>
      {items === null ? <p className="muted">Checking…</p> : !items.length ? (
        <p className="dev-empty">No drift. Every code link matches the code it was written against.</p>
      ) : (
        <ul className="dev-drift-list" aria-label="Drifted code links">
          {items.map((d) => {
            const k = `${d.noteId}|${d.key}`;
            return (
              <li key={k} className="dev-drift-item">
                <button type="button" className="dev-drift-row" aria-expanded={openKey === k} onClick={() => setOpenKey(openKey === k ? null : k)}>
                  <span className="dev-drift-badge">{driftWord(d.status)}</span>
                  <span className="dev-drift-key">{d.key}</span>
                  {!noteId && <span className="muted small">{d.title}</span>}
                </button>
                {openKey === k && (
                  <div className="dev-drift-detail">
                    <SymbolCard target={d.target} state={d} onReviewed={() => void review(d)} />
                    {!noteId && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onClose(); navigate({ name: 'editor', noteId: d.noteId, page: d.occurrences[0]?.pageIndex }); }}><ExternalLink size={14} /> Open note</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
