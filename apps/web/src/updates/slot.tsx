import { Suspense, lazy } from 'react';
import { useModule } from '../modules/registry.ts';
import { bannerVisible, useUpdates } from './store.ts';
import { updaterPlugin } from './plugin.ts';
import { useWebUpdates, webUpdatesApply } from './web.ts';

const UpdateBanner = lazy(() => import('./UpdateBanner.tsx'));
const WebUpdateBanner = lazy(() => import('./WebUpdateBanner.tsx'));
const web = !updaterPlugin() && webUpdatesApply();

/**
 * Where the library shows the update banner. Only the small store is imported up front; the
 * banner's code loads when there is an update to show (never in the desktop app or Google Play
 * builds, which update otherwise). The web app and Home Screen apps get WebUpdateBanner.
 */
export function LibraryUpdateSlot() {
  const on = useModule('updates');
  const webShow = useWebUpdates((s) => !!s.available || !!s.updatedFrom);
  // Not before the running version is known: a remembered offer may be the version just installed.
  const show = useUpdates((s) => s.current != null && bannerVisible(s));
  if (web) return on && webShow ? <Suspense fallback={null}><WebUpdateBanner /></Suspense> : null;
  if (!on || !show || !updaterPlugin()) return null;
  return (
    <Suspense fallback={null}>
      <UpdateBanner />
    </Suspense>
  );
}
