import { BookMarked } from 'lucide-react';
import { usePaletteActions } from '../lib/palette.ts';
import { useModule } from '../modules/registry.ts';
import { PapersDialogHost, openPapers } from '../papers/PapersDialog.tsx';

/** The library's "Papers" entry in the side bar (paper workbench). */
export function PapersNavItem({ onDone }: { onDone?: () => void }) {
  if (!useModule('papers')) return null;
  return (
    <button type="button" className="nav-item" onClick={() => { openPapers(); onDone?.(); }}>
      <span className="nav-icon"><BookMarked size={17} /></span><span className="nav-label">Papers</span>
    </button>
  );
}

/** Always mounted in the library (the side bar is a drawer on phones): palette action and dialog. */
export function LibraryInkActions() {
  const on = useModule('papers');
  usePaletteActions('inkactions.library', on ? [{ id: 'papers.library', label: 'Library of papers', keywords: 'zotero bibtex csl citations references import pdf', icon: <BookMarked size={16} />, run: openPapers }] : []);
  return on ? <PapersDialogHost /> : null;
}
