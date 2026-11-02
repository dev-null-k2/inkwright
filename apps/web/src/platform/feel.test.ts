import { beforeEach, describe, expect, it, vi } from 'vitest';
import { volumeToGain } from '@inkwright/core';

const native = vi.hoisted(() => ({
  enabled: false,
  calls: [] as [string, unknown][],
}));

vi.mock('./native.ts', () => {
  const rec = (name: string) => (opts?: unknown) => { native.calls.push([name, opts]); return Promise.resolve(name === 'capabilities' ? { richHaptics: true, recognition: true, stylusKeys: true, nativeFeel: true } : undefined); };
  return {
    get hasNativePlugin() { return native.enabled; },
    InkwrightNative: { capabilities: rec('capabilities'), grain: rec('grain'), confirm: rec('confirm'), feelBegin: rec('feelBegin'), feelEnd: rec('feelEnd'), feelPrepare: rec('feelPrepare'), feelPreview: rec('feelPreview') },
  };
});

const { PaperFeel } = await import('./feel.ts');
const settings = { haptics: true, hapticStrength: 0.8, sound: true, soundVolume: 0.5 };
const UPM = 96 / 25.4;

function withFakeWorklet(f: InstanceType<typeof PaperFeel>) {
  const posted: any[] = [];
  (f as any).node = { port: { postMessage: (m: unknown) => posted.push(m) } };
  (f as any).audioReady = Promise.resolve();
  return posted;
}

describe('PaperFeel (web audio path)', () => {
  beforeEach(() => { native.enabled = false; native.calls = []; });

  it('updates the sound on every pen sample, not only on grain ticks', () => {
    const f = new PaperFeel(settings);
    const posted = withFakeWorklet(f);
    f.begin('fountain', 'pen', 0.5);
    // 40 mm/s for 200 ms at 240 Hz: ~48 samples.
    for (let t = 0; t <= 200; t += 4) f.sample((40 * t / 1000) * UPM, 0, t, 0.5);
    const targets = posted.filter((m) => m.type === 'target');
    expect(targets.length).toBeGreaterThanOrEqual(25);
    expect(targets.at(-1).speed).toBeGreaterThan(30);
    expect(posted[0]).toEqual({ type: 'touch', pressure: 0.5 });
  });

  it('sends a target within the first few samples so sound starts with the ink', () => {
    const f = new PaperFeel(settings);
    const posted = withFakeWorklet(f);
    f.begin('pencil', 'pen', 0.4);
    for (let t = 0; t <= 12; t += 4) f.sample((60 * t / 1000) * UPM, 0, t, 0.4);
    expect(posted.some((m) => m.type === 'target' && m.speed > 0)).toBe(true);
  });

  it('volume uses the tapered gain and sound off is silent', () => {
    const f = new PaperFeel(settings);
    const posted = withFakeWorklet(f);
    f.update({ ...settings, soundVolume: 0.75 });
    expect(posted.at(-1)).toEqual({ type: 'volume', value: volumeToGain(0.75) });
    f.update({ ...settings, sound: false });
    expect(posted.at(-1)).toEqual({ type: 'volume', value: 0 });
  });

  it('fades out when the nib rests without moving', async () => {
    vi.useFakeTimers();
    try {
      const f = new PaperFeel(settings);
      const posted = withFakeWorklet(f);
      f.begin('fountain', 'pen', 0.5);
      for (let t = 0; t <= 100; t += 4) f.sample((40 * t / 1000) * UPM, 0, t, 0.5);
      expect(posted.at(-1).speed).toBeGreaterThan(10);
      vi.advanceTimersByTime(80);
      expect(posted.at(-1)).toEqual({ type: 'target', speed: 0, pressure: 0.5 });
    } finally { vi.useRealTimers(); }
  });

  it('silences on end', () => {
    const f = new PaperFeel(settings);
    const posted = withFakeWorklet(f);
    f.begin('fountain', 'pen');
    f.end();
    expect(posted.at(-1)).toEqual({ type: 'silence' });
  });
});

describe('PaperFeel (Android native path)', () => {
  beforeEach(() => { native.enabled = true; native.calls = []; });

  it('hands pen strokes to the native engine with no per-sample bridge traffic', async () => {
    const f = new PaperFeel(settings);
    await Promise.resolve(); await Promise.resolve();
    expect(native.calls.some(([n, o]) => n === 'feelPrepare' && (o as any).active)).toBe(true);
    native.calls = [];
    f.begin('pencil', 'pen', 0.7);
    for (let t = 0; t <= 400; t += 4) f.sample((80 * t / 1000) * UPM, 0, t, 0.7);
    f.end();
    const names = native.calls.map(([n]) => n);
    expect(names).toEqual(['feelBegin', 'feelEnd']);
    const begin = native.calls[0]![1] as any;
    expect(begin.soundGain).toBeCloseTo(volumeToGain(0.5), 6);
    expect(begin.pressure).toBe(0.7);
    expect(begin.profile.texture).toBeGreaterThan(0);
  });

  it('holds the native audio stream open only while sound is on and the editor is alive', async () => {
    const f = new PaperFeel({ ...settings, sound: false });
    await Promise.resolve(); await Promise.resolve();
    expect(native.calls.filter(([n]) => n === 'feelPrepare')).toEqual([]);
    f.update({ ...settings, sound: true });
    f.update({ ...settings, sound: true, soundVolume: 0.7 });
    f.dispose();
    expect(native.calls.filter(([n]) => n === 'feelPrepare').map(([, o]) => (o as any).active)).toEqual([true, false]);
  });

  it('an editor closed before the app answers never opens the stream', async () => {
    const f = new PaperFeel(settings);
    f.dispose();
    await Promise.resolve(); await Promise.resolve();
    expect(native.calls.some(([n]) => n === 'feelPrepare')).toBe(false);
  });

  it('finger drawing still uses the bridge grain path', async () => {
    const f = new PaperFeel(settings);
    await Promise.resolve(); await Promise.resolve();
    native.calls = [];
    f.begin('fountain', 'touch', -1);
    for (let t = 0; t <= 400; t += 4) f.sample((80 * t / 1000) * UPM, 0, t, -1);
    expect(native.calls.some(([n]) => n === 'grain')).toBe(true);
    expect(native.calls.some(([n]) => n === 'feelBegin')).toBe(false);
  });

  it('preview goes to the native engine', async () => {
    const f = new PaperFeel(settings);
    await Promise.resolve(); await Promise.resolve();
    f.preview({ ...settings, soundVolume: 0.3 });
    const p = native.calls.find(([n]) => n === 'feelPreview')![1] as any;
    expect(p.soundGain).toBeCloseTo(volumeToGain(0.3), 6);
  });
});
