import { useEffect } from 'react';
import { useApp, routeFromHash } from './state/app.ts';
import { useSettings } from './state/settings.ts';
import { AppVault } from './lib/vault.ts';
import { startSyncLoop } from './lib/sync.ts';
import { Library } from './screens/Library.tsx';
import { Editor } from './screens/Editor.tsx';
import { Settings } from './screens/Settings.tsx';
import { Prompts } from './ui/prompts.tsx';
import { Toasts } from './ui/Toasts.tsx';
import { BrandMark } from './ui/Brand.tsx';
import { isNative } from './platform/env.ts';

export function App() {
  const { ready, route, error, setVault, refresh, navigate } = useApp();
  const theme = useSettings((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = await AppVault.open();
        if (!alive) return;
        setVault(v);
        await refresh();
        if (location.hash === '#new') {
          // App shortcut / home-screen action: start writing immediately.
          const { createNote } = await import('./lib/actions.ts');
          const id = await createNote();
          navigate(id ? { name: 'editor', noteId: id } : { name: 'library' }, { replace: true });
        } else navigate(routeFromHash(location.hash), { replace: true });
        // Files the system opened Inkstone with (desktop file handler, share target, Android "Open with").
        void import('./lib/openFiles.ts').then((m) => m.installOpenHandlers());
        if (!v.persistent) useApp.getState().toast({ text: 'This browser blocks storage here, so notes last for this session only. Sign in to sync, or open Inkstone in its own tab.', tone: 'error' });
        await v.buildIndex();
        await v.vault.purgeTrash();
        startSyncLoop();
      } catch (e) {
        console.error(e);
        useApp.setState({ error: (e as Error).message });
      }
    })();
    const onPop = (e: PopStateEvent) => useApp.setState({ route: (e.state as any) ?? routeFromHash(location.hash) });
    window.addEventListener('popstate', onPop);
    return () => { alive = false; window.removeEventListener('popstate', onPop); };
  }, [setVault, refresh, navigate]);

  // Android back button.
  useEffect(() => {
    if (!isNative) return;
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(({ App: CapApp }) => CapApp.addListener('backButton', () => {
      const r = useApp.getState().route;
      if (r.name === 'library') void CapApp.minimizeApp();
      else history.back();
    })).then((h) => { remove = () => h.remove(); });
    return () => remove?.();
  }, []);

  if (error) {
    return (
      <div className="boot">
        <BrandMark size={44} />
        <p>Inkstone couldn't open your notes: {error}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="boot" aria-live="polite">
        <BrandMark size={44} />
      </div>
    );
  }
  return (
    <>
      {route.name === 'library' && <Library />}
      {route.name === 'editor' && <Editor key={route.noteId} noteId={route.noteId} initialPage={route.page} />}
      {route.name === 'settings' && <Settings section={route.section} />}
      <Prompts />
      <Toasts />
    </>
  );
}
