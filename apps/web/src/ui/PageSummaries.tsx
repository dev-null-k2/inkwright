import { useEffect, useState } from 'react';
import { FilePlus2, Sparkles } from 'lucide-react';
import type { NoteDocument, PageSummariesFile } from '@inkstone/core';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { onListenFilesChanged, readPageSummaries } from '../lib/listen/transcripts.ts';
import { addPageNote, summarizePages } from '../lib/listen/summaries.ts';
import { reindexTranscripts } from '../lib/listen/session.ts';

/** The note's page summaries, kept fresh when they are (re)written. */
export function usePageSummaries(vault: AppVault | undefined, noteId: string): PageSummariesFile | null {
  const [file, setFile] = useState<PageSummariesFile | null>(null);
  useEffect(() => {
    if (!vault) return;
    let alive = true;
    const load = () => void readPageSummaries(vault, noteId).then((f) => { if (alive) setFile(f); });
    load();
    const off = onListenFilesChanged((id) => { if (id === noteId) load(); });
    return () => { alive = false; off(); };
  }, [vault, noteId]);
  return file;
}

/** Under a page thumbnail in Pages: its summary, with "add to page". */
export function PageSummaryNote({ doc, pageIndex, summaries }: { doc: NoteDocument; pageIndex: number; summaries: PageSummariesFile | null }) {
  const page = doc.pages[pageIndex];
  const s = page ? summaries?.pages[page.id] : undefined;
  if (!s) return null;
  return (
    <div className="page-sum">
      <div className="page-sum-text">{s.text.split('\n').map((l, i) => <p key={i}>{l.replace(/^[-*•]\s+/, '')}</p>)}</div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => addPageNote(doc, pageIndex, s.text)}><FilePlus2 size={13} /> Add to page</button>
    </div>
  );
}

/** "Summarize pages" (on demand): every page with writing, plus what was said while it was written. */
export function SummarizePagesButton({ doc, vault }: { doc: NoteDocument; vault: AppVault }) {
  const toast = useApp((a) => a.toast);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <button type="button" className="btn" disabled={!!busy} onClick={async () => {
      setBusy('Summarizing…');
      try {
        const done = await summarizePages(vault, doc.meta, [...doc.pages], { pageIndexes: doc.pages.map((_, i) => i), onPage: (i) => setBusy(`Summarized page ${i + 1}…`) });
        await reindexTranscripts(vault, doc.meta.id);
        toast({ text: done.size ? `Summarized ${done.size} ${done.size === 1 ? 'page' : 'pages'}` : 'Nothing to summarize yet: write, type or record first', tone: done.size ? 'success' : undefined });
      } catch (e) {
        toast({ text: (e as Error).message, tone: 'error' });
      } finally {
        setBusy(null);
      }
    }}>
      <Sparkles size={16} /> {busy ?? 'Summarize pages'}
    </button>
  );
}
