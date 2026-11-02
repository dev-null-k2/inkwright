#!/usr/bin/env bash
# Drives the Inkstone app on the running emulator (or any adb device: set ANDROID_SERIAL).
#
#   ./app.sh install                 install the debug APK (env INKSTONE_APK to override)
#   ./app.sh launch                  (re)start app.inkstone and wait for its activity
#   ./app.sh stop                    force-stop the app
#   ./app.sh reset                   clear the app's data (fresh first run)
#   ./app.sh pid                     print the app's process id
#   ./app.sh screenshot NAME         save $ARTIFACTS/NAME.png (adb exec-out screencap)
#   ./app.sh theme light|dark        switch the system theme (the app follows it)
#   ./app.sh cdp                     forward the WebView's DevTools socket to localhost:$CDP_PORT
#                                    and print the CDP endpoint (Playwright connectOverCDP)
#   ./app.sh logcat-clear            empty the log buffers
#   ./app.sh logcat NAME             save the whole log to $ARTIFACTS/NAME.log and our tags,
#                                    crashes and ANRs to $ARTIFACTS/NAME.filtered.log
#   ./app.sh check-crashes NAME      fail if NAME.log shows a crash or ANR of app.inkstone
set -euo pipefail
source "$(dirname "$0")/env.sh"

cmd="${1:-}"; shift || true
case "$cmd" in
  install)
    [ -f "$APK" ] || { log "no APK at $APK; build it first (docs/TESTING.md)"; exit 1; }
    log "installing $APK"
    # -g grants runtime permissions up front so no dialog covers the app.
    "$ADB" install -r -g "$APK" >/dev/null
    ;;
  launch)
    "$ADB" shell am force-stop "$APP_ID" || true
    "$ADB" shell am start -W -n "$APP_ID/.MainActivity" | sed 's/^/  /' >&2
    # Wait for the WebView's DevTools socket: it appears once the page has started loading.
    for _ in $(seq 1 120); do
      PID="$("$ADB" shell pidof "$APP_ID" 2>/dev/null | tr -d '\r' || true)"
      if [ -n "$PID" ] && "$ADB" shell cat /proc/net/unix 2>/dev/null | grep -q "webview_devtools_remote_$PID"; then
        log "app running (pid $PID), WebView DevTools socket up"; exit 0
      fi
      sleep 2
    done
    log "app did not expose a WebView DevTools socket (is this a debug build?)"; exit 1
    ;;
  stop) "$ADB" shell am force-stop "$APP_ID" ;;
  reset) "$ADB" shell pm clear "$APP_ID" >/dev/null ;;
  pid) "$ADB" shell pidof "$APP_ID" | tr -d '\r' ;;
  screenshot)
    NAME="${1:?screenshot NAME}"
    "$ADB" exec-out screencap -p >"$ARTIFACTS/$NAME.png"
    log "saved $ARTIFACTS/$NAME.png"
    ;;
  theme)
    case "${1:-}" in
      dark) "$ADB" shell cmd uimode night yes >/dev/null ;;
      light) "$ADB" shell cmd uimode night no >/dev/null ;;
      *) echo "theme light|dark" >&2; exit 2 ;;
    esac
    ;;
  cdp)
    PID="$("$ADB" shell pidof "$APP_ID" | tr -d '\r')"
    [ -n "$PID" ] || { log "app is not running"; exit 1; }
    "$ADB" forward --remove "tcp:$CDP_PORT" 2>/dev/null || true
    "$ADB" forward "tcp:$CDP_PORT" "localabstract:webview_devtools_remote_$PID" >/dev/null
    for _ in $(seq 1 30); do
      if curl -sf --noproxy '*' "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; then
        echo "http://127.0.0.1:$CDP_PORT"; exit 0
      fi
      sleep 1
    done
    log "CDP endpoint did not answer on port $CDP_PORT"; exit 1
    ;;
  logcat-clear) "$ADB" logcat -b all -c || "$ADB" logcat -c ;;
  logcat)
    NAME="${1:?logcat NAME}"
    "$ADB" logcat -b main -b system -b crash -b events -d -v threadtime >"$ARTIFACTS/$NAME.log" || true
    grep -E "$LOG_TAGS_RE" "$ARTIFACTS/$NAME.log" >"$ARTIFACTS/$NAME.filtered.log" || true
    log "saved $ARTIFACTS/$NAME.log ($(wc -l <"$ARTIFACTS/$NAME.log") lines; $(wc -l <"$ARTIFACTS/$NAME.filtered.log") ours/crash)"
    ;;
  check-crashes)
    NAME="${1:?check-crashes NAME}"
    LOGF="$ARTIFACTS/$NAME.log"
    # Java crashes print "Process: app.inkstone, PID: n" under FATAL EXCEPTION; native ones end
    # "pid n (app.inkstone)"; the events buffer records am_crash / am_anr.
    if grep -E "Process: $APP_ID, PID|am_crash.*$APP_ID|am_anr.*$APP_ID|ANR in $APP_ID|Fatal signal.*\($APP_ID\)" "$LOGF"; then
      log "crash or ANR found in $LOGF"; exit 1
    fi
    log "no crash or ANR of $APP_ID in $LOGF"
    ;;
  *) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
