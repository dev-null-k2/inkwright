import { describe, expect, it } from 'vitest';
import { GrainScheduler, ScratchSynth, feelForPaper, feelOf, softClip, volumeToGain } from '../src/index.ts';

const UNITS_PER_MM = 96 / 25.4;
function drive(s: GrainScheduler, speedMmPerSec: number, ms: number, pressure = 0.6) {
  let ticks = 0, sum = 0;
  for (let t = 0; t <= ms; t += 4) {
    const x = (speedMmPerSec * t) / 1000 * UNITS_PER_MM;
    const tick = s.onSample(x, 0, t, pressure);
    if (tick) { ticks++; sum += tick.intensity; }
  }
  return { ticks, avg: ticks ? sum / ticks : 0 };
}

describe('grain scheduler', () => {
  it('ticks per distance, not time: slow strokes give sparse ticks', () => {
    const slow = drive(new GrainScheduler(feelForPaper('standard')), 20, 1000);
    const fast = drive(new GrainScheduler(feelForPaper('standard')), 80, 1000);
    expect(fast.ticks).toBeGreaterThan(slow.ticks * 2.5);
  });
  it('respects the actuator rate cap', () => {
    expect(drive(new GrainScheduler(feelForPaper('toothy')), 1000, 1000).ticks).toBeLessThanOrEqual(141);
  });
  it('toothy paper is denser and stronger than smooth', () => {
    const smooth = drive(new GrainScheduler(feelForPaper('smooth')), 60, 1000);
    const toothy = drive(new GrainScheduler(feelForPaper('toothy')), 60, 1000);
    expect(toothy.ticks).toBeGreaterThan(smooth.ticks);
    expect(toothy.avg).toBeGreaterThan(smooth.avg);
  });
  it('pressure makes grain stronger', () => {
    expect(drive(new GrainScheduler(feelForPaper('standard')), 60, 600, 1).avg).toBeGreaterThan(drive(new GrainScheduler(feelForPaper('standard')), 60, 600, 0.1).avg);
  });
  it('user strength 0 silences', () => {
    expect(drive(new GrainScheduler(feelForPaper('standard'), undefined, undefined, 0), 60, 600).ticks).toBe(0);
  });
  it('is deterministic for a seed', () => {
    expect(drive(new GrainScheduler(feelForPaper('standard')), 50, 800)).toEqual(drive(new GrainScheduler(feelForPaper('standard')), 50, 800));
  });
  it('pen and eraser modify the profile', () => {
    expect(feelOf('standard', 'pencil').grainPitchMm).toBeLessThan(feelOf('standard', 'fountain').grainPitchMm);
    expect(feelOf('standard', 'eraser').crackle).toBe(0);
  });
});

describe('scratch synth', () => {
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  it('is silent at rest and audible while writing', () => {
    const s = new ScratchSynth(48000, feelForPaper('standard'));
    const buf = new Float32Array(2048);
    s.render(buf);
    expect(rms(buf)).toBe(0);
    s.setTarget(60, 0.6);
    for (let i = 0; i < 4; i++) s.render(buf);
    expect(rms(buf)).toBeGreaterThan(0.01);
  });
  it('releases after the pen lifts and never clips', () => {
    const s = new ScratchSynth(48000, feelForPaper('toothy'));
    const buf = new Float32Array(4096);
    s.setTarget(400, 1);
    for (let i = 0; i < 4; i++) {
      s.render(buf);
      expect(Math.max(...buf.map(Math.abs))).toBeLessThanOrEqual(1);
    }
    s.silence();
    for (let i = 0; i < 20; i++) s.render(buf);
    expect(s.isAudible).toBe(false);
  });
  it('faster strokes sound brighter (more high-frequency energy)', () => {
    const zc = (speed: number) => {
      const s = new ScratchSynth(48000, { ...feelForPaper('standard'), crackle: 0 });
      s.setTarget(speed, 0.6);
      const buf = new Float32Array(8192);
      s.render(buf); s.render(buf);
      let z = 0;
      for (let i = 1; i < buf.length; i++) if ((buf[i - 1]! < 0) !== (buf[i]! < 0)) z++;
      return z;
    };
    expect(zc(250)).toBeGreaterThan(zc(10));
  });
  const level = (paper: 'smooth' | 'standard' | 'toothy', pen: Parameters<typeof feelOf>[1], speed: number, pressure: number, volume: number) => {
    const s = new ScratchSynth(48000, feelOf(paper, pen));
    s.userVolume = volumeToGain(volume);
    s.setTarget(speed, pressure);
    const buf = new Float32Array(48000);
    s.render(buf);
    return rms(buf.subarray(4800));
  };
  const dbfs = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));
  it('is quiet and natural at the default volume (≈ −34…−27 dBFS for normal writing)', () => {
    const d = dbfs(level('standard', 'fountain', 50, 0.5, 0.5));
    expect(d).toBeGreaterThan(-34);
    expect(d).toBeLessThan(-27);
  });
  it('even at full volume, fast hard pencil on toothy paper keeps headroom (< −6 dBFS)', () => {
    expect(dbfs(level('toothy', 'pencil', 300, 1, 1))).toBeLessThan(-6);
  });
  it('volume slider has an even taper and 0 is silent', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBeCloseTo(1, 6);
    expect(volumeToGain(0.5)).toBeGreaterThan(0.1);
    expect(volumeToGain(0.5)).toBeLessThan(0.25);
    expect(level('standard', 'fountain', 50, 0.5, 0)).toBe(0);
    const d = dbfs(level('standard', 'fountain', 50, 0.5, 0.75)) - dbfs(level('standard', 'fountain', 50, 0.5, 0.25));
    expect(d).toBeGreaterThan(12);
    expect(d).toBeLessThan(18);
  });
  it('presses harder → louder; pencil grittier than ballpoint', () => {
    expect(level('standard', 'fountain', 50, 1, 0.5)).toBeGreaterThan(level('standard', 'fountain', 50, 0.1, 0.5) * 1.5);
    expect(level('standard', 'pencil', 50, 0.5, 0.5)).toBeGreaterThan(level('standard', 'ballpoint', 50, 0.5, 0.5));
  });
  it('slow strokes are grainy (fibre texture), fast strokes smooth', () => {
    const grain = (speed: number) => {
      const s = new ScratchSynth(48000, { ...feelOf('toothy', 'pencil'), crackle: 0 });
      s.setTarget(speed, 0.6);
      const buf = new Float32Array(48000);
      s.render(buf);
      // Short-time RMS in 2 ms windows; texture shows up as variation between windows.
      const w = 96, env: number[] = [];
      for (let i = 4800; i + w <= buf.length; i += w) env.push(rms(buf.subarray(i, i + w)));
      const m = env.reduce((a, b) => a + b, 0) / env.length;
      return Math.sqrt(env.reduce((a, b) => a + (b - m) ** 2, 0) / env.length) / m;
    };
    expect(grain(12)).toBeGreaterThan(grain(250));
  });
  it('the nib touching paper makes a short soft tap that dies away', () => {
    const s = new ScratchSynth(48000, feelForPaper('standard'));
    s.userVolume = volumeToGain(0.5);
    s.touch(0.7);
    const buf = new Float32Array(480);
    s.render(buf);
    expect(rms(buf)).toBeGreaterThan(0.001);
    expect(Math.max(...buf.map(Math.abs))).toBeLessThan(0.2);
    for (let i = 0; i < 10; i++) s.render(buf);
    expect(s.isAudible).toBe(false);
  });
  it('soft clip is monotonic and bounded', () => {
    expect(softClip(0)).toBe(0);
    expect(softClip(1.5)).toBeCloseTo(1, 6);
    expect(softClip(10)).toBeCloseTo(1, 6);
    expect(softClip(0.5)).toBeLessThan(softClip(0.6));
  });
});
