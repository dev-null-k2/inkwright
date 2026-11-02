import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { citedKeys, formatBibliography, newId, toBibtex, type NoteDocument, type Reference, type TextBox } from '@inkstone/core';
import type { InkEngine } from '../canvas/engine.ts';
import { useApp } from '../state/app.ts';
import { saveFile } from '../platform/files.ts';
import { Dialog, Segmented } from '../ui/primitives.tsx';
import { useInkPrefs } from '../inkactions/prefs.ts';
import { libraryReferences } from './library.ts';

/**
 * A note's bibliography: every `[@key]` cited in its typed text (in order of first citation),
 * formatted in APA 7 or IEEE, with keys missing from the library listed so nothing is silently
 * dropped. Copy it, put it on the page, or export it as BibTeX or a reference list.
 */
export const useBibliography = create<{ doc: NoteDocument | null; engine: InkEngine | null }>(() => ({ doc: null, engine: null }));
export const openBibliography = (doc: NoteDocument, engine: InkEngine | null) => useBibliography.setState({ doc, engine });

export function BibliographyHost() {
  const s = useBibliography();
  if (!s.doc) return null;
  return <Bibliography doc={s.doc} engine={s.engine} onClose={() => useBibliography.setState({ doc: null })} />;
}

/** Typed text of the note (citations live there), page by page. */
export function noteTexts(doc: Pick<NoteDocument, 'pages'>): string[] {
  return doc.pages.flatMap((p) => (p.texts ?? []).map((t) => t.text));
}

export function noteBibliography(doc: Pick<NoteDocument, 'pages'>, lib: readonly { ref: Reference }[]): { refs: Reference[]; missing: string[] } {
  const keys = citedKeys(noteTexts(doc));
  const by = new Map(lib.map((x) => [x.ref.id, x.ref]));
  return { refs: keys.flatMap((k) => (by.has(k) ? [by.get(k)!] : [])), missing: keys.filter((k) => !by.has(k)) };
}

function Bibliography({ doc, engine, onClose }: { doc: NoteDocument; engine: InkEngine | null; onClose: () => void }) {
  const notes = useApp((s) => s.notes);
  const toast = useApp((s) => s.toast);
  const style = useInkPrefs((s) => s.citationStyle);
  const setPrefs = useInkPrefs((s) => s.set);
  const [copied, setCopied] = useState(false);
  const { refs, missing } = useMemo(() => noteBibliography(doc, libraryReferences(notes)), [doc, doc.version, notes]); // eslint-disable-line react-hooks/exhaustive-deps
  const formatted = formatBibliography(refs, style);
  const markdown = formatted.map((f) => f.markdown).join('\n\n');
  const base = (doc.meta.title || 'references').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'references';
  const enc = new TextEncoder();
  const insert = () => {
    const i = engine?.currentPageIndex ?? doc.pageCount - 1;
    const page = doc.page(i);
    const ys = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 60)];
    const box: TextBox = { id: newId(), x: 64, y: ys.length ? Math.max(...ys) + 32 : 96, width: (doc.meta.pageSize.width || 794) - 128, text: `## References\n\n${formatted.map((f) => f.text).join('\n\n')}`, fontSize: 13, color: '#FF1B1F24', font: 'serif', createdAt: Date.now() };
    doc.upsertText(i, box, 'References');
    toast({ text: 'References added to the page', action: { label: 'Undo', run: () => (engine ? engine.undo() : doc.undo()) } });
    onClose();
  };
  return (
    <Dialog open wide title="Bibliography" onClose={onClose} actions={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="ia-row">
        <Segmented label="Citation style" value={style} onChange={(v) => setPrefs({ citationStyle: v })} options={[{ value: 'apa', label: 'APA 7' }, { value: 'ieee', label: 'IEEE' }]} />
      </div>
      {refs.length === 0 && !missing.length ? (
        <p className="ia-muted">This note cites no papers yet. Type <code>[@</code> in a text box to cite one from your library.</p>
      ) : (
        <ol className={`ia-bib is-${style}`} aria-label="References">
          {formatted.map((f) => <li key={f.id} dangerouslySetInnerHTML={{ __html: f.html }} />)}
        </ol>
      )}
      {missing.length > 0 && <p className="ia-error" role="status">Not in your library: {missing.map((k) => `@${k}`).join(', ')}. Import them (Library › palette › Import references).</p>}
      {refs.length > 0 && (
        <div className="ia-row">
          <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className="btn btn-sm" onClick={insert}>Put on the page</button>
          <button type="button" className="btn btn-sm" onClick={() => void saveFile(`${base}.bib`, enc.encode(toBibtex(refs)), 'application/x-bibtex')}>Export BibTeX</button>
          <button type="button" className="btn btn-sm" onClick={() => void saveFile(`${base} references.md`, enc.encode(`# References\n\n${formatted.map((f) => f.markdown).join('\n\n')}\n`), 'text/markdown')}>Export list</button>
        </div>
      )}
    </Dialog>
  );
}
