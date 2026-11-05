import { Suspense, lazy } from 'react';
import { useModule } from '../modules/registry.ts';
import { bannerVisible, useUpdates } from './store.ts';
import { updaterPlugin } from './plugin.ts';

const UpdateBanner = lazy(() => import('./UpdateBanner.tsx'));

/**
 * Where the library shows the update banner. Only the small store is imported up front; the
 * banner's code loads when there is an update to show (never on the web, the desktop app or Google
 * Play builds, where nothing ever offers one).
 */
export function LibraryUpdateSlot() {
  const on = useModule('updates');
  // Not before the running version is known: a remembered offer may be the version just installed.
  const show = useUpdates((s) => s.current != null && bannerVisible(s));
  if (!on || !show || !updaterPlugin()) return null;
  return (
    <Suspense fallback={null}>
      <UpdateBanner />
    </Suspense>
  );
}
