import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import type { Plugin } from 'vite';

/**
 * Content Security Policy for hosted/native builds. Any AI endpoint may be configured by the user
 * (including local servers), so connect-src stays open; images, scripts and frames are pinned so
 * injected content can't load remote resources or exfiltrate notes.
 */
function csp(native: boolean): Plugin {
  const policy = [
    "default-src 'self'",
    // Capacitor injects its native bridge as an inline script, so native builds must allow it.
    `script-src 'self' blob: https://accounts.google.com${native ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://accounts.google.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "font-src 'self' data:",
    "connect-src * data: blob:",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
    "frame-src https://accounts.google.com",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  return {
    name: 'inkstone-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

/** Writes sw.js with the exact list of built files, so the installed app works fully offline. */
function serviceWorker(): Plugin {
  return {
    name: 'inkstone-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const version = Date.now().toString(36);
      const source = `// Generated at build time. Precaches the app so it opens offline; notes live in IndexedDB.
const CACHE = 'inkstone-${'$'}{version}';
const FILES = ${'$'}{JSON.stringify(['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/icon.svg', ...files])};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('inkstone-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('./', copy)); return r; }).catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// `vite build` → multi-file PWA build in dist/ (web hosting, Capacitor Android/iOS, desktop).
// `vite build --mode single` → one self-contained HTML file (live preview, offline sharing).
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  const e2e = mode === 'e2e';
  const native = mode === 'native';
  return {
    base: './',
    plugins: [react(), ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : native ? [csp(true)] : [serviceWorker(), csp(false)])],
    publicDir: single ? false : 'public',
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
      __BUILD_TARGET__: JSON.stringify(single ? 'single' : 'web'),
      __E2E__: JSON.stringify(e2e),
    },
    worker: { format: 'es' },
    build: {
      outDir: single ? 'dist-single' : e2e ? 'dist-e2e' : native ? 'dist-native' : 'dist',
      target: 'es2022',
      sourcemap: !single,
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 4000,
    },
    server: { host: true, port: 5173 },
  };
});
