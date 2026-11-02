#!/usr/bin/env bash
# Boots the Inkstone test AVD headless and waits until Android reports boot completed.
#
#   ./boot.sh             boot (from the quick-boot snapshot when one exists), wait up to 60 min
#   ./boot.sh --cold      ignore snapshots (cold boot), still saves one on a clean shutdown
#   ./boot.sh --no-wait   start the emulator and return immediately
#
# Without /dev/kvm the emulator runs the x86_64 guest with QEMU's software CPU (TCG, -accel off).
# It warns "x86_64 emulation may not work without hardware acceleration" but does work; a cold
# boot of the API 33 ATD image takes roughly 10–25 minutes on 2 cores, a snapshot boot a few.
# The emulator log goes to $ARTIFACTS/emulator.log.
set -euo pipefail
source "$(dirname "$0")/env.sh"

COLD=0; WAIT=1; TIMEOUT_MIN="${INKSTONE_BOOT_TIMEOUT_MIN:-60}"
for arg in "$@"; do
  case "$arg" in
    --cold) COLD=1 ;;
    --no-wait) WAIT=0 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

[ -d "$HOME/.android/avd/$AVD_NAME.avd" ] || "$SCRIPT_DIR/create-avd.sh"
"$ADB" start-server >/dev/null 2>&1 || true

RUNNING_PID="$(pgrep -f "qemu-system.*-avd $AVD_NAME( |$)" | head -1 || true)"
if [ -n "$RUNNING_PID" ]; then
  # Possibly still booting ("offline" in adb devices): just wait for it.
  echo "$RUNNING_PID" >"$ARTIFACTS/emulator.pid"
  log "$AVD_NAME is already running (pid $RUNNING_PID)"
else
  ACCEL=(-accel auto)
  QEMU_EXTRA=()
  if [ ! -w /dev/kvm ]; then
    ACCEL=(-accel off)
    # Cap QEMU's translation cache (default: guest RAM / 4), see env.sh. Must be the last option.
    QEMU_EXTRA=(-qemu -tb-size "$TCG_TB_MB")
    log "no /dev/kvm: software CPU emulation (slow but works)"
  fi
  SNAP=()
  [ "$COLD" = 1 ] && SNAP=(-no-snapshot-load)
  # -audio none keeps the guest's audio device (so AudioTrack opens and the writing-sound path runs)
  # but discards the samples on the host. -no-audio would remove the device altogether.
  nohup "$EMULATOR" -avd "$AVD_NAME" -port "$EMU_PORT" \
    -no-window -no-boot-anim -audio none -gpu "$EMU_GPU" -feature -Vulkan "${ACCEL[@]}" \
    -cores "$AVD_CORES" -memory "$AVD_RAM_MB" -no-metrics "${SNAP[@]}" "${QEMU_EXTRA[@]}" \
    >"$ARTIFACTS/emulator.log" 2>&1 &
  echo $! >"$ARTIFACTS/emulator.pid"
  log "emulator started (pid $(cat "$ARTIFACTS/emulator.pid")), log: $ARTIFACTS/emulator.log"
fi

[ "$WAIT" = 1 ] || exit 0

START=$(date +%s)
DEADLINE=$((START + TIMEOUT_MIN * 60))
"$ADB" -s "$ANDROID_SERIAL" wait-for-device &
WAITER=$!
while kill -0 "$WAITER" 2>/dev/null; do
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then kill "$WAITER"; log "timed out waiting for adb"; exit 1; fi
  if [ -f "$ARTIFACTS/emulator.pid" ] && ! kill -0 "$(cat "$ARTIFACTS/emulator.pid")" 2>/dev/null; then
    kill "$WAITER" 2>/dev/null || true; log "emulator exited; see $ARTIFACTS/emulator.log"; tail -20 "$ARTIFACTS/emulator.log" >&2; exit 1
  fi
  sleep 5
done
log "adb connected after $(( $(date +%s) - START ))s; waiting for sys.boot_completed"
until [ "$("$ADB" -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then log "timed out after ${TIMEOUT_MIN} min"; exit 1; fi
  sleep 15
done
# boot_completed can stay set while system_server restarts (on a starved software-emulated guest it
# sometimes does once, shortly after boot), so also wait for the package manager to answer.
until "$ADB" shell pm path android 2>/dev/null | grep -q "package:"; do
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then log "package manager never came up"; exit 1; fi
  sleep 10
done
ELAPSED=$(( $(date +%s) - START ))
log "booted in ${ELAPSED}s ($("$ADB" shell getprop ro.build.version.release | tr -d '\r'), API $("$ADB" shell getprop ro.build.version.sdk | tr -d '\r'))"
echo "$ELAPSED" >"$ARTIFACTS/boot-seconds.txt"

# Make the emulator as quiet and deterministic as possible for UI tests.
"$ADB" shell settings put global window_animation_scale 0 || true
"$ADB" shell settings put global transition_animation_scale 0 || true
"$ADB" shell settings put global animator_duration_scale 0 || true
"$ADB" shell settings put system screen_off_timeout 2147483647 || true
"$ADB" shell svc power stayon true || true
"$ADB" shell input keyevent KEYCODE_WAKEUP || true
"$ADB" shell wm dismiss-keyguard 2>/dev/null || true

# Software emulation on a busy host is slow enough that background system processes miss ANR
# deadlines. When the network stack is killed for that, system_server deliberately crashes and the
# whole framework restarts ("Lost network stack"), failing whatever install or test was running.
# Rate-limiting that crash (a DeviceConfig flag; no effect on the app under test) keeps the
# framework up. Pinned so a config sync never resets it.
"$ADB" shell device_config set_sync_disabled_for_tests persistent >/dev/null 2>&1 || true
"$ADB" shell device_config put connectivity always_ratelimit_networkstack_crash true >/dev/null 2>&1 || true
# Install-time dex2oat of a 40 MB APK takes minutes under TCG; verify-only installs fast and the
# JIT compiles the hot paths as the app runs (needs the userdebug ATD/AOSP image's adb root).
if "$ADB" root >/dev/null 2>&1; then
  "$ADB" wait-for-device
  "$ADB" shell setprop pm.dexopt.install verify >/dev/null 2>&1 || true
fi

# Optionally save the booted state as the quick-boot snapshot right away (not only on a clean exit).
# Off by default: saving briefly needs about as much host memory again as the guest RAM, which is
# what got the emulator OOM-killed on a 6 GB machine shared with builds. With more memory, set
# INKSTONE_SAVE_SNAPSHOT=1 and later boots take a minute or two instead of four or five.
if [ "$ELAPSED" -gt 120 ] && [ "${INKSTONE_SAVE_SNAPSHOT:-0}" = 1 ]; then
  log "saving quick-boot snapshot"
  "$ADB" emu avd snapshot save default_boot >/dev/null 2>&1 || log "snapshot save failed (boots will be cold)"
fi
