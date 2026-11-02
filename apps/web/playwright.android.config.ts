import { defineConfig } from '@playwright/test';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

/**
 * Android smoke suite: drives the real Inkwright app (debug APK with the e2e hook) inside an Android
 * emulator or device. Playwright attaches to the app's WebView over the Chrome DevTools Protocol
 * (adb forwards localabstract:webview_devtools_remote_<pid>; see scripts/android/app.sh cdp).
 * Nothing is launched or served from here: run it through scripts/android/run-smoke.sh, which boots
 * the emulator, installs and starts the app, forwards the socket and checks logcat afterwards.
 *
 * One worker, generous timeouts: without hardware virtualisation the emulator runs a software CPU.
 */
export default defineConfig({
  testDir: './e2e-android',
  timeout: 10 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/android',
  use: { actionTimeout: 60_000, navigationTimeout: 180_000 },
});
