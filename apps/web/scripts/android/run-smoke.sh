#!/usr/bin/env bash
# The whole Android emulator check, end to end:
#   boot the AVD (creating it if needed) → install the debug APK → start the app → attach Playwright
#   to its WebView over CDP and run e2e-android/ → drive real stylus strokes from adb (native ink tip
#   and paper-feel paths) → save screenshots and logcat → fail on any crash or ANR.
#
#   ./run-smoke.sh               uses the APK at $APK (build it with ./build-apk.sh first)
#   ./run-smoke.sh --build       builds the APK first
#   ./run-smoke.sh --shutdown    stops the emulator at the end (saving a quick-boot snapshot)
#
# Results: $ARTIFACTS (apps/web/test-artifacts/android/): *.png screenshots, smoke.log (full logcat),
# smoke.filtered.log (our tags, crashes, ANRs), native-evidence.txt.
set -euo pipefail
source "$(dirname "$0")/env.sh"

BUILD=0; SHUTDOWN=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --shutdown) SHUTDOWN=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

[ "$BUILD" = 1 ] && "$SCRIPT_DIR/build-apk.sh"
"$SCRIPT_DIR/boot.sh"
"$SCRIPT_DIR/app.sh" install
"$SCRIPT_DIR/app.sh" reset
"$SCRIPT_DIR/app.sh" logcat-clear
"$SCRIPT_DIR/app.sh" theme light
"$SCRIPT_DIR/app.sh" launch
CDP="$("$SCRIPT_DIR/app.sh" cdp)"
log "WebView CDP endpoint: $CDP"

STATUS=0
(cd "$WEB_DIR" && DEBUG=pw:protocol DEBUG_FILE="$ARTIFACTS/cdp-protocol.log" INKWRIGHT_CDP="$CDP" ANDROID_SERIAL="$ANDROID_SERIAL" INKWRIGHT_ANDROID_ARTIFACTS="$ARTIFACTS" \
  npx playwright test -c playwright.android.config.ts) || STATUS=$?

# Native evidence: what the activity and plugin did, straight from the device.
"$SCRIPT_DIR/app.sh" logcat smoke
{
  echo "# Native evidence ($(date -u +%FT%TZ), $ANDROID_SERIAL, API $("$ADB" shell getprop ro.build.version.sdk | tr -d '\r'))"
  echo "## WebView"
  "$ADB" shell dumpsys webviewupdate 2>/dev/null | grep -E "Current WebView package|versionName" | head -3 || true
  echo "## Writing sound / paper feel (InkwrightFeel)"
  grep -E "InkwrightFeel" "$ARTIFACTS/smoke.log" | head -20 || true
  echo "## Ink tip (InkwrightInkTip)"
  grep -E "InkwrightInkTip" "$ARTIFACTS/smoke.log" | head -20 || echo "(no warnings or errors logged)"
  echo "## Ink tip overlay in the view hierarchy"
  "$ADB" shell dumpsys activity top 2>/dev/null | grep -E "InkTip|SurfaceView" | head -5 || true
  echo "## Haptics (vibrator present?)"
  "$ADB" shell dumpsys vibrator_manager 2>/dev/null | head -5 || "$ADB" shell dumpsys vibrator 2>/dev/null | head -5 || true
  echo "## Other Inkwright log lines"
  grep -E " (Inkwright|InkwrightNative|InkwrightRecognizer) " "$ARTIFACTS/smoke.log" | head -20 || true
} >"$ARTIFACTS/native-evidence.txt"
log "native evidence: $ARTIFACTS/native-evidence.txt"

"$SCRIPT_DIR/app.sh" check-crashes smoke || STATUS=1

if [ "$SHUTDOWN" = 1 ]; then
  "$ADB" emu kill >/dev/null 2>&1 || true
fi
log "screenshots and logs in $ARTIFACTS"
exit "$STATUS"
