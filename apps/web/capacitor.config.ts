import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor shell for Android (and iOS). The web build in dist/ is copied into the native
 * projects by `npx cap sync`. The Android-only `InkstoneNative` plugin lives in
 * android/app/src/main/java/app/inkstone/ (see docs/ANDROID.md).
 */
const config: CapacitorConfig = {
  appId: 'app.inkstone',
  appName: 'Inkstone',
  // Native builds come from `vite build --mode native` (CSP adjusted for Capacitor's bridge).
  webDir: 'dist-native',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    // Note: true swaps the WebView's IME connection for a plain BaseInputConnection, which limits
    // predictive text, IME composition and Android's "write in text fields" stylus handwriting.
    // See docs/ANDROID.md → "Text input and captureInput".
    captureInput: false,
  },
  plugins: {
    // @capacitor/splash-screen is not installed; these apply if it is added later. Android 12+
    // always shows the system splash (#DDE2E6, or #14181C in dark mode; see
    // android/app/src/main/res/values*/) until the WebView's first frame. The WebView background
    // is set natively to the same colour so dark mode never flashes white.
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
    },
    Keyboard: {
      resize: 'body',
    },
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
    SocialLogin: {
      // Only Google is used (Drive sync). Disabled providers are not bundled.
      providers: {
        google: true,
        facebook: false,
        apple: false,
        twitter: false,
      },
      logLevel: 1,
    },
  },
};

export default config;
