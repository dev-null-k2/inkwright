# Shared settings for the Android emulator scripts (sourced, not run).
#
# Every value can be overridden from the environment, e.g.
#   INKWRIGHT_AVD_IMAGE="system-images;android-34;google_apis;x86_64" ./create-avd.sh
#
# The defaults are chosen for machines WITHOUT hardware virtualisation (no /dev/kvm: CI containers,
# cloud VMs): the AOSP "ATD" (automated test device) image is the leanest API >= 29 image and boots
# fastest under QEMU's software CPU emulation (TCG). See docs/TESTING.md → "Android emulator".

export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"

AVD_NAME="${INKWRIGHT_AVD:-inkwright-atd33}"
AVD_IMAGE="${INKWRIGHT_AVD_IMAGE:-system-images;android-33;aosp_atd;x86_64}"
# A Razr-Fold-like inner screen, scaled down: fewer pixels keeps software rendering responsive.
AVD_WIDTH="${INKWRIGHT_AVD_WIDTH:-1104}"
AVD_HEIGHT="${INKWRIGHT_AVD_HEIGHT:-1380}"
AVD_DENSITY="${INKWRIGHT_AVD_DENSITY:-240}"
# Memory: the emulator process needs roughly guest RAM + TCG translation cache + ~0.6 GB (software
# GPU, emulator). Its QEMU 2.12 core sizes the translation cache at guest RAM / 4 unless told
# otherwise, so both are kept small: on a machine with ~6 GB shared with builds, 1024 MB + 128 MB keeps
# the whole emulator near 1.7 GB. Android 13 ATD (a Go-class footprint) runs the app fine in that.
AVD_RAM_MB="${INKWRIGHT_AVD_RAM_MB:-1024}"
TCG_TB_MB="${INKWRIGHT_TCG_TB_MB:-128}"
AVD_CORES="${INKWRIGHT_AVD_CORES:-2}"
# Emulator GPU mode: swiftshader_indirect (host-side software GL) or guest (software GL in the guest).
EMU_GPU="${INKWRIGHT_EMU_GPU:-swiftshader_indirect}"

# Console port 5554 → serial emulator-5554.
EMU_PORT="${INKWRIGHT_EMU_PORT:-5554}"
export ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-$EMU_PORT}"

APP_ID="app.inkwright"
APK="${INKWRIGHT_APK:-$WEB_DIR/android/app/build/outputs/apk/debug/app-debug.apk}"
ARTIFACTS="${INKWRIGHT_ANDROID_ARTIFACTS:-$WEB_DIR/test-artifacts/android}"
# Host port the WebView's DevTools socket is forwarded to (Playwright connects over CDP here).
CDP_PORT="${INKWRIGHT_CDP_PORT:-9333}"

# Log tags the scripts filter for: our native code plus crash/ANR reporters.
LOG_TAGS_RE='Inkwright|InkwrightNative|InkwrightFeel|InkwrightInkTip|InkwrightRecognizer|AndroidRuntime|FATAL|ANR|am_anr|am_crash|chromium|Capacitor'

mkdir -p "$ARTIFACTS"

log() { printf '[android %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
