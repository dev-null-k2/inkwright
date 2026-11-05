import type { ModuleDefinition } from '../modules/registry.ts';
import { updaterPlugin } from './plugin.ts';

/**
 * Updates (docs/UPDATES.md): the Android app, installed from GitHub Releases, finds and installs
 * its own new releases. Only registered where the native updater exists — the Android app built for
 * GitHub (Google Play builds update through Play; the web app updates itself through its service
 * worker; the desktop app has the Tauri updater, Settings › Desktop app).
 *
 * Switched off, nothing checks in the background and no banner appears; Settings › About ›
 * Updates still shows the version and can check when asked.
 */
export const UPDATE_MODULES: ModuleDefinition[] = updaterPlugin()
  ? [
      {
        id: 'updates',
        name: 'Updates',
        description: 'Finds new releases of Inkwright on GitHub and installs them from inside the app, after checking each one is signed with Inkwright’s key.',
        defaultEnabled: true,
        contributes: {
          panels: ['Update banner (library)'],
          background: ['Checking GitHub for a new release after launch and every 6 hours'],
        },
        whenOff: 'Inkwright doesn’t look for updates by itself. Settings › About › Updates can still check when you ask.',
        async activate() {
          const { startUpdateChecks } = await import('./service.ts');
          return startUpdateChecks();
        },
      },
    ]
  : [];
