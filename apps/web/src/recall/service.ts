/**
 * The memory timeline's background work, started by its module (modules/builtin.ts):
 *
 * - **Everywhere:** loads the shared settings and deletes captures older than the retention
 *   period (on start and every six hours), so a phone that only shows synced captures prunes too.
 * - **Desktop app, when capture is on for this device:** the capture loop. Every few seconds it
 *   asks the shell which window is in front (cheap); when the rules allow (packages/core recall
 *   `shouldCapture`) and it is time (`nextDelayMs`), it grabs that window, skips frames that
 *   didn't change (`frameDifference`), recognises the text on this device (ocr.ts), redacts it
 *   (`redactCapture`, the trust layer's privacy firewall) and only then writes it to the vault.
 *   Pixels are never stored. Optionally the microphone is transcribed the same way (mic.ts).
 */
import {
  CHANGE_FRACTION,
  RECALL_DIR,
  frameDifference,
  initialPace,
  nextDelayMs,
  recordLook,
  shouldCapture,
  switchedWindow,
  SWITCH_POLL_MS,
  type Capture,
  type ForegroundWindow,
  type FrameSignature,
  type PaceState,
} from '@inkwright/core';
import { isRepeat, redactCapture } from '@inkwright/ai';
import { useApp } from '../state/app.ts';
import { onVaultChanged } from '../lib/vaultChanges.ts';
import { bytesOf, invoke, isDesktop } from '../desktop/bridge.ts';
import { bumpRecall, isPaused, loadRecallConfig, recallStore, useRecall } from './state.ts';
import type { AppVault } from '../lib/vault.ts';

interface Probe {
  window: ForegroundWindow | null;
  idleSec: number | null;
  locked: boolean;
  secureInput: boolean;
  canDetectSecureInput: boolean;
  permitted: boolean;
  wayland: boolean;
  platform: string;
}

/** Parses the shell's frame: `[sigW, sigH, imgW, imgH]` (u32 LE), signature, grayscale image. */
export function parseFrame(bytes: Uint8Array): { sig: FrameSignature; gray: Uint8Array; width: number; height: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sw = dv.getUint32(0, true), sh = dv.getUint32(4, true), iw = dv.getUint32(8, true), ih = dv.getUint32(12, true);
  const sigEnd = 16 + sw * sh;
  if (bytes.length < sigEnd + iw * ih) throw new Error('Truncated frame from the desktop app');
  return { sig: { width: sw, height: sh, cells: bytes.subarray(16, sigEnd) }, gray: bytes.subarray(sigEnd, sigEnd + iw * ih), width: iw, height: ih };
}

const PRUNE_EVERY_MS = 6 * 3_600_000;

/** Deletes captures past the retention period (any platform). */
export async function pruneRecall(vault: AppVault, now = Date.now()): Promise<void> {
  const config = await loadRecallConfig(vault);
  const r = await recallStore(vault).prune(now, config.retentionDays);
  if (r.days || r.captures) bumpRecall();
}

/** Writes captures (already redacted) and tells open views. */
async function store(vault: AppVault, cs: Capture[]): Promise<void> {
  if (!cs.length) return;
  await recallStore(vault).append(cs);
  bumpRecall();
}

// ---- The capture loop (desktop) --------------------------------------------------------------------

class CaptureLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private busy = false;
  private pace: PaceState = initialPace();
  private lastSig: FrameSignature | null = null;
  private lastStored: Capture | null = null;
  private dueAt = 0;

  constructor(private vault: AppVault) {}

  start() {
    useRecall.setState({ status: { kind: 'starting' } });
    this.dueAt = 0;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      await this.look();
    } catch (e) {
      useRecall.setState({ status: { kind: 'error', message: (e as Error)?.message ?? String(e) } });
    } finally {
      this.busy = false;
      this.schedule(SWITCH_POLL_MS);
    }
  }

  private async look() {
    const s = useRecall.getState();
    const probe = await invoke<Probe>('recall_probe');
    if (probe.wayland) {
      useRecall.setState({ status: { kind: 'unsupported', why: 'Wayland does not let apps see or capture other windows. Log in to an X11 session to use capture.' } });
      return;
    }
    if (!probe.permitted) {
      useRecall.setState({ status: { kind: 'needs-permission' } });
      return;
    }
    const now = Date.now();
    const decision = shouldCapture({ now, window: probe.window, idleSec: probe.idleSec ?? 0, locked: probe.locked, secureInput: probe.secureInput, pausedUntil: s.pausedUntil, config: s.config });
    if (!decision.capture) {
      useRecall.setState({ status: { kind: 'skipped', reason: decision.reason } });
      return;
    }
    // Between looks: only look early when the user switched windows.
    if (now < this.dueAt && !switchedWindow(this.pace, probe.window)) return;
    const frame = parseFrame(bytesOf(await invoke<ArrayBuffer>('recall_grab')));
    const switched = switchedWindow(this.pace, probe.window);
    const changed = switched || frameDifference(this.lastSig, frame.sig) > CHANGE_FRACTION;
    this.pace = recordLook(this.pace, probe.window, changed);
    this.dueAt = Date.now() + nextDelayMs(this.pace, s.config.intervalSec, probe.window);
    if (!changed) {
      useRecall.setState({ status: { kind: 'capturing', at: this.lastStored?.at ?? null } });
      return;
    }
    this.lastSig = { ...frame.sig, cells: frame.sig.cells.slice() };
    const { recognize, grayToCanvas, OCR_ENGINE_ID } = await import('./ocr.ts');
    const text = await recognize(grayToCanvas(frame.gray, frame.width, frame.height));
    if (this.stopped) return;
    const c = redactCapture({ at: now, kind: 'screen', app: probe.window!.app, title: probe.window!.title, text, engine: OCR_ENGINE_ID, device: s.deviceId });
    if (c && !isRepeat(this.lastStored, c)) {
      await store(this.vault, [c]);
      this.lastStored = c;
    }
    useRecall.setState({ status: { kind: 'capturing', at: this.lastStored?.at ?? null } });
  }
}

// ---- Service -------------------------------------------------------------------------------------

export function startRecall(): () => void {
  const vault = useApp.getState().vault;
  if (!vault) return () => {};
  let loop: CaptureLoop | null = null;
  let mic: { stop(): Promise<void> } | null = null;
  let micStarting = false;
  let alive = true;

  const tray = (value: 'on' | 'paused' | 'off') => { if (isDesktop) void invoke('recall_tray_state', { value }).catch(() => {}); };

  const reconcile = () => {
    if (!alive) return;
    const s = useRecall.getState();
    const want = isDesktop && s.capture && s.configLoaded;
    const paused = isPaused(s);
    if (want && !loop) {
      loop = new CaptureLoop(vault);
      loop.start();
    } else if (!want && loop) {
      loop.stop();
      loop = null;
      void import('./ocr.ts').then((m) => m.stopOcr());
      useRecall.setState({ status: { kind: 'off' } });
    }
    tray(!want ? 'off' : paused ? 'paused' : 'on');
    // The microphone follows capture, the shared setting and pauses.
    const wantMic = want && s.config.microphone && !paused;
    if (wantMic && !mic && !micStarting) {
      micStarting = true;
      void import('./mic.ts').then((m) => m.startMicTranscription(
        (segs) => void store(vault, segs.map((g) => redactCapture({ at: g.at, end: g.end, kind: 'audio', text: g.text, engine: g.engine, device: s.deviceId })).filter((c): c is Capture => !!c)),
        (msg) => useApp.getState().fail(`Memory timeline microphone: ${msg}`),
      )).then((session) => {
        micStarting = false;
        if (!alive || !useRecall.getState().capture) { void session.stop(); return; }
        mic = session;
        useRecall.setState({ listening: true });
      }).catch((e) => {
        micStarting = false;
        useRecall.setState({ listening: false });
        useApp.getState().fail((e as Error)?.message ?? String(e));
      });
    } else if (!wantMic && mic) {
      const m = mic;
      mic = null;
      useRecall.setState({ listening: false });
      void m.stop();
    }
  };

  void pruneRecall(vault).catch((e) => console.warn('Memory timeline: pruning failed', e)).finally(reconcile);
  const pruneTimer = setInterval(() => void pruneRecall(vault).catch(() => {}), PRUNE_EVERY_MS);
  // A pause ends on its own: look again when it does.
  const pauseTimer = setInterval(() => { const p = useRecall.getState().pausedUntil; if (p != null && Date.now() >= p) useRecall.getState().setLocal({ pausedUntil: null }); }, 15_000);
  const unsub = useRecall.subscribe((s, prev) => {
    if (s.capture !== prev.capture || s.pausedUntil !== prev.pausedUntil || s.config !== prev.config || s.configLoaded !== prev.configLoaded) reconcile();
  });
  const onTray = (e: Event) => {
    const cmd = (e as CustomEvent<string>).detail;
    if (cmd === 'timeline') void import('./ui.ts').then((m) => m.openTimeline());
    if (cmd === 'recall-pause') togglePause();
  };
  window.addEventListener('inkwright:tray', onTray);
  // Another device changed the shared settings (an app excluded, retention) or sent captures and
  // erasures: apply the settings now and let open views reload.
  const stopChanges = onVaultChanged((paths) => {
    if (!paths.some((p) => p === '' || p === RECALL_DIR || p.startsWith(`${RECALL_DIR}/`))) return;
    void loadRecallConfig(vault).then(bumpRecall, (e) => console.warn('Memory timeline: reloading settings failed', e));
  });

  return () => {
    alive = false;
    stopChanges();
    clearInterval(pruneTimer);
    clearInterval(pauseTimer);
    unsub();
    window.removeEventListener('inkwright:tray', onTray);
    loop?.stop();
    loop = null;
    void mic?.stop();
    mic = null;
    useRecall.setState({ status: { kind: 'off' }, listening: false });
    tray('off');
    void import('./ocr.ts').then((m) => m.stopOcr());
  };
}

/** Pauses capture for an hour, or resumes it. */
export function togglePause(hours = 1): void {
  const s = useRecall.getState();
  s.setLocal({ pausedUntil: isPaused(s) ? null : Date.now() + hours * 3_600_000 });
}
