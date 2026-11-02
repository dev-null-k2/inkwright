/**
 * Device check: the analysis half. Turns raw measurements taken on a real device (pointer
 * samples, frame times, layout boxes, environment facts) into numbers and a plain-text report
 * someone can paste into a bug report. No DOM here, so every rule is unit-tested; the measuring
 * lives in probe.ts and the screen in DeviceCheck.tsx.
 */

// ---- Statistics ----------------------------------------------------------------------------------

/** Value at quantile q (0..1) of the samples, by linear interpolation; NaN for none. */
export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const mean = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

/** Differences between consecutive values (e.g. timestamps to intervals). */
export const diffs = (v: readonly number[]) => v.slice(1).map((x, i) => x - v[i]!);

const round = (x: number, digits = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : null);

// ---- Pointer input -------------------------------------------------------------------------------

/** One dispatched pointermove (or down), with what the browser told us about it. */
export interface PointerSample {
  /** event.timeStamp (ms, same clock as performance.now()). */
  t: number;
  pointerType: string;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  /** PointerEvent.altitudeAngle when the browser has it (undefined otherwise). */
  altitude?: number;
  width: number;
  height: number;
  /** getCoalescedEvents().length, or -1 when the method does not exist. */
  coalesced: number;
  /** getPredictedEvents().length, or -1 when the method does not exist. */
  predicted: number;
}

export interface InputAnalysis {
  samples: number;
  pointerTypes: string[];
  /** Dispatched events per second while the pointer was moving. */
  eventRateHz: number | null;
  /** Hardware samples per second (dispatched plus coalesced). */
  sampleRateHz: number | null;
  coalescedSupported: boolean;
  /** Fraction of events that carried more than one coalesced sample. */
  coalescedShare: number | null;
  predictedSupported: boolean;
  /** Whether predicted events actually arrived (some browsers have the method but return none). */
  predictedSeen: boolean;
  pressure: { available: boolean; min: number | null; max: number | null };
  tilt: { available: boolean; maxDeg: number | null };
  twist: { available: boolean };
  contactSize: { available: boolean };
}

/**
 * What the pointer told us while someone drew on the pad. Gaps over 100 ms (between strokes) are
 * left out of the rates, so pauses do not drag them down.
 */
export function analyzeInput(samples: readonly PointerSample[]): InputAnalysis {
  let totalMs = 0, events = 0, hardware = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]!.t - samples[i - 1]!.t;
    if (d <= 0 || d >= 100) continue;
    totalMs += d;
    events++;
    // Each dispatched event stands for one or more hardware samples since the previous one.
    hardware += Math.max(1, samples[i]!.coalesced);
  }
  const pressures = samples.map((s) => s.pressure).filter((p) => p > 0);
  // Browsers report 0.5 for every "pressed" sample when the hardware has no pressure.
  const pressureVaries = pressures.length > 2 && Math.max(...pressures) - Math.min(...pressures) > 0.02;
  const tilts = samples.map((s) => Math.max(Math.abs(s.tiltX), Math.abs(s.tiltY)));
  const tiltSeen = tilts.some((t) => t > 0) || samples.some((s) => s.altitude != null && Math.abs(s.altitude - Math.PI / 2) > 0.01);
  return {
    samples: samples.length,
    pointerTypes: [...new Set(samples.map((s) => s.pointerType))],
    eventRateHz: totalMs > 0 ? round((events / totalMs) * 1000, 0) : null,
    sampleRateHz: totalMs > 0 ? round((hardware / totalMs) * 1000, 0) : null,
    coalescedSupported: samples.some((s) => s.coalesced >= 0),
    coalescedShare: samples.length ? round(samples.filter((s) => s.coalesced > 1).length / samples.length, 2) : null,
    predictedSupported: samples.some((s) => s.predicted >= 0),
    predictedSeen: samples.some((s) => s.predicted > 0),
    pressure: { available: pressureVaries, min: pressures.length ? round(Math.min(...pressures), 3) : null, max: pressures.length ? round(Math.max(...pressures), 3) : null },
    tilt: { available: tiltSeen, maxDeg: tilts.length ? round(Math.max(...tilts), 0) : null },
    twist: { available: samples.some((s) => s.twist !== 0) },
    contactSize: { available: samples.some((s) => s.width > 1 || s.height > 1) },
  };
}

// ---- Latency and frames --------------------------------------------------------------------------

export interface LatencyAnalysis {
  /** Input timestamp to the start of the next frame (requestAnimationFrame), ms. */
  toFrame: { median: number | null; p95: number | null };
  /** Input timestamp to just after that frame was produced (an estimate of when it is painted), ms. */
  toPaint: { median: number | null; p95: number | null };
  count: number;
}

/** `pairs` are [input timestamp, next frame start, after-paint time] in ms on one clock. */
export function analyzeLatency(pairs: readonly [number, number, number][]): LatencyAnalysis {
  // A negative or huge value means clocks disagreed (some WebViews) or the tab was in the background.
  const frame = pairs.map(([i, f]) => f - i).filter((d) => d >= 0 && d < 500);
  const paint = pairs.map(([i, , p]) => p - i).filter((d) => d >= 0 && d < 500);
  return {
    toFrame: { median: round(quantile(frame, 0.5)), p95: round(quantile(frame, 0.95)) },
    toPaint: { median: round(quantile(paint, 0.5)), p95: round(quantile(paint, 0.95)) },
    count: paint.length,
  };
}

export interface FrameAnalysis {
  frames: number;
  /** Estimated display refresh rate from the typical frame interval, Hz. */
  refreshHz: number | null;
  intervalMs: { median: number | null; p95: number | null; max: number | null };
  /** Frames that took more than 1.5 typical intervals (a skipped or late frame). */
  longFrames: number;
  /** Share of frames that were on time. */
  smooth: number | null;
}

/**
 * Intervals between consecutive frames (requestAnimationFrame timestamps) while the pen was down;
 * the pauses between strokes are not intervals.
 */
export function analyzeFrames(intervals: readonly number[]): FrameAnalysis {
  const iv = intervals.filter((d) => d > 0 && d < 1000);
  const median = quantile(iv, 0.5);
  const long = iv.filter((d) => d > median * 1.5).length;
  return {
    frames: iv.length,
    refreshHz: Number.isFinite(median) ? snapRefresh(1000 / median) : null,
    intervalMs: { median: round(median), p95: round(quantile(iv, 0.95)), max: round(iv.length ? Math.max(...iv) : NaN) },
    longFrames: long,
    smooth: iv.length ? round(1 - long / iv.length, 2) : null,
  };
}

/** Displays run at a handful of rates; report the nearest common one when the estimate is close. */
export function snapRefresh(hz: number): number {
  const common = [30, 48, 50, 60, 72, 75, 90, 96, 100, 120, 144, 165, 240];
  const near = common.find((c) => Math.abs(c - hz) / c < 0.06);
  return near ?? Math.round(hz);
}

// ---- Layout fit ----------------------------------------------------------------------------------

export interface Insets { top: number; right: number; bottom: number; left: number }

export interface BoxToCheck {
  name: string;
  top: number; right: number; bottom: number; left: number;
  /** scrollHeight > clientHeight, and whether it (or an ancestor overlay) scrolls. */
  overflows: boolean;
  scrolls: boolean;
  /** Bottom sheets extend under the gesture bar on purpose (their content is padded). */
  sheet?: boolean;
}

/**
 * The same rules as e2e/fit.spec.ts, applied to what is on this device's screen: overlays stay
 * between the system bars and inside the sides, and content taller than its box can be scrolled.
 */
export function checkFit(boxes: readonly BoxToCheck[], viewport: { width: number; height: number }, insets: Insets): string[] {
  const out: string[] = [];
  for (const b of boxes) {
    if (b.top < insets.top - 1) out.push(`${b.name}: top ${Math.round(b.top)} is under the status bar (${insets.top})`);
    if (!b.sheet && b.bottom > viewport.height - insets.bottom + 1) out.push(`${b.name}: bottom ${Math.round(b.bottom)} is under the gesture bar (${Math.round(viewport.height - insets.bottom)})`);
    if (b.left < -1 || b.right > viewport.width + 1) out.push(`${b.name}: off the side (${Math.round(b.left)}–${Math.round(b.right)} of ${viewport.width})`);
    if (b.overflows && !b.scrolls) out.push(`${b.name}: content is cut off and does not scroll`);
  }
  return out;
}

// ---- The report ----------------------------------------------------------------------------------

export interface DeviceFacts {
  app: { version: string; platform: string; build: string };
  browser: { userAgent: string; brands?: string; platform?: string; platformVersion?: string; model?: string; mobile?: boolean };
  screen: { devicePixelRatio: number; viewport: { width: number; height: number }; visualViewport?: { width: number; height: number; scale: number }; screen: { width: number; height: number }; orientation?: string };
  /** System bars as the browser reports them (env()) and as Capacitor injects them (--safe-area-inset-*). */
  safeArea: { env: Insets; capacitor: Insets; used: Insets };
  hardware: { cores: number | null; memoryGb: number | null; touchPoints: number; storage?: { usedMb: number; quotaMb: number; persisted: boolean | null } };
  graphics: { webgpu: string; webgl: string };
  audio: { outputLatencyMs: number | null; baseLatencyMs: number | null; sampleRate: number | null; state: string };
  native?: Record<string, boolean | string>;
}

export interface DeviceReport {
  createdAt: string;
  facts: DeviceFacts;
  input: InputAnalysis | null;
  latency: LatencyAnalysis | null;
  frames: FrameAnalysis | null;
  fit: { problems: string[]; checked: number };
}

const yes = (b: boolean) => (b ? 'yes' : 'no');
const ms = (x: number | null) => (x == null ? 'n/a' : `${x} ms`);
const insetText = (i: Insets) => `top ${i.top}, right ${i.right}, bottom ${i.bottom}, left ${i.left}`;

/** The report as plain text: short labelled lines, the way people paste it into an issue. */
export function reportText(r: DeviceReport): string {
  const f = r.facts;
  const lines: string[] = [];
  const add = (label: string, value: string) => lines.push(`${label}: ${value}`);
  lines.push(`Inkwright device check · ${r.createdAt}`, '');
  lines.push('App');
  add('  Version', `${f.app.version} (${f.app.platform}, ${f.app.build})`);
  lines.push('Browser');
  add('  Engine', f.browser.brands ?? 'n/a');
  if (f.browser.model || f.browser.platform) add('  Device', [f.browser.model, f.browser.platform, f.browser.platformVersion].filter(Boolean).join(' · '));
  add('  User agent', f.browser.userAgent);
  lines.push('Screen');
  add('  Pixel ratio', String(f.screen.devicePixelRatio));
  add('  Viewport', `${f.screen.viewport.width} × ${f.screen.viewport.height} CSS px${f.screen.orientation ? ` (${f.screen.orientation})` : ''}`);
  if (f.screen.visualViewport) add('  Visual viewport', `${f.screen.visualViewport.width} × ${f.screen.visualViewport.height} at ${f.screen.visualViewport.scale}×`);
  add('  Screen', `${f.screen.screen.width} × ${f.screen.screen.height}`);
  add('  Safe area (browser)', insetText(f.safeArea.env));
  add('  Safe area (app)', insetText(f.safeArea.capacitor));
  add('  Safe area used', insetText(f.safeArea.used));
  lines.push('Hardware');
  add('  Cores', f.hardware.cores == null ? 'n/a' : String(f.hardware.cores));
  add('  Memory', f.hardware.memoryGb == null ? 'n/a' : `${f.hardware.memoryGb} GB or more`);
  add('  Touch points', String(f.hardware.touchPoints));
  if (f.hardware.storage) add('  Storage', `${f.hardware.storage.usedMb} MB used of ${f.hardware.storage.quotaMb} MB${f.hardware.storage.persisted == null ? '' : f.hardware.storage.persisted ? ', kept' : ', may be cleared'}`);
  add('  WebGPU', f.graphics.webgpu);
  add('  WebGL', f.graphics.webgl);
  add('  Audio', `output ${ms(f.audio.outputLatencyMs)}, base ${ms(f.audio.baseLatencyMs)}${f.audio.sampleRate ? `, ${f.audio.sampleRate} Hz` : ''} (${f.audio.state})`);
  if (f.native) add('  Android app', Object.entries(f.native).map(([k, v]) => `${k} ${typeof v === 'boolean' ? yes(v) : v}`).join(', '));
  lines.push('Pen and touch');
  if (!r.input || r.input.samples < 2) lines.push('  Not measured: draw on the test pad first.');
  else {
    const i = r.input;
    add('  Pointer', i.pointerTypes.join(', '));
    add('  Events', `${i.eventRateHz ?? 'n/a'} per second`);
    add('  Samples', `${i.sampleRateHz ?? 'n/a'} per second (coalesced: ${yes(i.coalescedSupported)}${i.coalescedShare != null ? `, in ${Math.round(i.coalescedShare * 100)}% of events` : ''})`);
    add('  Predicted events', i.predictedSupported ? (i.predictedSeen ? 'yes' : 'supported, none sent') : 'no');
    add('  Pressure', i.pressure.available ? `yes (${i.pressure.min}–${i.pressure.max})` : 'no');
    add('  Tilt', i.tilt.available ? `yes (up to ${i.tilt.maxDeg}°)` : 'no');
    add('  Twist', yes(i.twist.available));
    add('  Contact size', yes(i.contactSize.available));
  }
  if (r.latency && r.latency.count) {
    add('  Input to next frame', `${ms(r.latency.toFrame.median)} median, ${ms(r.latency.toFrame.p95)} at worst (95%)`);
    add('  Input to paint (estimate)', `${ms(r.latency.toPaint.median)} median, ${ms(r.latency.toPaint.p95)} at worst (95%)`);
  }
  if (r.frames && r.frames.frames) {
    add('  Frames while drawing', `${r.frames.refreshHz ?? 'n/a'} Hz, ${ms(r.frames.intervalMs.median)} typical, ${ms(r.frames.intervalMs.p95)} at 95%, ${r.frames.longFrames} late of ${r.frames.frames}`);
  }
  lines.push('Layout');
  if (!r.fit.problems.length) add('  Fit', `everything fits between the system bars (${r.fit.checked} checked)`);
  else for (const p of r.fit.problems) lines.push(`  Problem: ${p}`);
  return lines.join('\n');
}

/** The report as JSON (stable keys, for tools and for comparing devices). */
export const reportJson = (r: DeviceReport): string => JSON.stringify(r, null, 2);
