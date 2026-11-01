import { defineConfig, devices } from '@playwright/test';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

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
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  webServer: {
    command: 'npx vite build --mode e2e && npx vite preview --port 4174 --strictPort --outDir dist-e2e',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'foldable', use: { viewport: { width: 884, height: 1104 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true }, testMatch: /layout|touch/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /layout|touch/ },
  ],
});
