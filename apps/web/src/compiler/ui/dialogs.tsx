/**
 * The compiler's dialogs, opened from anywhere (assistant answers, the editor's ••• menu, the
 * assistant's screens) and hosted once at the app root: Explain, Context pack, Review and Teach
 * me back.
 */
import { lazy, Suspense } from 'react';
import { create } from 'zustand';
import { Dialog } from '../../ui/primitives.tsx';
import { ExplainView, type ExplainPayload } from './Explain.tsx';

const PackDialogBody = lazy(() => import('./PackDialog.tsx').then((m) => ({ default: m.PackDialogBody })));
const ReviewScreen = lazy(() => import('./Review.tsx').then((m) => ({ default: m.ReviewScreen })));
const TutorScreen = lazy(() => import('./Tutor.tsx').then((m) => ({ default: m.TutorScreen })));

interface DialogState {
  explain: ExplainPayload | null;
  pack: { noteIds: string[]; title: string } | null;
  review: { deckId?: string } | null;
  tutor: { noteIds: string[]; title: string } | null;
}

const useDialogs = create<DialogState>(() => ({ explain: null, pack: null, review: null, tutor: null }));

export const openExplain = (p: ExplainPayload) => useDialogs.setState({ explain: p });
export const openPack = (p: { noteIds: string[]; title: string }) => useDialogs.setState({ pack: p });
export const openReview = (p: { deckId?: string } = {}) => useDialogs.setState({ review: p });
export const openTutor = (p: { noteIds: string[]; title: string }) => useDialogs.setState({ tutor: p });

export function CompilerDialogs() {
  const s = useDialogs();
  // Following a source link closes the dialog it is in.
  const closeOnLink = (e: React.MouseEvent) => { if ((e.target as Element).closest?.('a[href^="#mem/"]')) useDialogs.setState({ explain: null }); };
  return (
    <>
      {s.explain && (
        <Dialog open wide title={`Explain: ${s.explain.title}`} onClose={() => useDialogs.setState({ explain: null })}>
          <div onClickCapture={closeOnLink}><ExplainView payload={s.explain} /></div>
        </Dialog>
      )}
      <Suspense fallback={null}>
        {s.pack && <PackDialogBody init={s.pack} onClose={() => useDialogs.setState({ pack: null })} />}
        {s.review && <ReviewScreen deckId={s.review.deckId} onClose={() => useDialogs.setState({ review: null })} />}
        {s.tutor && <TutorScreen init={s.tutor} onClose={() => useDialogs.setState({ tutor: null })} />}
      </Suspense>
    </>
  );
}
