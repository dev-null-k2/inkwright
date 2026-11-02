import { describe, expect, it } from 'vitest';
import { analyzeFrames, analyzeInput, analyzeLatency, checkFit, diffs, quantile, reportJson, reportText, snapRefresh, type DeviceReport, type PointerSample } from './analysis.ts';

/** A pen stroke: `n` events `every` ms apart, each standing for `coalesced` hardware samples. */
function stroke(n: number, every: number, opts: Partial<Omit<PointerSample, 'pressure'>> & { start?: number; pressure?: (i: number) => number } = {}): PointerSample[] {
  return Array.from({ length: n }, (_, i) => ({
    t: (opts.start ?? 0) + i * every,
    pointerType: opts.pointerType ?? 'pen',
    pressure: opts.pressure ? opts.pressure(i) : 0.5,
    tiltX: opts.tiltX ?? 0, tiltY: opts.tiltY ?? 0, twist: opts.twist ?? 0,
    width: opts.width ?? 1, height: opts.height ?? 1,
    coalesced: opts.coalesced ?? -1, predicted: opts.predicted ?? -1,
    ...(opts.altitude != null ? { altitude: opts.altitude } : {}),
  }));
}

describe('statistics', () => {
  it('interpolates quantiles and handles no data', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.95)).toBe(10);
    expect(quantile([], 0.5)).toBeNaN();
    expect(diffs([1, 4, 9])).toEqual([3, 5]);
  });

  it('snaps refresh estimates to common display rates', () => {
    expect(snapRefresh(1000 / 16.9)).toBe(60);
    expect(snapRefresh(1000 / 8.4)).toBe(120);
    expect(snapRefresh(1000 / 11.2)).toBe(90);
    expect(snapRefresh(37)).toBe(37);
  });
});

describe('pen input', () => {
  it('measures dispatched and hardware rates, leaving out the pauses between strokes', () => {
    // Two strokes at 120 events/s, each event carrying 2 coalesced samples (240 Hz digitizer), with a pause between.
    const s = [...stroke(60, 1000 / 120, { coalesced: 2 }), ...stroke(60, 1000 / 120, { coalesced: 2, start: 2000 })];
    const a = analyzeInput(s);
    expect(a.eventRateHz).toBe(120);
    expect(a.sampleRateHz).toBe(240);
    expect(a.coalescedSupported).toBe(true);
    expect(a.coalescedShare).toBe(1);
  });

  it('tells real pressure from the constant 0.5 browsers report without it', () => {
    expect(analyzeInput(stroke(30, 8)).pressure.available).toBe(false);
    const p = analyzeInput(stroke(30, 8, { pressure: (i) => 0.2 + i / 60 }));
    expect(p.pressure).toEqual({ available: true, min: 0.2, max: 0.683 });
  });

  it('notices tilt (or altitude), twist and contact size, and unsupported methods', () => {
    const flat = analyzeInput(stroke(10, 8));
    expect(flat.tilt.available).toBe(false);
    expect(flat.twist.available).toBe(false);
    expect(flat.contactSize.available).toBe(false);
    expect(flat.coalescedSupported).toBe(false);
    expect(flat.predictedSupported).toBe(false);
    expect(analyzeInput(stroke(10, 8, { tiltX: 32, tiltY: -12 })).tilt).toEqual({ available: true, maxDeg: 32 });
    expect(analyzeInput(stroke(10, 8, { altitude: 1.1 })).tilt.available).toBe(true);
    expect(analyzeInput(stroke(10, 8, { twist: 90 })).twist.available).toBe(true);
    expect(analyzeInput(stroke(10, 8, { pointerType: 'touch', width: 24, height: 24 })).contactSize.available).toBe(true);
    const predicted = analyzeInput(stroke(10, 8, { predicted: 0 }));
    expect([predicted.predictedSupported, predicted.predictedSeen]).toEqual([true, false]);
  });

  it('has no rates without movement', () => {
    const a = analyzeInput(stroke(1, 8));
    expect(a.eventRateHz).toBeNull();
    expect(a.sampleRateHz).toBeNull();
  });
});

describe('latency and frames', () => {
  it('reports median and 95th percentile, dropping impossible values', () => {
    const pairs: [number, number, number][] = Array.from({ length: 100 }, (_, i) => [i * 10, i * 10 + 6, i * 10 + 14 + (i >= 95 ? 30 : 0)]);
    pairs.push([1000, 990, 980]); // clocks disagreeing: ignored
    const l = analyzeLatency(pairs);
    expect(l.count).toBe(100);
    expect(l.toFrame.median).toBe(6);
    expect(l.toPaint.median).toBe(14);
    expect(l.toPaint.p95).toBeGreaterThan(14);
  });

  it('estimates the refresh rate and counts late frames', () => {
    const iv = [...Array(57).fill(16.7), 33.4, 33.4, 50];
    const f = analyzeFrames(iv);
    expect(f.refreshHz).toBe(60);
    expect(f.longFrames).toBe(3);
    expect(f.smooth).toBe(0.95);
    expect(f.intervalMs.max).toBe(50);
  });
});

describe('layout fit', () => {
  const vp = { width: 720, height: 800 };
  const insets = { top: 32, right: 0, bottom: 24, left: 0 };
  const box = (b: Partial<Parameters<typeof checkFit>[0][number]>) => ({ name: 'popover', top: 40, right: 700, bottom: 700, left: 20, overflows: false, scrolls: false, ...b });

  it('accepts boxes between the system bars', () => {
    expect(checkFit([box({})], vp, insets)).toEqual([]);
  });

  it('flags boxes under the status bar or the gesture bar, off the side, or cut off', () => {
    const problems = checkFit([box({ top: 10 }), box({ bottom: 790 }), box({ right: 760 }), box({ overflows: true })], vp, insets);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/under the status bar/);
    expect(problems[1]).toMatch(/under the gesture bar/);
    expect(problems[2]).toMatch(/off the side/);
    expect(problems[3]).toMatch(/does not scroll/);
  });

  it('lets bottom sheets reach under the gesture bar', () => {
    expect(checkFit([box({ bottom: 800, sheet: true })], vp, insets)).toEqual([]);
  });
});

describe('the report', () => {
  const report: DeviceReport = {
    createdAt: '2026-11-02T12:00:00.000Z',
    facts: {
      app: { version: '1.0.0', platform: 'android app', build: 'native' },
      browser: { userAgent: 'Mozilla/5.0 (Linux; Android 16)', brands: 'Android WebView 142.0.7444.0', model: 'razr fold', platform: 'Android', platformVersion: '16.0.0', mobile: true },
      screen: { devicePixelRatio: 2.63, viewport: { width: 720, height: 800 }, screen: { width: 720, height: 856 }, orientation: 'portrait-primary' },
      safeArea: { env: { top: 0, right: 0, bottom: 0, left: 0 }, capacitor: { top: 32, right: 0, bottom: 24, left: 0 }, used: { top: 32, right: 0, bottom: 24, left: 0 } },
      hardware: { cores: 8, memoryGb: 8, touchPoints: 10, storage: { usedMb: 12, quotaMb: 50000, persisted: true } },
      graphics: { webgpu: 'available · qualcomm', webgl: 'WebGL 2 · Adreno (TM) 830' },
      audio: { outputLatencyMs: 21.3, baseLatencyMs: 5.3, sampleRate: 48000, state: 'running' },
      native: { richHaptics: true, inkTip: true },
    },
    input: analyzeInput(stroke(60, 1000 / 240, { coalesced: 1, predicted: 1, pressure: (i) => 0.1 + i / 100, tiltX: 20 })),
    latency: analyzeLatency([[0, 4, 12], [10, 14, 22]]),
    frames: analyzeFrames(Array(30).fill(8.33)),
    fit: { problems: [], checked: 3 },
  };

  it('reads as short labelled lines', () => {
    const t = reportText(report);
    expect(t).toContain('Inkwright device check · 2026-11-02T12:00:00.000Z');
    expect(t).toContain('Engine: Android WebView 142.0.7444.0');
    expect(t).toContain('Device: razr fold · Android · 16.0.0');
    expect(t).toContain('Safe area (app): top 32, right 0, bottom 24, left 0');
    expect(t).toContain('Events: 240 per second');
    expect(t).toContain('Pressure: yes (0.1–0.69)');
    expect(t).toContain('Tilt: yes (up to 20°)');
    expect(t).toContain('Predicted events: yes');
    expect(t).toContain('Input to paint (estimate): 12 ms median');
    expect(t).toContain('Frames while drawing: 120 Hz');
    expect(t).toContain('Audio: output 21.3 ms, base 5.3 ms, 48000 Hz (running)');
    expect(t).toContain('Android app: richHaptics yes, inkTip yes');
    expect(t).toContain('Fit: everything fits between the system bars (3 checked)');
  });

  it('says what was not measured, and lists layout problems', () => {
    const t = reportText({ ...report, input: null, latency: null, frames: null, fit: { problems: ['dialog: top 10 is under the status bar (32)'], checked: 1 } });
    expect(t).toContain('Not measured: draw on the test pad first.');
    expect(t).toContain('Problem: dialog: top 10 is under the status bar (32)');
  });

  it('round-trips as JSON', () => {
    expect(JSON.parse(reportJson(report)).facts.screen.devicePixelRatio).toBe(2.63);
  });
});
