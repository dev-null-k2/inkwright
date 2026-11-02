import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookmarkPlus, Copy, FileUp } from 'lucide-react';
import { useModules, isModuleOn } from '../modules/registry.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import type { ImporterKind } from './convert.ts';
import { IMPORTER_MODULE_OF } from './modules.ts';

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

const SOURCES: Array<{ kind: ImporterKind; title: string; accept: string; how: string; button: string }> = [
  { kind: 'notion', title: 'Notion', accept: '.zip,application/zip', button: 'Choose the export zip', how: 'In Notion: Settings › Export all workspace content (or ••• › Export on a page), format Markdown & CSV, with subpages. Pages keep their nesting; each database becomes a note with a table.' },
  { kind: 'evernote', title: 'Evernote', accept: '.enex', button: 'Choose .enex files', how: 'In Evernote: right-click a notebook › Export notebook (ENEX). Each file becomes a notebook; tags, dates, pictures, PDFs and to-dos come along. Encrypted text can’t be read and is left out.' },
  { kind: 'onenote', title: 'OneNote', accept: '.docx,.mht,.mhtml,.html,.htm,.pdf,.zip', button: 'Choose exported pages', how: 'OneNote’s own .one files can’t be read. In OneNote for Windows: File › Export › Page or Section › Word Document (or Single File Web Page). On a Mac or the web: export or print to PDF.' },
  { kind: 'pdf-notebook', title: 'GoodNotes and Notability', accept: '.pdf,application/pdf', button: 'Choose PDF exports', how: 'Export notebooks as PDF (GoodNotes: Share › Export › PDF; Notability: Share › PDF). The notebook’s outline splits it into notes; pages stay as they look and you can write on them.' },
];

/** Settings › Import & clip: one card per importer module that is on, and the web clipper. */
export function ImportSettings() {
  const enabled = useModules((m) => m.enabled);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState<ImporterKind | null>(null);
  const shown = SOURCES.filter((s) => isModuleOn(IMPORTER_MODULE_OF[s.kind], enabled));
  const clipper = isModuleOn('web-clipper', enabled);

  const run = async (kind: ImporterKind, accept: string) => {
    const files = await pickFiles(accept, true);
    if (!files.length) return;
    setBusy(kind);
    try {
      const { runImport } = await import('./run.ts');
      const r = await runImport(kind, files);
      if (r?.warnings.length) toast({ text: r.warnings.slice(0, 3).join(' '), tone: 'error' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {!shown.length && !clipper && <p className="set-note">All importers are switched off. Turn them on in Settings › Modules.</p>}
      {shown.map((s) => (
        <Group key={s.kind} title={s.title} note={s.how}>
          <div className="dev-source-actions">
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run(s.kind, s.accept)} aria-label={`Import from ${s.title}`}>
              <FileUp size={14} /> {busy === s.kind ? 'Importing…' : s.button}
            </button>
          </div>
        </Group>
      ))}
      {clipper && <ClipperCard />}
    </>
  );
}

function ClipperCard() {
  const toast = useApp((s) => s.toast);
  const link = useRef<HTMLAnchorElement>(null);
  const [code, setCode] = useState('');
  useEffect(() => {
    void import('./clipper.ts').then(({ bookmarklet }) => {
      const js = bookmarklet(`${location.origin}${location.pathname}`);
      setCode(js);
      // React refuses javascript: URLs in props; this one is ours, so it is set on the element.
      link.current?.setAttribute('href', js);
    });
  }, []);
  return (
    <Group title="Web clipper" note="The clipper reads the page’s main text (or what you selected) in your browser and opens Inkwright with it; nothing goes through a server. You see the clip before it is saved, as a note tagged #clipped that says where it came from. On Android, sharing a link to Inkwright saves the link the same way.">
      <div className="clip-row">
        <a ref={link} className="btn btn-sm clip-bookmarklet" draggable onClick={(e) => { e.preventDefault(); toast({ text: 'Drag this button to your bookmarks bar, then press it on any page.' }); }} data-testid="clip-bookmarklet">
          <BookmarkPlus size={14} /> Clip to Inkwright
        </a>
        <button type="button" className="btn btn-sm btn-ghost" disabled={!code} onClick={() => void navigator.clipboard?.writeText(code).then(() => toast({ text: 'Copied. Make a bookmark and paste it as the address.' }), () => {})}>
          <Copy size={14} /> Copy bookmarklet
        </button>
      </div>
    </Group>
  );
}
