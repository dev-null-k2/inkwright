#!/usr/bin/env bash
# Installs the emulator + system image (if missing) and creates the Inkwright test AVD.
#
#   ./create-avd.sh            create (or recreate) the AVD from env.sh settings
#
# Works without /dev/kvm: the AVD is tuned for software emulation (small screen, no camera, no
# microphone, swiftshader GPU) so it boots in minutes rather than hours.
set -euo pipefail
source "$(dirname "$0")/env.sh"

[ -x "$EMULATOR" ] || { log "installing the emulator package"; yes | "$SDKMANAGER" --install emulator >/dev/null; }

IMAGE_DIR="$ANDROID_HOME/$(echo "$AVD_IMAGE" | tr ';' '/')"
if [ ! -f "$IMAGE_DIR/system.img" ]; then
  log "installing $AVD_IMAGE"
  yes | "$SDKMANAGER" --install "$AVD_IMAGE" >/dev/null
fi

log "creating AVD $AVD_NAME from $AVD_IMAGE"
echo no | "$AVDMANAGER" create avd -n "$AVD_NAME" -k "$AVD_IMAGE" -d medium_tablet --force >/dev/null

CONFIG="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
set_cfg() {
  if grep -q "^$1=" "$CONFIG"; then sed -i "s|^$1=.*|$1=$2|" "$CONFIG"; else echo "$1=$2" >>"$CONFIG"; fi
}
set_cfg hw.lcd.width "$AVD_WIDTH"
set_cfg hw.lcd.height "$AVD_HEIGHT"
set_cfg hw.lcd.density "$AVD_DENSITY"
set_cfg hw.ramSize "${AVD_RAM_MB}M"
set_cfg hw.cpu.ncore "$AVD_CORES"
set_cfg hw.gpu.enabled yes
set_cfg hw.gpu.mode swiftshader_indirect
set_cfg hw.audioInput no
set_cfg hw.audioOutput yes
set_cfg hw.camera.back none
set_cfg hw.camera.front none
set_cfg hw.keyboard yes
set_cfg vm.heapSize 256M
set_cfg disk.dataPartition.size 4G
set_cfg showDeviceFrame no
# Snapshots save minutes on later boots (see boot.sh --snapshot).
set_cfg fastboot.forceColdBoot no
log "AVD ready: $CONFIG"
