import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { engineAssets, engineSourceFromEnv, keepEngineWasmOut, type EngineSourceMode } from './build/engines.ts';
import { desktopOcrAssets } from './scripts/vite-desktop-assets.ts';
import { changelogNotes } from './build/changelog.ts';
import { serviceWorkerSource } from './build/sw.ts';

/**
 * Content Security Policy for hosted/native builds. Any AI endpoint may be configured by the user
 * (including local servers), so connect-src stays open; images, scripts and frames are pinned so
 * injected content can't load remote resources or exfiltrate notes.
 */
function csp(native: boolean): Plugin {
  const policy = [
    "default-src 'self'",
    // Capacitor injects its native bridge as an inline script, so native builds must allow it.
    // 'wasm-unsafe-eval' lets the on-device AI runtime (ONNX Runtime Web) compile WebAssembly.
    `script-src 'self' blob: 'wasm-unsafe-eval' https://accounts.google.com${native ? " 'unsafe-inline'" : ''}`,
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
    name: 'inkwright-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

const APP_VERSION = process.env.INKWRIGHT_VERSION || process.env.npm_package_version || '1.0.0';

/**
 * version.json next to the web app: the version this deployment serves and its notes. A running
 * copy compares it with its own version to offer "Update" (src/updates/web.ts), which is how the
 * web app and Home Screen apps on iPhone and iPad get the same update banner as Android.
 */
function versionManifest(): Plugin {
  return {
    name: 'inkwright-version',
    apply: 'build',
    generateBundle() {
      const file = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url));
      const notes = existsSync(file) ? changelogNotes(readFileSync(file, 'utf8'), APP_VERSION) : '';
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: APP_VERSION, notes, built: new Date().toISOString() }) });
    },
  };
}

/** Writes sw.js with the exact list of built files, so the installed app works fully offline. */
function serviceWorker(): Plugin {
  return {
    name: 'inkwright-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      // Engines (DuckDB, the on-device AI runtime, code parsers: tens of MB of WebAssembly) download
      // on first use into their own verified cache (src/engines), never at install.
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.startsWith('engines/') && !/ort-wasm|\.wasm$/.test(f));
      const version = Date.now().toString(36);
      const source = serviceWorkerSource(files, version);
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
  // `vite build --mode desktop` → dist-desktop/ for the Tauri shell (apps/desktop): no service
  // worker (the shell serves the files), CSP from tauri.conf.json, on-device OCR files included.
  const desktop = mode === 'desktop';
  // Where heavy engines come from (build/engines.ts): a pinned CDN for the native and desktop apps,
  // so they stay out of the APK and the installer; next to the app for web builds.
  // INKWRIGHT_ENGINE_SOURCE=app|cdn overrides (not INKWRIGHT_ENGINES, which selects the browser
  // engines e2e runs on: playwright.config.ts).
  const engines: EngineSourceMode = single ? 'none' : engineSourceFromEnv(process.env.INKWRIGHT_ENGINE_SOURCE) ?? (native || desktop ? 'cdn' : 'app');
  return {
    base: './',
    plugins: [react(), engineAssets(engines), keepEngineWasmOut(), ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : native ? [csp(true)] : desktop ? [] : [serviceWorker(), versionManifest(), csp(false)]), ...(desktop || e2e ? [desktopOcrAssets()] : [])],
    publicDir: single ? false : 'public',
    // The single-file preview leaves the on-device AI runtime out (see src/ai/spawn-unavailable.ts).
    // It also leaves out the developer module's grammars and SQLite (src/dev/wasm-assets-unavailable.ts).
    resolve: single ? { alias: [
      { find: /^\.\.\/ai\/spawn\.ts$/, replacement: fileURLToPath(new URL('./src/ai/spawn-unavailable.ts', import.meta.url)) },
      { find: /^\.\/wasm-assets\.ts$/, replacement: fileURLToPath(new URL('./src/dev/wasm-assets-unavailable.ts', import.meta.url)) },
      // And the data sandbox's DuckDB and SQLite (src/datasandbox/engine-assets-unavailable.ts).
      { find: /^\.\/engine-assets\.ts$/, replacement: fileURLToPath(new URL('./src/datasandbox/engine-assets-unavailable.ts', import.meta.url)) },
    ] } : undefined,
    define: {
      // The release version (INKWRIGHT_VERSION, set by release.yml and desktop.yml from the tag),
      // so About, the device check and certificates name the version people installed.
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BUILD_TARGET__: JSON.stringify(single ? 'single' : desktop ? 'desktop' : native ? 'native' : 'web'),
      // INKWRIGHT_E2E_HOOK=1 adds the test hook to other builds too: the Android emulator suite
      // (e2e-android/) drives a native debug build and reads the document through it.
      __E2E__: JSON.stringify(e2e || process.env.INKWRIGHT_E2E_HOOK === '1'),
    },
    worker: { format: 'es', plugins: () => [keepEngineWasmOut()] },
    build: {
      outDir: single ? 'dist-single' : e2e ? 'dist-e2e' : native ? 'dist-native' : desktop ? 'dist-desktop' : 'dist',
      target: 'es2022',
      // Native builds leave source maps out of the APK unless asked for (INKWRIGHT_SOURCEMAPS=1,
      // for chrome://inspect sessions): they were 8.8 MB of the debug APK (docs/PERFORMANCE.md).
      sourcemap: native ? process.env.INKWRIGHT_SOURCEMAPS === '1' : !single,
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 4000,
    },
    server: { host: true, port: 5173 },
  };
});
