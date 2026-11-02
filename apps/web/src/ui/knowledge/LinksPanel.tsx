import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, FilePlus2, Hash, Link2, PenLine, Sparkles, X } from 'lucide-react';
import type { Mention, NoteDocument } from '@inkwright/core';
import { useApp } from '../../state/app.ts';
import { followLink, linkMention } from '../../lib/knowledge.ts';
import { hasSemanticProvider, onRelatedProviderChange, relatedNotesProvider } from '../../lib/related.ts';
import { IconButton, cx } from '../primitives.tsx';

const sourceName = { text: '', handwriting: 'handwriting', ink: 'linked ink' } as const;

/**
 * The note's place in the web of notes: notes that link here (with the line that does), notes
 * that mention its title without linking (one tap to link), the links it makes, related notes and
 * its tags. Shares the side-panel slot with Pages and the assistant.
 */
export function LinksPanel({ doc, onClose }: { doc: NoteDocument; onClose: () => void }) {
  const { vault, notes, notebooks, navigate, toast, setFilter } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [related, setRelated] = useState<{ id: string; score: number }[] | null>(null);
  const [providerTick, setProviderTick] = useState(0);
  const id = doc.meta.id;
  const k = vault?.knowledge;
  const version = k?.version ?? 0;

  const data = useMemo(() => {
    if (!k) return null;
    return {
      backlinks: k.backlinks(id, notebooks),
      mentions: k.unlinkedMentions(id),
      outgoing: k.outgoing(id, notebooks),
      tags: k.tagsOf(id).length ? k.tagsOf(id) : doc.meta.tags,
    };
  }, [k, id, notes, notebooks, version, doc.meta.title]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onRelatedProviderChange(() => setProviderTick((x) => x + 1)), []);
  useEffect(() => {
    let alive = true;
    const p = relatedNotesProvider();
    if (!p) return;
    void p.relatedNotes(id, { limit: 6 }).then((r) => alive && setRelated(r), () => alive && setRelated([]));
    return () => { alive = false; };
  }, [id, version, providerTick]);

  const open = (noteId: string, page?: number) => navigate({ name: 'editor', noteId, page });
  const linkIt = async (m: Mention, key: string) => {
    setBusy(key);
    try {
      const ok = await linkMention(m, doc.meta);
      toast(ok ? { text: `Linked in “${m.title}”`, tone: 'success' } : { text: 'Couldn’t find those words in the handwriting. Lasso them and choose Link.', tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const outgoing = (data?.outgoing ?? []).filter((o, i, all) => all.findIndex((x) => (x.note?.id ?? x.occ.title.toLowerCase()) === (o.note?.id ?? o.occ.title.toLowerCase())) === i && o.note?.id !== id);
  // Related: notes not already connected by a link either way.
  const linked = new Set([...(data?.backlinks ?? []).map((b) => b.noteId), ...outgoing.map((o) => o.note?.id).filter(Boolean)]);
  const relatedNotes = (related ?? []).map((r) => ({ ...r, note: notes.find((n) => n.id === r.id) })).filter((r) => r.note && r.score > 0.05 && !linked.has(r.id)).slice(0, 5);

  return (
    <aside className="side-panel links-panel" aria-label="Links">
      <header className="side-head">
        <h2><Link2 size={16} /> Links</h2>
        <IconButton label="Close links" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="links-scroll">
        <section className="links-sec" aria-label="Linked here">
          <h3 className="links-h">Linked here <span className="links-count">{data?.backlinks.length ?? 0}</span></h3>
          {!data?.backlinks.length && <p className="links-empty">No notes link here yet. Type [[{doc.meta.title}]] in another note, or lasso handwriting and choose Link.</p>}
          <ul className="links-list">
            {data?.backlinks.map((b, i) => (
              <li key={`${b.noteId}-${i}`}>
                <button type="button" className="link-row" onClick={() => open(b.noteId, b.pageIndex)}>
                  <span className="link-row-title">{b.title}</span>
                  {b.snippet && <span className="link-row-snippet">{b.snippet}</span>}
                  <span className="link-row-meta">Page {b.pageIndex + 1}{sourceName[b.source] ? ` · ${sourceName[b.source]}` : ''}{b.targetPage ? ` · to page ${b.targetPage}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="links-sec" aria-label="Unlinked mentions">
          <h3 className="links-h">Mentions <span className="links-count">{data?.mentions.length ?? 0}</span></h3>
          {!data?.mentions.length && <p className="links-empty">Notes that name “{doc.meta.title}” without linking it show up here.</p>}
          <ul className="links-list">
            {data?.mentions.map((m, i) => {
              const key = `${m.noteId}-${m.pageIndex}-${m.boxId ?? 'hw'}-${i}`;
              return (
                <li key={key} className="mention-row">
                  <button type="button" className="link-row" onClick={() => open(m.noteId, m.pageIndex)}>
                    <span className="link-row-title">{m.title}</span>
                    <span className="link-row-snippet">{m.snippet}</span>
                    <span className="link-row-meta">Page {m.pageIndex + 1}{m.source === 'handwriting' ? ' · handwriting' : ''}</span>
                  </button>
                  <button type="button" className="btn btn-sm mention-link" disabled={busy === key} onClick={() => void linkIt(m, key)} aria-label={`Link the mention in ${m.title}`}>
                    {m.source === 'handwriting' ? <PenLine size={14} /> : <Link2 size={14} />} Link
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="links-sec" aria-label="Links from this note">
          <h3 className="links-h">Links from this note <span className="links-count">{outgoing.length}</span></h3>
          {!outgoing.length && <p className="links-empty">Type [[ in a text box to link another note.</p>}
          <ul className="links-chips">
            {outgoing.map((o, i) => (
              <li key={i}>
                <button type="button" className={cx('link-chip', !o.note && 'is-missing')} onClick={() => void followLink(o.occ.target, { from: doc.meta, noteId: o.occ.noteId })}
                  title={o.note ? `Open “${o.note.title}”` : `Create “${o.occ.title}”`}>
                  {o.note ? <ArrowUpRight size={13} /> : <FilePlus2 size={13} />}
                  <span>{o.note?.title ?? o.occ.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {relatedNotes.length > 0 && (
          <section className="links-sec" aria-label="Related notes">
            <h3 className="links-h"><Sparkles size={13} /> Related {hasSemanticProvider() ? 'by meaning' : 'by keywords'}</h3>
            <ul className="links-list">
              {relatedNotes.map((r) => (
                <li key={r.id}>
                  <button type="button" className="link-row is-compact" onClick={() => open(r.id)}>
                    <span className="link-row-title">{r.note!.title}</span>
                    <span className="related-bar" aria-hidden><span style={{ width: `${Math.round(Math.min(1, r.score) * 100)}%` }} /></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && data.tags.length > 0 && (
          <section className="links-sec" aria-label="Tags">
            <h3 className="links-h">Tags</h3>
            <ul className="links-chips">
              {data.tags.map((t) => (
                <li key={t}>
                  <button type="button" className="link-chip" onClick={() => { setFilter({ kind: 'tag', tag: t }); navigate({ name: 'library' }); }}><Hash size={12} /><span>{t}</span></button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
