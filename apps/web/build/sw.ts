/**
 * The service worker the hosted web app and Home Screen apps install (vite.config.ts writes it as
 * sw.js with the exact list of built files, so the installed app opens offline). Tested in
 * src/updates/sw-source.test.ts: it must parse, or no browser installs it.
 */
export function serviceWorkerSource(files: string[], version: string): string {
  return `// Generated at build time. Precaches the app so it opens offline; notes live in IndexedDB.
const CACHE = 'inkwright-app-${version}';
const FILES = ${JSON.stringify(['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/icon.svg', ...files])};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
// Only this worker's own older app caches are removed: downloaded engines (inkwright-engines-*) and
// files shared to the app (inkwright-share) are kept. inkwright-<version> is the older name.
const OLD_APP = (k) => k !== CACHE && (k.startsWith('inkwright-app-') || /^inkwright-[0-9a-z]{8,}$/.test(k));
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter(OLD_APP).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Web Share Target: files/text shared to the installed app arrive as a POST; keep them in a
  // cache for the page (lib/openFiles.ts) and open the app.
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await req.formData();
      const cache = await caches.open('inkwright-share');
      let i = 0;
      for (const f of form.getAll('files')) {
        if (typeof f === 'string') continue;
        await cache.put('./__share/' + Date.now() + '-' + (i++), new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'Shared file') } }));
      }
      const text = ['title', 'text', 'url'].map((k) => form.get(k)).filter((v) => typeof v === 'string' && v).join('\\n');
      if (text) await cache.put('./__share/text', new Response(text));
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // The update check must see what the server has now, never a cached copy.
  if (new URL(req.url).pathname.endsWith('/version.json')) return;
  // Engine files have their own cache (src/engines/store.ts); keeping a second copy here would
  // double tens of MB of storage.
  if (new URL(req.url).pathname.includes('/engines/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('./', copy)); return r; }).catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })));
});
`;
}
