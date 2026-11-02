/**
 * "Explain this answer": AI text split into sentences; tap one to see where it came from — the
 * tag (Extracted / Inferred / Ambiguous, or "not from your notes"), how well its sources support
 * it, whether a source changed since (stale), each source with a picture of the ink or page region
 * and its words (or the moment in a recording), and who wrote it: model, provider, time, prompt id.
 */
import { useEffect, useMemo, useState } from 'react';
import { AudioLines, ExternalLink, RefreshCw } from 'lucide-react';
import {
  TAG_LABEL,
  anchorLink,
  claimFreshness,
  formatStamp,
  locateClaims,
  parseAnchor,
  stripMarkdown,
  type ClaimFreshness,
  type ProvClaim,
  type ProvenanceFile,
  type ProvenanceGen,
  type SourceAnchor,
} from '@inkstone/core';
import { pageImageForAI } from '../../lib/exporter.ts';
import { useApp } from '../../state/app.ts';
import { cx, relativeTime } from '../../ui/primitives.tsx';
import { allDocs, cachedDoc, hashLookup, recheckPage, useCompiler } from '../service.ts';

export interface ExplainSentence {
  text: string;
  claim: ProvClaim | null;
  gen: ProvenanceGen | null;
}

export interface ExplainPayload {
  title: string;
  sentences: ExplainSentence[];
  /** A compiled page: stale claims can be re-checked. */
  compiledNoteId?: string;
  /** Shown above the sentences (e.g. "Written by … on …"). */
  note?: string;
}

/** Sentences of a text box with their provenance (compiled pages, inserted answers, summaries). */
export function explainText(title: string, text: string, prov: ProvenanceFile | null, key: string, compiledNoteId?: string): ExplainPayload {
  const sentences = locateClaims(text, prov, key)
    .filter((s) => !/^#{1,6}\s/.test(s.text.trim()) && !/^Sources:/.test(s.text.trim()))
    .map((s) => ({ text: stripMarkdown(s.text), claim: s.claim, gen: s.gen }));
  return { title, sentences, ...(compiledNoteId ? { compiledNoteId } : {}) };
}

const TAG_CLASS = { E: 'is-extracted', I: 'is-inferred', A: 'is-ambiguous' } as const;

export function TagChip({ tag }: { tag: ProvClaim['t'] | null }) {
  return <span className={cx('cp-tag', tag ? TAG_CLASS[tag] : 'is-none')}>{tag ? TAG_LABEL[tag] : 'Not from your notes'}</span>;
}

export function ExplainView({ payload }: { payload: ExplainPayload }) {
  const [sel, setSel] = useState(() => Math.max(0, payload.sentences.findIndex((s) => s.claim)));
  const version = useCompiler((s) => s.version);
  const [, setLoaded] = useState(0);
  useEffect(() => { void allDocs().then(() => setLoaded((x) => x + 1)); }, []);
  const fresh = useMemo(() => payload.sentences.map((s) => (s.claim ? claimFreshness(s.claim, hashLookup) : 'fresh')), [payload, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = payload.sentences[sel];
  return (
    <div className="cp-explain">
      {payload.note && <p className="ag-note">{payload.note}</p>}
      <ol className="cp-sentences" aria-label="Sentences">
        {payload.sentences.map((s, i) => (
          <li key={i}>
            <button type="button" className={cx('cp-sentence', i === sel && 'is-on', fresh[i] !== 'fresh' && 'is-stale')} aria-pressed={i === sel} onClick={() => setSel(i)}>
              <span className={cx('cp-dot', s.claim ? TAG_CLASS[s.claim.t] : 'is-none')} aria-hidden />
              <span className="cp-sentence-text">{s.text}</span>
              {fresh[i] !== 'fresh' && <span className="cp-stale">{fresh[i] === 'missing' ? 'Source gone' : 'Stale'}</span>}
            </button>
          </li>
        ))}
      </ol>
      {current && <ClaimDetail sentence={current} freshness={fresh[sel] as ClaimFreshness} compiledNoteId={payload.compiledNoteId} />}
    </div>
  );
}

function ClaimDetail({ sentence, freshness, compiledNoteId }: { sentence: ExplainSentence; freshness: ClaimFreshness; compiledNoteId?: string }) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const c = sentence.claim;
  return (
    <section className="cp-detail" aria-label="Where this sentence comes from">
      <div className="cp-detail-head">
        <TagChip tag={c?.t ?? null} />
        {c?.c != null && <span className="ag-badge">Support {Math.round(c.c * 100)}%</span>}
        {freshness !== 'fresh' && <span className="cp-stale">{freshness === 'missing' ? 'A source note is gone' : 'A source changed since this was written'}</span>}
      </div>
      {!c && <p className="ag-note">Nothing in your notes supports this sentence: it comes from the model, or from your own edits.</p>}
      {c?.why && <p className="ag-note">{c.why}</p>}
      {c && c.src.length > 0 && (
        <ul className="cp-sources">
          {c.src.map((s) => { const a = parseAnchor(s); return a ? <SourceCard key={s} anchor={a} /> : null; })}
        </ul>
      )}
      {sentence.gen && (
        <dl className="cp-gen">
          <dt>Written by</dt><dd>{sentence.gen.by}</dd>
          {sentence.gen.provider && <><dt>Provider</dt><dd>{sentence.gen.provider === 'device' ? 'On this device' : sentence.gen.provider}</dd></>}
          {sentence.gen.model && <><dt>Model</dt><dd>{sentence.gen.model}</dd></>}
          <dt>When</dt><dd>{new Date(sentence.gen.at).toLocaleString()} ({relativeTime(sentence.gen.at)})</dd>
          <dt>Prompt</dt><dd><code>{sentence.gen.prompt}</code></dd>
        </dl>
      )}
      {compiledNoteId && freshness !== 'fresh' && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const p = await recheckPage(compiledNoteId);
            toast({ text: p ? 'Re-checked: a proposal is waiting in Compiled wiki' : 'Re-checked: nothing to change' });
          } catch (e) {
            toast({ text: (e as Error).message, tone: 'error' });
          } finally { setBusy(false); }
        }}><RefreshCw size={14} /> Re-check</button>
      )}
    </section>
  );
}

const thumbs = new Map<string, Promise<string | null>>();

/** A picture of the source region (ink as written, the PDF or typed text as shown), cached. */
function thumbnail(a: SourceAnchor): Promise<string | null> {
  const key = `${a.noteId}/${a.page}/${a.rect ? [a.rect.minX, a.rect.minY, a.rect.maxX, a.rect.maxY].join(',') : ''}`;
  let p = thumbs.get(key);
  if (!p) {
    p = (async () => {
      const v = useApp.getState().vault;
      if (!v) return null;
      const meta = await v.vault.readNote(a.noteId);
      if (!meta || meta.lock || meta.trashedAt != null) return null;
      const pages = await v.vault.readPages(meta);
      if (!pages[a.page]) return null;
      const img = await pageImageForAI(v, meta, pages, a.page, a.rect);
      return `data:${img.mediaType};base64,${img.base64}`;
    })().catch(() => null);
    thumbs.set(key, p);
  }
  return p;
}

export function SourceCard({ anchor }: { anchor: SourceAnchor }) {
  const notes = useApp((s) => s.notes);
  const meta = notes.find((n) => n.id === anchor.noteId);
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => { let alive = true; void thumbnail(anchor).then((u) => { if (alive) setImg(u); }); return () => { alive = false; }; }, [anchor]);
  const unit = cachedDoc(anchor.noteId)?.units.find((u) => u.hash === anchor.h);
  const kind = unit?.kind === 'handwriting' ? 'Handwriting' : unit?.kind === 'pdf' ? 'PDF' : unit?.kind === 'speech' ? 'Said' : unit ? 'Typed' : null;
  return (
    <li className="cp-source">
      {img ? <img className="cp-thumb" src={img} alt={`Page ${anchor.page + 1} of ${meta?.title ?? 'a note'}`} /> : <div className="cp-thumb is-empty" aria-hidden />}
      <div className="cp-source-text">
        <span className="cp-source-title">{meta?.title || 'A note no longer here'} · page {anchor.page + 1}{kind ? ` · ${kind}` : ''}</span>
        {unit ? <q>{stripMarkdown(unit.text)}</q> : <span className="muted small">This sentence changed or was erased since.</span>}
        {anchor.clip && <span className="cp-said"><AudioLines size={13} /> at {formatStamp(anchor.ms ?? 0)} in the recording</span>}
      </div>
      {meta && <a className="btn btn-sm btn-ghost cp-open" href={anchorLink(anchor)}><ExternalLink size={14} /> Open</a>}
    </li>
  );
}
