/** PW_PORT lets several checkouts run e2e side by side (each builds into its own folder). */
const PORT = Number(process.env.PW_PORT ?? 4174);
const OUT = PORT === 4174 ? 'dist-e2e' : `dist-e2e-${PORT}`;

import { defineConfig, devices } from '@playwright/test';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

// Headless WebKit and Firefox are slower than Chromium on small CI machines; give tests more time.
const SLOW = 90_000;

/**
 * WebKit (Safari on macOS, and every browser on iPhone/iPad, including the Capacitor iOS shell) and
 * Firefox. Opt-in with INKWRIGHT_ENGINES=all (`npm run e2e:all`, which also installs the engines),
 * so `npm run e2e` keeps needing only Chromium. Windows users run Edge/Chrome (Chromium: the
 * default projects) or Firefox. Touch-first devices run the layout and touch specs, like the
 * Chromium foldable/phone projects.
 */
const otherEngines = [
  { name: 'webkit-desktop', timeout: SLOW, use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 860 } } },
  // iPadOS Safari reports a Mac user agent by default; only the touch points give it away.
  { name: 'webkit-ipad', timeout: SLOW, use: { ...devices['iPad Pro 11'], userAgent: devices['Desktop Safari'].userAgent }, testMatch: /layout|touch/ },
  { name: 'webkit-iphone', timeout: SLOW, use: { ...devices['iPhone 15'] }, testMatch: /layout|touch/ },
  { name: 'firefox-desktop', timeout: SLOW, use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 860 } } },
];

/**
 * End-to-end tests run the production build in real Chromium with synthetic stylus input
 * (PointerEvents with pointerType "pen", pressure, tilt and buttons).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  webServer: {
    command: `npx vite build --mode e2e --outDir ${OUT} && npx vite preview --port ${PORT} --strictPort --outDir ${OUT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'foldable', use: { viewport: { width: 884, height: 1104 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true }, testMatch: /layout|touch/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /layout|touch/ },
    ...(process.env.INKWRIGHT_ENGINES === 'all' ? otherEngines : []),
  ],
});
