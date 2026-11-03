#!/usr/bin/env bash
# Builds the debug APK the emulator suite installs: the native web build WITH the e2e test hook
# (window.__inkwright, see vite.config.ts → INKWRIGHT_E2E_HOOK), synced into the Capacitor project.
#
#   ./build-apk.sh                 vite build --mode native + cap sync + gradlew assembleDebug
#
# Extra Gradle arguments come from INKWRIGHT_GRADLE_ARGS (e.g. an --init-script for a Maven
# mirror). Release builds never set INKWRIGHT_E2E_HOOK, so they carry no test hook.
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$WEB_DIR"
INKWRIGHT_E2E_HOOK=1 npx vite build --mode native
npx cap sync android
cd android
# shellcheck disable=SC2086
# Debug APKs carry arm64-v8a only (docs/PERFORMANCE.md); add the emulator image's ABI.
./gradlew --no-daemon ${INKWRIGHT_GRADLE_ARGS:-} -Pinkwright.debugAbis="arm64-v8a,${AVD_IMAGE##*;}" assembleDebug
log "built $APK"
