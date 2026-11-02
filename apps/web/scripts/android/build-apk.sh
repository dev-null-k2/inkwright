#!/usr/bin/env bash
# Builds the debug APK the emulator suite installs: the native web build WITH the e2e test hook
# (window.__inkstone, see vite.config.ts → INKSTONE_E2E_HOOK), synced into the Capacitor project.
#
#   ./build-apk.sh                 vite build --mode native + cap sync + gradlew assembleDebug
#
# Extra Gradle arguments come from INKSTONE_GRADLE_ARGS (e.g. an --init-script for a Maven
# mirror). Release builds never set INKSTONE_E2E_HOOK, so they carry no test hook.
set -euo pipefail
source "$(dirname "$0")/env.sh"

cd "$WEB_DIR"
INKSTONE_E2E_HOOK=1 npx vite build --mode native
npx cap sync android
cd android
# shellcheck disable=SC2086
./gradlew --no-daemon ${INKSTONE_GRADLE_ARGS:-} assembleDebug
log "built $APK"
