import { CheckCircle2, CircleAlert, CircleDashed, Loader2, Play, RotateCw, Square, X } from 'lucide-react';
import { describeValue, isLocalOp, parseOp, type DagNode, type NodeRun, type NoteDocument } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { cancelCanvasRun, closeCanvasRun, keepResults, runCanvas, useCanvasRun } from './run.ts';

/**
 * The executable canvas overlay: the graph drawn over the sketch for confirmation (boxes outlined
 * in jade, arrows as read, so a wrong guess is visible before anything runs), a step card beside
 * each box with its status and output, and one quiet control bar.
 */
export function CanvasRunLayer({ doc, engine, vault, view }: { doc: NoteDocument; engine: InkEngine; vault: AppVault; view: unknown }) {
  void view; // re-render on pan/zoom
  const s = useCanvasRun();
  const toast = useApp((x) => x.toast);
  if (!s.graph || s.phase === 'idle') return s.phase === 'reading' ? <div className="ia-run-bar" role="status">Reading the diagram…</div> : null;
  const g = s.graph;
  const rect = (n: DagNode) => engine.pageRectToScreen(s.pageIndex, n.rect);
  const center = (n: DagNode) => { const r = rect(n); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const running = s.phase === 'running';
  const done = Object.values(s.runs).filter((r) => r.status === 'done').length;
  const fetches = g.nodes.filter((n) => parseOp(n.label).op === 'fetch').length;
  const agents = g.nodes.filter((n) => n.label && !isLocalOp(parseOp(n.label))).length;
  // Edge end points on the box borders, for clean arrows.
  const edgePoint = (n: DagNode, toward: { x: number; y: number }) => {
    const r = rect(n), c = center(n);
    const dx = toward.x - c.x, dy = toward.y - c.y;
    const k = Math.min(Math.abs((r.w / 2) / (dx || 1e-9)), Math.abs((r.h / 2) / (dy || 1e-9)));
    return { x: c.x + dx * k, y: c.y + dy * k };
  };
  return (
    <div className="ia-run" aria-label="Diagram">
      <svg className="ia-run-svg" aria-hidden>
        <defs>
          <marker id="ia-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="ia-run-head" /></marker>
        </defs>
        {g.nodes.map((n) => { const r = rect(n); return <rect key={n.id} x={r.x - 4} y={r.y - 4} width={r.w + 8} height={r.h + 8} rx={8} className={`ia-run-node is-${s.runs[n.id]?.status ?? 'idle'}`} />; })}
        {g.edges.map((e) => {
          const a = byId.get(e.from)!, b = byId.get(e.to)!;
          const p = edgePoint(a, center(b)), q = edgePoint(b, center(a));
          return <line key={e.id} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={`ia-run-edge${e.by === 'order' ? ' is-guess' : ''}`} markerEnd="url(#ia-arrow)" />;
        })}
      </svg>
      {g.nodes.map((n) => <StepCard key={n.id} node={n} run={s.runs[n.id]} at={rect(n)} canRerun={!running && s.phase === 'done'} onRerun={() => void runCanvas(doc, n.id)} />)}
      <div className="ia-run-bar" role="region" aria-label="Run the diagram">
        <span className="ia-run-summary" role="status">
          {g.cycles.length ? 'This diagram has a loop; break it to run.' : `${g.nodes.length} ${g.nodes.length === 1 ? 'step' : 'steps'}, ${g.edges.length} ${g.edges.length === 1 ? 'arrow' : 'arrows'}${agents ? ` · ${agents} by AI` : ''}${fetches ? ` · ${fetches} from the web` : ''}${s.phase === 'done' ? ` · ${done} done` : ''}`}
          {g.edges.some((e) => e.by === 'order') && !g.cycles.length ? ' · dashed arrows had no head; check their direction' : ''}
        </span>
        {s.error && <span className="ia-error" role="alert">{s.error}</span>}
        {running ? (
          <button type="button" className="btn btn-sm" onClick={cancelCanvasRun}><Square size={13} aria-hidden /> Cancel</button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" disabled={!!g.cycles.length} onClick={() => void runCanvas(doc)}><Play size={13} aria-hidden /> {s.phase === 'done' ? 'Run again' : 'Run'}</button>
        )}
        {s.phase === 'done' && done > 0 && (
          <button type="button" className="btn btn-sm" onClick={() => void keepResults(vault, doc).then((n) => { if (n) { toast({ text: `Kept ${n} ${n === 1 ? 'result' : 'results'} on the page`, action: { label: 'Undo', run: () => engine.undo() } }); closeCanvasRun(); } })}>Keep results on the page</button>
        )}
        <button type="button" className="icon-btn" aria-label="Close diagram" onClick={closeCanvasRun}><X size={16} /></button>
      </div>
    </div>
  );
}

function StepCard({ node, run, at, canRerun, onRerun }: { node: DagNode; run: NodeRun | undefined; at: { x: number; y: number; w: number; h: number }; canRerun: boolean; onRerun: () => void }) {
  const op = parseOp(node.label);
  const kind = !node.label ? 'no label' : op.op === 'agent' ? 'AI step' : op.op === 'const' ? 'value' : op.op === 'agg' ? op.fn : op.op;
  const status = run?.status;
  const Icon = status === 'running' ? Loader2 : status === 'done' ? CheckCircle2 : status === 'error' ? CircleAlert : CircleDashed;
  const preview = run?.output ? (run.output.kind === 'chart' ? `Chart of ${run.output.rows.length} rows` : describeValue(run.output, 4)) : '';
  const statusText = status === 'running' ? 'Running…' : status === 'done' ? `Done${run?.ms != null ? ` in ${run.ms < 1000 ? `${run.ms} ms` : `${(run.ms / 1000).toFixed(1)} s`}` : ''}` : status === 'error' ? 'Failed' : status === 'skipped' ? 'Skipped' : status === 'cancelled' ? 'Cancelled' : status === 'queued' ? 'Waiting' : 'Ready';
  return (
    <div className={`ia-step is-${status ?? 'idle'}`} style={{ left: at.x + at.w + 12, top: at.y }} role="group" aria-label={`Step: ${node.label || 'no label'}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="ia-step-head">
        <Icon size={14} aria-hidden className={status === 'running' ? 'ia-spin' : undefined} />
        <span className="ia-step-status">{statusText}</span>
        <span className="ia-step-kind">{kind}</span>
        {canRerun && <button type="button" className="icon-btn ia-step-rerun" aria-label={`Run “${node.label}” again`} title="Run this step again" onClick={onRerun}><RotateCw size={13} /></button>}
      </div>
      <div className="ia-step-label">{node.label || 'Write a label in this box'}</div>
      {run?.error && <div className="ia-step-error">{run.error}</div>}
      {preview && <pre className="ia-step-out">{preview}</pre>}
    </div>
  );
}
