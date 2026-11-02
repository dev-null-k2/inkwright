import { useMemo, useRef, useState } from 'react';
import { Code2, Loader2, Play, X } from 'lucide-react';
import {
  boundsOfStrokes, codeRefKey, isCodeTarget, liveInkLinks, parseCodeTarget, parseRunbookBlocks, parseWikiTarget, rectIsEmpty,
  resultToMarkdown, type CodeRefState, type NoteDocument, type Rect, type RunbookBlock, type TextBox,
} from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import { layoutText, textLinkRects } from '../canvas/render.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { Popover, cx } from '../ui/primitives.tsx';
import { markReviewed } from './codeRefs.ts';
import { runBlock, type RunOutput } from './runbook.ts';
import { SymbolCard, driftWord } from './SymbolCard.tsx';

interface PlacedLink { key: string; refKey: string; pageIndex: number; rect: Rect; ink: boolean }
interface PlacedBlock { key: string; pageIndex: number; text: TextBox; block: RunbookBlock; top: number; bottom: number }

/**
 * The developer module's layer over the page: a small code mark after every code link (amber
 * with a word when it drifted; hover or tap shows the symbol, its source and old vs new), and a
 * "Run" button on every runnable block of typed text with its output under the block. Only these
 * small controls take input, so writing over the page works as usual.
 */
export function DevLayer({ doc, engine, host, vault, version, states, editingTextId }: {
  doc: NoteDocument;
  engine: InkEngine;
  host: HTMLElement;
  vault: AppVault;
  /** Changes whenever the view moves. */
  version: unknown;
  states: CodeRefState[];
  editingTextId?: string;
}) {
  const toast = useApp((s) => s.toast);
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  measure.current ??= typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  const [card, setCard] = useState<{ refKey: string; anchor: HTMLElement; pinned: boolean } | null>(null);
  const [outputs, setOutputs] = useState<Record<string, RunOutput | 'running'>>({});
  const hoverTimer = useRef(0);

  // Page-space positions, recomputed when the note changes (not when the view moves).
  const { links, blocks } = useMemo(() => {
    const links: PlacedLink[] = [];
    const blocks: PlacedBlock[] = [];
    const ctx = measure.current;
    doc.pages.forEach((p, pageIndex) => {
      for (const l of liveInkLinks(p)) {
        if (!isCodeTarget(l.target)) continue;
        const t = parseCodeTarget(l.target);
        const ids = new Set(l.strokeIds);
        const r = boundsOfStrokes(p.strokes.filter((s) => ids.has(s.id)));
        if (t && !rectIsEmpty(r)) links.push({ key: l.id, refKey: codeRefKey(t), pageIndex, rect: r, ink: true });
      }
      if (!ctx) return;
      for (const tb of p.texts ?? []) {
        if (tb.id === editingTextId) continue;
        if (tb.text.includes('[[')) {
          textLinkRects(ctx, tb).forEach((x, i) => {
            if (!isCodeTarget(x.target)) return;
            const w = parseWikiTarget(x.target);
            const t = parseCodeTarget(w.subpath ? `${w.title}#${w.subpath}` : w.title);
            if (t) links.push({ key: `${tb.id}:${i}`, refKey: codeRefKey(t), pageIndex, rect: x.rect, ink: false });
          });
        }
        const found = parseRunbookBlocks(tb.text);
        if (!found.length) continue;
        const lines = tb.text.split('\n');
        const heightUpTo = (n: number) => (n <= 0 ? 0 : layoutText(ctx, { ...tb, text: lines.slice(0, n).join('\n') }).height);
        found.forEach((b, i) => {
          const endLine = b.line + b.code.split('\n').length + 1;
          blocks.push({ key: `${tb.id}:${i}`, pageIndex, text: tb, block: b, top: tb.y + heightUpTo(b.line), bottom: tb.y + heightUpTo(Math.min(lines.length, endLine + 1)) });
        });
      }
    });
    return { links, blocks };
  }, [doc, doc.version, editingTextId]); // eslint-disable-line react-hooks/exhaustive-deps

  void version;
  const box = host.getBoundingClientRect();
  const visible = (s: { x: number; y: number; w: number; h: number }) => !(s.x > box.width + 40 || s.y > box.height + 40 || s.x + s.w < -40 || s.y + s.h < -40);
  const byKey = new Map(states.map((s) => [s.key, s]));
  const cardState = card ? byKey.get(card.refKey) : undefined;

  const run = async (b: PlacedBlock) => {
    setOutputs((o) => ({ ...o, [b.key]: 'running' }));
    const out = await runBlock(b.block, { vault, noteId: doc.meta.id, noteTitle: doc.meta.title });
    setOutputs((o) => {
      const next = { ...o };
      if (out) next[b.key] = out;
      else delete next[b.key];
      return next;
    });
  };

  return (
    <div className="dev-layer" role="group" aria-label="Code links and runbook blocks">
      {links.map((l) => {
        const s = engine.pageRectToScreen(l.pageIndex, l.rect);
        if (!visible(s)) return null;
        const st = byKey.get(l.refKey);
        const word = st ? driftWord(st.status) : null;
        const style = l.ink ? { left: s.x + s.w + 26, top: s.y + s.h / 2 - 10 } : { left: s.x + s.w + 9, top: s.y - 10 };
        return (
          <button key={l.key} type="button" className={cx('dev-code-chip', word && 'is-drift', st?.status === 'unresolved' && 'is-unresolved')} style={style}
            aria-label={`${word ? `${word}: ` : ''}code ${l.refKey}`} data-ref={l.refKey}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseEnter={(e) => { const el = e.currentTarget; clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setCard((c) => (c?.pinned ? c : { refKey: l.refKey, anchor: el, pinned: false })), 350); }}
            onMouseLeave={() => { clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setCard((c) => (c && !c.pinned ? null : c)), 300); }}
            onClick={(e) => setCard({ refKey: l.refKey, anchor: e.currentTarget, pinned: true })}>
            <Code2 size={11} strokeWidth={2.4} />{word && <span>{word}</span>}
          </button>
        );
      })}
      {blocks.map((b) => {
        if (b.text.id === editingTextId) return null;
        const s = engine.pageRectToScreen(b.pageIndex, { minX: b.text.x, minY: b.top, maxX: b.text.x + b.text.width, maxY: b.bottom });
        if (!visible(s)) return null;
        const out = outputs[b.key];
        return (
          <div key={b.key}>
            <button type="button" className="dev-run" style={{ left: s.x + s.w - 4, top: s.y }} disabled={out === 'running'}
              aria-label={`Run ${b.block.lang} block${b.block.name ? ` ${b.block.name}` : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => void run(b)}>
              {out === 'running' ? <Loader2 size={12} className="spin" /> : <Play size={12} />} {b.block.lang === 'http' ? 'Send' : 'Run'}
            </button>
            {out && out !== 'running' && (
              <RunOutputCard out={out} style={{ left: s.x, top: s.y + s.h + 4, width: Math.max(260, Math.min(560, s.w)) }}
                onClose={() => setOutputs((o) => { const n = { ...o }; delete n[b.key]; return n; })}
                onCopy={() => { if (out.sql) void navigator.clipboard?.writeText(resultToMarkdown(out.sql)).then(() => toast({ text: 'Result copied as a table' }), () => {}); }} />
            )}
          </div>
        );
      })}
      <Popover anchor={card?.anchor ?? null} open={!!card} onClose={() => setCard(null)} title="Code" placement="below" className="dev-symbol-pop">
        {card && (
          <div onMouseEnter={() => clearTimeout(hoverTimer.current)} onMouseLeave={() => { if (!card.pinned) setCard(null); }}>
            <SymbolCard target={parseCodeTarget(`code:${card.refKey}`) ?? { path: card.refKey }} state={cardState}
              onReviewed={cardState ? () => { markReviewed(doc, cardState); toast({ text: 'Marked reviewed', tone: 'success' }); setCard(null); } : undefined} />
          </div>
        )}
      </Popover>
    </div>
  );
}

function RunOutputCard({ out, style, onClose, onCopy }: { out: RunOutput; style: React.CSSProperties; onClose: () => void; onCopy: () => void }) {
  return (
    <div className={cx('dev-output', !out.ok && 'is-error')} style={style} role="region" aria-label="Run result" onPointerDown={(e) => e.stopPropagation()}>
      <div className="dev-output-head">
        {out.http ? <span className="dev-status">{out.http.status} {out.http.statusText}</span> : <span className="dev-status">{out.ok ? 'Done' : 'Failed'}</span>}
        <span className="muted small">{out.ms} ms</span>
        {out.sql && <button type="button" className="btn btn-sm btn-ghost" onClick={onCopy}>Copy as table</button>}
        <button type="button" className="icon-btn dev-output-close" aria-label="Close result" onClick={onClose}><X size={14} /></button>
      </div>
      {out.error && <p className="dev-output-error">{out.error}</p>}
      {out.http && (
        <>
          <details className="dev-headers"><summary>{out.http.headers.length} headers</summary>
            <dl>{out.http.headers.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          </details>
          <pre className="dev-body" tabIndex={0}>{out.http.body || '(empty body)'}{out.http.truncated ? `\n… ${out.http.truncated} more characters` : ''}</pre>
        </>
      )}
      {out.sql && (
        <div className="dev-table-wrap" tabIndex={0}>
          <table className="dev-table">
            <thead><tr>{out.sql.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{out.sql.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v == null ? '' : String(v)}</td>)}</tr>)}</tbody>
          </table>
          {out.sql.more > 0 && <p className="muted small">…and {out.sql.more} more rows</p>}
          {!out.sql.rows.length && <p className="muted small">No rows. Tables: {out.sql.tables.join(', ')}</p>}
        </div>
      )}
      {out.js && (out.js.logs.length > 0 || out.js.value !== undefined) && (
        <pre className="dev-body" tabIndex={0}>{[...out.js.logs, ...(out.js.value !== undefined ? [`→ ${out.js.value}`] : [])].join('\n')}</pre>
      )}
    </div>
  );
}
