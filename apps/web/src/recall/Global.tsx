import { Suspense, lazy } from 'react';
import { useTimelineUI } from './ui.ts';

// The timeline view loads when first opened, so it never weighs on startup.
const TimelineView = lazy(() => import('./TimelineView.tsx').then((m) => ({ default: m.TimelineView })));

/** Mounted by the app while the memory timeline module is on. */
export function RecallGlobal() {
  const open = useTimelineUI((s) => s.open);
  if (!open) return null;
  return <Suspense fallback={null}><TimelineView /></Suspense>;
}
