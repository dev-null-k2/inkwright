/**
 * Device check: the measuring half. Everything here asks the real browser or WebView — what it
 * reports about the screen, the system bars, the hardware, graphics and audio — and records pen
 * input and frame timing on the test pad. analysis.ts turns the recordings into numbers.
 *
 * Every probe is defensive: a missing API is a finding ("n/a"), never an error, because the
 * point is to run on whatever device someone has.
 */
import { APP_VERSION, BUILD_TARGET, isNative, nativePlatform } from '../platform/env.ts';
import { InkwrightNative, hasNativePlugin } from '../platform/native.ts';
import type { BoxToCheck, DeviceFacts, Insets, PointerSample } from './analysis.ts';

const px = (v: string) => Math.round(parseFloat(v) || 0);

/**
 * The system bars, read three ways: env(safe-area-inset-*) as the browser computes it, the
 * --safe-area-inset-* variables Capacitor injects on Android edge to edge, and --safe-* (the
 * larger of the two, which the layout uses).
 */
export function readSafeArea(): DeviceFacts['safeArea'] {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
    + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);'
    + 'margin:var(--safe-top,0px) var(--safe-right,0px) var(--safe-bottom,0px) var(--safe-left,0px);';
  document.body.appendChild(probe);
  const s = getComputedStyle(probe);
  const env: Insets = { top: px(s.paddingTop), right: px(s.paddingRight), bottom: px(s.paddingBottom), left: px(s.paddingLeft) };
  const used: Insets = { top: px(s.marginTop), right: px(s.marginRight), bottom: px(s.marginBottom), left: px(s.marginLeft) };
  probe.remove();
  const root = getComputedStyle(document.documentElement);
  const cap = (side: string) => px(root.getPropertyValue(`--safe-area-inset-${side}`));
  return { env, capacitor: { top: cap('top'), right: cap('right'), bottom: cap('bottom'), left: cap('left') }, used };
}

async function browserFacts(): Promise<DeviceFacts['browser']> {
  const out: DeviceFacts['browser'] = { userAgent: navigator.userAgent };
  const uad = (navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[]; mobile: boolean; platform: string; getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>> } }).userAgentData;
  if (!uad) return out;
  out.mobile = uad.mobile;
  out.platform = uad.platform;
  try {
    const h = await uad.getHighEntropyValues?.(['fullVersionList', 'platformVersion', 'model']);
    const list = (h?.fullVersionList as { brand: string; version: string }[] | undefined) ?? uad.brands;
    out.brands = list.filter((b) => !/Not.?A.?Brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(', ');
    if (h?.platformVersion) out.platformVersion = String(h.platformVersion);
    if (h?.model) out.model = String(h.model);
  } catch {
    out.brands = uad.brands.map((b) => `${b.brand} ${b.version}`).join(', ');
  }
  return out;
}

async function storageFacts(): Promise<DeviceFacts['hardware']['storage']> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return undefined;
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
    return { usedMb: Math.round((e.usage ?? 0) / 1048576), quotaMb: Math.round((e.quota ?? 0) / 1048576), persisted };
  } catch {
    return undefined;
  }
}

async function webgpuFacts(): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu;
  if (!gpu) return 'not available';
  try {
    const a = await gpu.requestAdapter();
    if (!a) return 'no adapter';
    const i = a.info;
    return ['available', i?.vendor, i?.architecture, i?.description].filter(Boolean).join(' · ');
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

function webglFacts(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'not available';
    const version = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'WebGL 2' : 'WebGL 1';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return `${version} · ${renderer}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

/**
 * Audio output latency: how long a sound takes from the app to the speaker. Matters for the
 * writing sound. Needs a running AudioContext, so call this from a tap.
 */
async function audioFacts(): Promise<DeviceFacts['audio']> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return { outputLatencyMs: null, baseLatencyMs: null, sampleRate: null, state: 'no Web Audio' };
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx({ latencyHint: 'interactive' });
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    // outputLatency is filled in once audio has been flowing for a moment.
    await new Promise((r) => setTimeout(r, 120));
    const out = typeof ctx.outputLatency === 'number' ? Math.round(ctx.outputLatency * 1000 * 10) / 10 : null;
    return { outputLatencyMs: out, baseLatencyMs: Math.round((ctx.baseLatency ?? NaN) * 1000 * 10) / 10 || null, sampleRate: ctx.sampleRate, state: ctx.state };
  } catch (e) {
    return { outputLatencyMs: null, baseLatencyMs: null, sampleRate: null, state: `error: ${(e as Error).message}` };
  } finally {
    void ctx?.close().catch(() => {});
  }
}

async function nativeFacts(): Promise<Record<string, boolean | string> | undefined> {
  if (!hasNativePlugin) return undefined;
  try {
    return { ...(await InkwrightNative.capabilities()) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Everything that does not need the person to draw. */
export async function collectFacts(): Promise<DeviceFacts> {
  const vv = window.visualViewport;
  const [browser, storage, webgpu, audio, native] = await Promise.all([browserFacts(), storageFacts(), webgpuFacts(), audioFacts(), nativeFacts()]);
  return {
    app: { version: APP_VERSION, platform: isNative ? `${nativePlatform} app` : 'web', build: BUILD_TARGET },
    browser,
    screen: {
      devicePixelRatio: Math.round(devicePixelRatio * 100) / 100,
      viewport: { width: innerWidth, height: innerHeight },
      ...(vv ? { visualViewport: { width: Math.round(vv.width), height: Math.round(vv.height), scale: Math.round(vv.scale * 100) / 100 } } : {}),
      screen: { width: screen.width, height: screen.height },
      ...(screen.orientation?.type ? { orientation: screen.orientation.type } : {}),
    },
    safeArea: readSafeArea(),
    hardware: {
      cores: navigator.hardwareConcurrency ?? null,
      memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
      touchPoints: navigator.maxTouchPoints ?? 0,
      ...(storage ? { storage } : {}),
    },
    graphics: { webgpu, webgl: webglFacts() },
    audio,
    ...(native ? { native } : {}),
  };
}

// ---- Layout fit ----------------------------------------------------------------------------------

/**
 * The boxes e2e/fit.spec.ts checks, as they are on this screen right now: open overlays (menus,
 * popovers, dialogs, the search palette) and the fixed chrome (top bars, the pen dock).
 */
export function collectFitBoxes(): BoxToCheck[] {
  const out: BoxToCheck[] = [];
  // Top bars reach under the status bar on purpose (their background does); what must sit below
  // it are their buttons and titles.
  for (const bar of document.querySelectorAll<HTMLElement>('.ed-top, .set-top, .lib-top')) {
    for (const el of bar.querySelectorAll<HTMLElement>('button, h1')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out.push({ name: `${bar.className.split(' ')[0]} ${el.getAttribute('aria-label') ?? el.tagName.toLowerCase()}`, top: r.top, right: r.right, bottom: r.bottom, left: r.left, overflows: false, scrolls: true });
    }
  }
  const sel = '.popover, .dialog, [role="menu"], .palette, .dock';
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (el.matches('[role="menu"]') && el.parentElement?.closest('.popover, .dialog')) continue;
    const oy = getComputedStyle(el).overflowY;
    const scrollParent = el.parentElement?.closest('.popover, .dialog');
    out.push({
      name: `${el.className || el.getAttribute('role')}`.split(' ')[0]!.slice(0, 40),
      top: r.top, right: r.right, bottom: r.bottom, left: r.left,
      overflows: el.scrollHeight > el.clientHeight + 2,
      scrolls: oy === 'auto' || oy === 'scroll' || !!scrollParent,
      sheet: el.classList.contains('is-sheet'),
    });
  }
  return out;
}

// ---- Pen input and frames on the test pad --------------------------------------------------------

type PE = PointerEvent & { getCoalescedEvents?: () => PointerEvent[]; getPredictedEvents?: () => PointerEvent[]; altitudeAngle?: number };

/**
 * Records what the pointer reports while someone draws on `pad`, the latency from each event to
 * the next frame (and to just after it), and the frame times while drawing. Also draws the ink so
 * there is something to see. Returns a stop function that hands back the recordings.
 */
export function recordPad(pad: HTMLCanvasElement, ink: string, onSample?: (n: number) => void) {
  const samples: PointerSample[] = [];
  const latency: [number, number, number][] = [];
  /** Frame intervals while the pen is down. */
  const frames: number[] = [];
  const ctx = pad.getContext('2d');
  let down = false;
  let last: { x: number; y: number } | null = null;
  let pending: number[] = [];
  let raf = 0;
  const channel = new MessageChannel();
  let afterPaint: { inputs: number[]; frame: number } | null = null;
  channel.port1.onmessage = () => {
    // Runs after the frame that drew the latest input was produced: close to when it reaches the screen.
    if (!afterPaint) return;
    const now = performance.now();
    for (const t of afterPaint.inputs) latency.push([t, afterPaint.frame, now]);
    afterPaint = null;
  };

  const fit = () => {
    const r = pad.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    pad.width = Math.round(r.width * dpr);
    pad.height = Math.round(r.height * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();

  let prevFrame: number | null = null;
  const tick = (ts: number) => {
    if (down && prevFrame != null) frames.push(ts - prevFrame);
    prevFrame = down ? ts : null;
    if (pending.length) {
      afterPaint = { inputs: pending, frame: ts };
      pending = [];
      channel.port2.postMessage(0);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const record = (e: PE) => {
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents().length : -1;
    const predicted = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents().length : -1;
    samples.push({ t: e.timeStamp, pointerType: e.pointerType, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, twist: e.twist, altitude: e.altitudeAngle, width: e.width, height: e.height, coalesced, predicted });
    pending.push(e.timeStamp);
    onSample?.(samples.length);
    // Ink, so drawing feels like drawing; through the coalesced points for a smooth line.
    if (!ctx) return;
    const r = pad.getBoundingClientRect();
    const pts = coalesced > 0 ? e.getCoalescedEvents!() : [e];
    ctx.strokeStyle = ink;
    ctx.lineCap = 'round';
    for (const p of pts) {
      const x = p.clientX - r.left, y = p.clientY - r.top;
      if (last) {
        ctx.lineWidth = 1 + 3 * (p.pressure || 0.5);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      last = { x, y };
    }
  };
  const onDown = (e: PointerEvent) => {
    down = true;
    last = null;
    try { pad.setPointerCapture(e.pointerId); } catch { /* not an active pointer (synthetic input) */ }
    record(e as PE);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => { if (down) record(e as PE); };
  const onUp = () => { down = false; last = null; };
  pad.addEventListener('pointerdown', onDown);
  pad.addEventListener('pointermove', onMove);
  pad.addEventListener('pointerup', onUp);
  pad.addEventListener('pointercancel', onUp);

  return {
    clear: () => { ctx?.clearRect(0, 0, pad.width, pad.height); samples.length = 0; latency.length = 0; frames.length = 0; onSample?.(0); },
    stop: () => {
      cancelAnimationFrame(raf);
      channel.port1.close();
      pad.removeEventListener('pointerdown', onDown);
      pad.removeEventListener('pointermove', onMove);
      pad.removeEventListener('pointerup', onUp);
      pad.removeEventListener('pointercancel', onUp);
    },
    results: () => ({ samples: [...samples], latency: [...latency], frames: [...frames] }),
  };
}
