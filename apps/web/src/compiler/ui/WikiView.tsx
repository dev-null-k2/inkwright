/**
 * Compiled wiki: choose the sources, compile, and review what the compiler proposes — page by
 * page and claim by claim, each with its tag and sources — before anything changes. Accepted
 * changes are logged in AI activity (undo there). Compiled pages show their stale claims and
 * can be explained, studied or re-checked.
 */
import { useEffect, useMemo, useState } from 'react';
import { BookOpenCheck, Check, FileText, Globe, Loader2, Package, RefreshCw, Square, X } from 'lucide-react';
import { textItemKey, normalizeSentence, type ProvClaim } from '@inkstone/core';
import type { ProposalItem, WikiProposal } from '@inkstone/ai';
import { importText } from '../../lib/actions.ts';
import { openAgentView } from '../../lib/agent/hub.ts';
import { useApp } from '../../state/app.ts';
import { Segmented, Switch, cx, relativeTime } from '../../ui/primitives.tsx';
import { Section } from '../../ui/agent/shared.tsx';
import { cancelCompile, compileNow, compilerStore, compilerVault, decideProposal, recheckPage, setCompilerConfig, useCompiler } from '../service.ts';
import { deckFromCompiledPage } from '../study.ts';
import { readNoteProvenance } from '../target.ts';
import { openExplain, openPack, openReview } from './dialogs.tsx';
import { explainText, TagChip } from './Explain.tsx';

export function WikiView() {
  const s = useCompiler();
  const toast = useApp((x) => x.toast);
  const pending = s.proposals.filter((p) => p.status === 'pending');
  const compile = async () => {
    try {
      const p = await compileNow('Compile now');
      if (!p) toast({ text: useCompiler.getState().lastResult ?? 'Up to date' });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast({ text: (e as Error).message, tone: 'error' });
    }
  };
  return (
    <div className="ag-screen cp-wiki">
      <p className="ag-lead">Your notes, compiled into pages that keep themselves up to date. Every sentence says where it came from and whether it was quoted, inferred or is disputed. Nothing changes until you accept it.</p>
      <SourcesSection />
      <Section title="How it compiles">
        <Segmented label="Who writes the pages" value={s.config.ai} onChange={(v) => void setCompilerConfig({ ai: v })} options={[{ value: 'device', label: 'On this device' }, { value: 'active', label: 'My AI' }, { value: 'none', label: 'No AI (quotes)' }]} />
        <p className="ag-note">{s.config.ai === 'device' ? 'Uses an on-device model when one is installed (Settings › AI); without one, pages are made of quotes. Nothing leaves this device.' : s.config.ai === 'active' ? 'Uses the AI chosen in Settings › AI, which may be a cloud provider: the source sentences are sent to it.' : 'Pages quote your notes, grouped by topic. No model is used.'}</p>
        <Switch label="People pages" hint="Make a page for each person named in your notes and transcripts, with their action items and follow-ups. Off until you turn it on." checked={s.config.people} onChange={(v) => void setCompilerConfig({ people: v })} />
        <Switch label="Watch for contradictions" hint="Checks numbers, dates and decisions across all your notes in the background, on this device." checked={s.config.ledger} onChange={(v) => void setCompilerConfig({ ledger: v })} />
      </Section>
      <div className="cp-compile">
        {s.compiling ? (
          <>
            <span className="cp-progress"><Loader2 size={15} className="ag-spin" /> {s.compiling.total ? `Compiling ${s.compiling.done + 1} of ${s.compiling.total}${s.compiling.title ? `: ${s.compiling.title}` : ''}` : 'Reading your notes…'}</span>
            <button type="button" className="btn btn-sm" onClick={cancelCompile}><Square size={13} /> Stop</button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => void compile()}><RefreshCw size={15} /> Compile now</button>
        )}
        {!s.compiling && s.lastResult && <span className="muted small">{s.lastResult}</span>}
      </div>
      <p className="ag-note">To compile every night, add the “Compile my wiki” routine in <button type="button" className="linklike" onClick={() => openAgentView('routines')}>Routines</button>.</p>
      {pending.map((p) => <ProposalCard key={p.id} proposal={p} />)}
      <PagesSection />
      <Section title="Take it to an agent">
        <div className="ag-row-acts">
          <button type="button" className="btn btn-sm" onClick={() => openPack({ noteIds: s.pages.flatMap((p) => p.sourceNotes).filter((x, i, a) => a.indexOf(x) === i), title: 'My compiled wiki' })}><Package size={14} /> Context pack…</button>
        </div>
      </Section>
    </div>
  );
}

// ---- Sources --------------------------------------------------------------------------------------

function SourcesSection() {
  const config = useCompiler((s) => s.config);
  const notebooks = useApp((s) => s.notebooks);
  const notes = useApp((s) => s.notes);
  const toast = useApp((s) => s.toast);
  const tags = useMemo(() => [...new Set(notes.flatMap((n) => n.tags))].filter((t) => t !== 'compiled').sort(), [notes]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const src = config.sources;
  const set = (patch: Partial<typeof src>) => void setCompilerConfig({ sources: { ...src, ...patch } });
  const nbName = (id: string) => notebooks.find((n) => n.id === id)?.name ?? 'A notebook';
  const noteName = (id: string) => notes.find((n) => n.id === id)?.title ?? 'A note';
  const addUrl = async () => {
    setBusy(true);
    try {
      const id = await importUrl(url.trim());
      set({ notes: [...src.notes, id] });
      setUrl('');
      toast({ text: 'Added: the page’s text is a note in “Sources” now', tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };
  const empty = !src.notebooks.length && !src.tags.length && !src.notes.length;
  return (
    <Section title="Sources" note="Notebooks include their sections. Imported Markdown, PDFs (their text) and recordings (their transcripts) in these places are read too.">
      {empty && <p className="ag-empty">Nothing chosen yet. Pick a notebook or a tag to compile.</p>}
      <div className="cp-chips" aria-label="Chosen sources">
        {src.notebooks.map((id) => <Chip key={id} label={nbName(id)} kind="Notebook" onRemove={() => set({ notebooks: src.notebooks.filter((x) => x !== id) })} />)}
        {src.tags.map((t) => <Chip key={t} label={`#${t}`} kind="Tag" onRemove={() => set({ tags: src.tags.filter((x) => x !== t) })} />)}
        {src.notes.map((id) => <Chip key={id} label={noteName(id)} kind="Note" onRemove={() => set({ notes: src.notes.filter((x) => x !== id) })} />)}
      </div>
      <div className="cp-add-sources">
        <select aria-label="Add a notebook" value="" onChange={(e) => e.target.value && set({ notebooks: [...src.notebooks, e.target.value] })}>
          <option value="">Add a notebook…</option>
          {notebooks.filter((n) => !src.notebooks.includes(n.id) && n.id !== config.notebookId).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
        <select aria-label="Add a tag" value="" onChange={(e) => e.target.value && set({ tags: [...src.tags, e.target.value] })}>
          <option value="">Add a tag…</option>
          {tags.filter((t) => !src.tags.includes(t)).map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
      </div>
      <form className="ag-url-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void addUrl(); }}>
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (a web page to read as a source)" aria-label="Add a web page" />
        <button type="submit" className="btn btn-sm" disabled={!url.trim() || busy}><Globe size={14} /> Add</button>
      </form>
    </Section>
  );
}

function Chip({ label, kind, onRemove }: { label: string; kind: string; onRemove: () => void }) {
  return (
    <span className="cp-chip">
      <span className="muted small">{kind}</span> {label}
      <button type="button" className="icon-btn" aria-label={`Remove ${label}`} onClick={onRemove}><X size={13} /></button>
    </span>
  );
}

/**
 * A web page as a source: its readable text becomes a typed note in a "Sources" notebook (so it
 * gets anchors like any note). Pages that don't allow other sites to read them (no CORS) can't be
 * fetched from a browser app; the error says so and suggests pasting the text instead.
 */
async function importUrl(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('That isn’t a web address.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https pages can be added.');
  let res: Response;
  try {
    res = await fetch(u.href, { credentials: 'omit' });
  } catch {
    throw new Error(`${u.host} doesn’t let apps read its pages. Copy the text into a note instead and add that note.`);
  }
  if (!res.ok) throw new Error(`${u.host} answered ${res.status}.`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, form').forEach((n) => n.remove());
  const title = doc.querySelector('title')?.textContent?.trim() || u.host;
  const root = doc.querySelector('article, main') ?? doc.body;
  const blocks = [...root.querySelectorAll('h1, h2, h3, p, li, blockquote, pre')].map((n) => {
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/^H[1-3]$/.test(n.tagName)) return `${'#'.repeat(Number(n.tagName[1]))} ${t}`;
    return n.tagName === 'LI' ? `- ${t}` : t;
  }).filter(Boolean);
  const text = blocks.length ? blocks.join('\n\n') : (root.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('No readable text on that page.');
  const v = compilerVault();
  const nb = (await v.listNotebooks()).find((n) => n.name === 'Sources') ?? (await v.vault.createNotebook('Sources', '#FF5D6B7A'));
  return importText(`Source: ${u.href}\n\n${text}`.slice(0, 200_000), title, nb.id);
}

// ---- Proposals ----------------------------------------------------------------------------------------

const ACTION: Record<ProposalItem['action'], string> = { create: 'New page', update: 'Update', archive: 'Archive (sources gone)' };

function ProposalCard({ proposal }: { proposal: WikiProposal }) {
  const toast = useApp((s) => s.toast);
  const open = proposal.items.filter((i) => !i.decision);
  // Per item: which added/removed claims are ticked (all by default).
  const [ticks, setTicks] = useState<Record<string, { added: Set<string>; removed: Set<string> }>>(() => Object.fromEntries(proposal.items.map((i) => [i.id, { added: new Set(i.added.map((c) => normalizeSentence(c.s))), removed: new Set(i.removed.map((c) => normalizeSentence(c.s))) }])));
  const [busy, setBusy] = useState(false);
  const decide = async (items: ProposalItem[], accept: boolean) => {
    setBusy(true);
    try {
      const r = await decideProposal(proposal.id, Object.fromEntries(items.map((i) => [i.id, { accept, ...(accept ? ticks[i.id] : {}) }])));
      toast({ text: accept ? `Applied ${r.applied} ${r.applied === 1 ? 'change' : 'changes'}${r.problems.length ? ` · ${r.problems.join('; ')}` : ''}` : `Rejected ${r.rejected}`, ...(r.runId ? { action: { label: 'Review', run: () => openAgentView('activity') } } : {}) });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };
  return (
    <section className="cp-proposal" aria-label="Proposed changes">
      <div className="ag-section-head">
        <h3>{open.length} proposed {open.length === 1 ? 'change' : 'changes'} · {proposal.reason} · {relativeTime(proposal.createdAt)}</h3>
        <div className="ag-row-acts">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void decide(open, false)}>Reject all</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void decide(open, true)}>Accept all</button>
        </div>
      </div>
      <p className="ag-note">Written by {proposal.gen.by} · prompt <code>{proposal.gen.prompt}</code></p>
      <ul className="ag-list">
        {open.map((item) => (
          <li key={item.id} className="cp-item">
            <div className="cp-item-head">
              <span className="ag-item-title"><FileText size={14} /> {item.title}</span>
              <span className="ag-badge">{ACTION[item.action]}</span>
              <span className="muted small">{item.kind}</span>
              <div className="ag-row-acts">
                <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Reject ${item.title}`} onClick={() => void decide([item], false)}><X size={13} /> Reject</button>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} aria-label={`Accept ${item.title}`} onClick={() => void decide([item], true)}><Check size={13} /> Accept</button>
              </div>
            </div>
            {item.note && <p className="ag-note">{item.note}</p>}
            <ClaimList sign="+" claims={item.added} ticked={ticks[item.id]!.added} onTick={(k, on) => setTicks((t) => ({ ...t, [item.id]: { ...t[item.id]!, added: toggle(t[item.id]!.added, k, on) } }))} />
            <ClaimList sign="−" claims={item.removed} ticked={ticks[item.id]!.removed} onTick={(k, on) => setTicks((t) => ({ ...t, [item.id]: { ...t[item.id]!, removed: toggle(t[item.id]!.removed, k, on) } }))} />
            {item.kept.length > 0 && <p className="muted small">{item.kept.length} unchanged {item.kept.length === 1 ? 'claim' : 'claims'}</p>}
            {item.dropped.length > 0 && (
              <details className="cp-dropped">
                <summary>{item.dropped.length} {item.dropped.length === 1 ? 'sentence' : 'sentences'} the AI wrote were left out</summary>
                <ul>{item.dropped.map((d, k) => <li key={k}><q>{d.text}</q> — {d.reason}</li>)}</ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const toggle = (s: Set<string>, k: string, on: boolean) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; };

function ClaimList({ sign, claims, ticked, onTick }: { sign: '+' | '−'; claims: ProvClaim[]; ticked: Set<string>; onTick: (k: string, on: boolean) => void }) {
  if (!claims.length) return null;
  return (
    <ul className={cx('cp-claims', sign === '+' ? 'is-added' : 'is-removed')}>
      {claims.map((c) => {
        const k = normalizeSentence(c.s);
        return (
          <li key={k}>
            <label className="cp-claim">
              <input type="checkbox" checked={ticked.has(k)} onChange={(e) => onTick(k, e.target.checked)} aria-label={`${sign === '+' ? 'Add' : 'Remove'}: ${c.s}`} />
              <span className="cp-sign" aria-hidden>{sign}</span>
              <span className="cp-claim-text">{c.s}</span>
              <TagChip tag={c.t} />
              <span className="muted small">{c.src.length ? `${c.src.length} ${c.src.length === 1 ? 'source' : 'sources'}` : 'structure'}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

// ---- Compiled pages -----------------------------------------------------------------------------------

function PagesSection() {
  const pages = useCompiler((s) => s.pages);
  const stale = useCompiler((s) => s.stale);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [, force] = useState(0);
  useEffect(() => compilerStore().onChange(() => force((x) => x + 1)), []);
  if (!pages.length) return null;
  const explain = async (noteId: string, pageId: string, textId: string, title: string) => {
    const v = compilerVault();
    const page = (await v.vault.readPage(noteId, pageId).catch(() => null));
    const text = page?.texts?.find((t) => t.id === textId)?.text ?? '';
    openExplain(explainText(title, text, await readNoteProvenance(v, noteId), textItemKey(textId), noteId));
  };
  return (
    <Section title="Compiled pages">
      <ul className="ag-list">
        {[...pages].sort((a, b) => a.title.localeCompare(b.title)).map((p) => (
          <li key={p.key} className="ag-item cp-page">
            <div className="ag-item-main">
              <span className="ag-item-title">{p.title}{stale[p.noteId] ? <span className="cp-stale">{stale[p.noteId]} stale</span> : null}</span>
              <span className="muted small">{p.kind} · {p.sourceNotes.length} {p.sourceNotes.length === 1 ? 'source' : 'sources'} · compiled {relativeTime(p.at)}</span>
            </div>
            <div className="ag-row-acts">
              <button type="button" className="btn btn-sm" onClick={() => navigate({ name: 'editor', noteId: p.noteId })}>Open</button>
              <button type="button" className="btn btn-sm" onClick={() => void explain(p.noteId, p.pageId, p.textId, p.title)}>Explain</button>
              {p.kind !== 'index' && <button type="button" className="btn btn-sm" aria-label={`Study ${p.title}`} onClick={() => void deckFromCompiledPage(p.noteId).then((r) => { toast({ text: `${r.added} new ${r.added === 1 ? 'card' : 'cards'}`, action: { label: 'Review', run: () => openReview({ deckId: r.deck.id }) } }); }).catch((e) => toast({ text: (e as Error).message, tone: 'error' }))}><BookOpenCheck size={14} /></button>}
              {stale[p.noteId] ? <button type="button" className="btn btn-sm" onClick={() => void recheckPage(p.noteId).then((x) => toast({ text: x ? 'A proposal is waiting above' : 'Nothing to change' })).catch((e) => toast({ text: (e as Error).message, tone: 'error' }))}><RefreshCw size={14} /> Re-check</button> : null}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

