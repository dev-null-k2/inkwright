import { Suspense, lazy } from 'react';
import { useModule } from '../modules/registry.ts';
import { bannerVisible, useUpdates } from './store.ts';

const UpdateBanner = lazy(() => import('./UpdateBanner.tsx'));

/**
 * Where the library shows the update banner. Only the small store is imported up front; the
 * banner's code loads when there is an update to show (never on the web, the desktop app or Google
 * Play builds, where nothing ever offers one).
 */
export function LibraryUpdateSlot() {
  const on = useModule('updates');
  const show = useUpdates((s) => bannerVisible(s));
  if (!on || !show) return null;
  return (
    <Suspense fallback={null}>
      <UpdateBanner />
    </Suspense>
  );
}
