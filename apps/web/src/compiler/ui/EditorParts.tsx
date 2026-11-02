/**
 * The compiler in the editor, wired in like the studio tools (the editor only spreads
 * `menuItems` into its ••• menu and renders `parts`):
 * - quiet conflict badges beside sentences that disagree with another note (tap for both sides),
 *   and a small badge on compiled pages with stale claims;
 * - ••• › "Sources of AI text": every AI-written sentence on the note (compiled text, inserted
 *   answers, the summary, solved maths) with its sources — "Explain";
 * - ••• › Study this note (or the lasso selection), Teach me back, Context pack.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpenCheck, GraduationCap, Package, Quote, Scale } from 'lucide-react';
import {
  UNHASHED,
  boundsOfStrokes,
  formatAnchor,
  locateClaims,
  rectIsEmpty,
  stripMarkdown,
  textItemKey,
  type NoteDocument,
  type ProvClaim,
  type ProvenanceFile,
  type Rect,
} from '@inkstone/core';
import type { InkEngine } from '../../canvas/engine.ts';
import { useApp } from '../../state/app.ts';
import { Popover } from '../../ui/primitives.tsx';
import { allDocs, conflictsInNote, unitById, useCompiler } from '../service.ts';
import { deckFromNote, deckFromSelection } from '../study.ts';
import { onProvenanceChange, readNoteProvenance } from '../target.ts';
import { openExplain, openPack, openReview, openTutor } from './dialogs.tsx';
import type { ExplainSentence } from './Explain.tsx';
import { ConflictRow } from './LedgerView.tsx';

interface MenuItem { label: string; icon?: ReactNode; onClick: () => void; hint?: string }

export function useCompilerEditor({ doc, engine, host, view }: { doc: NoteDocument | null; engine: InkEngine | null; host: HTMLElement | null; view: unknown }): { menuItems: MenuItem[]; parts: ReactNode } {
  const toast = useApp((s) => s.toast);
  const vault = useApp((s) => s.vault);
  const conflicts = useCompiler((s) => s.conflicts);
  const stale = useCompiler((s) => s.stale);
  const pages = useCompiler((s) => s.pages);
  const [prov, setProv] = useState<ProvenanceFile | null>(null);
  const noteId = doc?.meta.id;
  useEffect(() => {
    if (!noteId || !vault) return;
    let alive = true;
    const load = () => void readNoteProvenance(vault, noteId).then((p) => { if (alive) setProv(p); });
    load();
    const off = onProvenanceChange((id) => { if (id === noteId) load(); });
    return () => { alive = false; off(); };
  }, [noteId, vault]);
  // Extraction of this note must exist for badge positions.
  useEffect(() => { void allDocs(); }, [noteId]);

  const explainNote = () => {
    if (!doc) return;
    const sentences: ExplainSentence[] = [];
    for (const page of doc.pages) {
      for (const t of page.texts ?? []) {
        const key = textItemKey(t.id);
        if (!prov?.items[key] && t.origin !== 'ai') continue;
        for (const s of locateClaims(t.text, prov, key)) {
          if (/^#{1,6}\s/.test(s.text.trim()) || /^Sources:/.test(s.text.trim())) continue;
          sentences.push({ text: stripMarkdown(s.text), claim: s.claim, gen: s.gen });
        }
      }
    }
    if (doc.meta.summary) for (const s of locateClaims(doc.meta.summary, prov, 'summary')) sentences.push({ text: stripMarkdown(s.text), claim: s.claim, gen: s.gen });
    // Solved maths and AI-read results: their source is the ink they were read from.
    doc.pages.forEach((page, pageIndex) => {
      for (const o of page.objects ?? []) {
        if (o.type !== 'math' || !('result' in o) || !o.result) continue;
        const ids = new Set((o as { source?: string[] }).source ?? []);
        const r = boundsOfStrokes(page.strokes.filter((s) => ids.has(s.id)));
        const src = rectIsEmpty(r) ? [] : [formatAnchor({ noteId: doc.meta.id, page: pageIndex, rect: r, h: UNHASHED })];
        const claim: ProvClaim = { s: `${(o as { input?: string }).input ?? ''} → ${o.result}`, t: 'I', src };
        sentences.push({ text: claim.s, claim, gen: { by: o.origin === 'ai' ? 'The AI read the ink; the on-device solver checked it' : 'On-device solver (read on this device)', prompt: 'smart.solve/1', at: o.createdAt } });
      }
    });
    if (!sentences.length) { toast({ text: 'No AI-written text on this note.' }); return; }
    const compiled = pages.find((p) => p.noteId === doc.meta.id);
    openExplain({ title: doc.meta.title || 'This note', sentences, ...(compiled ? { compiledNoteId: compiled.noteId } : {}) });
  };

  const study = async () => {
    if (!doc || !engine) return;
    try {
      const items = engine.getSelectionItems();
      const r = items && (items.strokes.length || items.texts.length)
        ? await deckFromSelection(doc.meta.id, items.pageIndex, { strokeIds: items.strokes.map((s) => s.id), textIds: items.texts.map((t) => t.id), bounds: boundsOfStrokes(items.strokes) })
        : await deckFromNote(doc.meta.id);
      toast({ text: `${r.added} new ${r.added === 1 ? 'card' : 'cards'} in “${r.deck.title}”${r.byModel ? '' : ' (made by the rules: no AI)'}`, action: { label: 'Review', run: () => openReview({ deckId: r.deck.id }) } });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };

  const mine = useMemo(() => (noteId ? conflictsInNote(noteId, conflicts) : []), [noteId, conflicts]);
  const menuItems: MenuItem[] = doc ? [
    { label: 'Sources of AI text', icon: <Quote size={16} />, onClick: explainNote, ...(stale[doc.meta.id] ? { hint: `${stale[doc.meta.id]} stale` } : {}) },
    { label: 'Study this note', icon: <BookOpenCheck size={16} />, hint: 'Flashcards', onClick: () => void study() },
    { label: 'Teach me back', icon: <GraduationCap size={16} />, onClick: () => openTutor({ noteIds: [doc.meta.id], title: doc.meta.title || 'This note' }) },
    { label: 'Context pack', icon: <Package size={16} />, hint: 'For any agent', onClick: () => openPack({ noteIds: [doc.meta.id], title: doc.meta.title || 'Context pack' }) },
  ] : [];
  const parts = doc && engine && host ? <ConflictBadges doc={doc} engine={engine} host={host} view={view} mine={mine} stale={stale[doc.meta.id] ?? 0} onStale={explainNote} /> : null;
  return { menuItems, parts };
}

function ConflictBadges({ doc, engine, host, view, mine, stale, onStale }: { doc: NoteDocument; engine: InkEngine; host: HTMLElement; view: unknown; mine: ReturnType<typeof conflictsInNote>; stale: number; onStale: () => void }) {
  void view;
  const [open, setOpen] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  const box = host.getBoundingClientRect();
  const placed: Array<{ key: string; pageIndex: number; rect: Rect; item: (typeof mine)[number] }> = [];
  for (const m of mine) {
    const u = unitById(m.mine === 'a' ? m.conflict.a.unitId : m.conflict.b.unitId);
    if (u?.rect && u.pageIndex < doc.pageCount) placed.push({ key: `${m.conflict.id}:${m.mine}`, pageIndex: u.pageIndex, rect: u.rect, item: m });
  }
  const firstText = doc.pages[0]?.texts?.[0];
  return (
    <div className="cp-badges" role="group" aria-label="Notes about this page">
      {placed.map((p) => {
        const s = engine.pageRectToScreen(p.pageIndex, p.rect);
        if (s.y > box.height + 20 || s.y + s.h < -20) return null;
        return (
          <button key={p.key} ref={(el) => { if (el) anchors.current.set(p.key, el); }} type="button" className="cp-badge" style={{ left: Math.min(box.width - 26, s.x + s.w + 4), top: s.y + s.h / 2 - 11 }}
            aria-label="This disagrees with another note" title={p.item.conflict.reason} onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(p.key)}>
            <Scale size={12} />
          </button>
        );
      })}
      {stale > 0 && firstText && (() => {
        const s = engine.pageRectToScreen(0, { minX: firstText.x, minY: firstText.y, maxX: firstText.x + firstText.width, maxY: firstText.y + 20 });
        return <button type="button" className="cp-badge is-stale" style={{ left: Math.max(4, s.x + s.w - 90), top: Math.max(4, s.y - 26) }} onPointerDown={(e) => e.stopPropagation()} onClick={onStale}>{stale} stale</button>;
      })()}
      {placed.filter((p) => p.key === open).map((p) => (
        <Popover key={p.key} anchor={anchors.current.get(p.key) ?? null} open onClose={() => setOpen(null)} title="Disagrees with another note" className="cp-badge-pop">
          <ul className="ag-list"><ConflictRow c={p.item.conflict} /></ul>
        </Popover>
      ))}
    </div>
  );
}
