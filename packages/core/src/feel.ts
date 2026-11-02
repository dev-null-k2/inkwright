import { clamp01, smoothstep } from './geometry.ts';
import type { PaperTexture, PenType } from './model.ts';

/**
 * How a pen on a given paper should feel and sound. Every tunable of the paper-feel engine lives
 * here so it can be adjusted per paper, per pen and by the user's intensity sliders.
 */
export interface FeelProfile {
  /** Mean distance between haptic grain ticks, millimetres. */
  grainPitchMm: number;
  /** Random variation of the pitch (0..1) so grain feels organic, not mechanical. */
  grainJitter: number;
  /** Base haptic strength 0..1 before pressure/speed modulation. */
  hapticStrength: number;
  /** Centre of the writing sound's band at slow speed, Hz. The band spans ~0.35×…2.4× this. */
  soundBaseHz: number;
  /** Centre rise per 100 mm/s of pen speed, Hz (faster strokes sound brighter). */
  soundHzPer100MmS: number;
  /** Resonance at the top of the band: higher = scratchier nib, lower = softer hiss. */
  soundQ: number;
  soundGain: number;
  /** Fibre "crackle" bursts mixed in, 0..1 (graphite on toothy paper crackles most). */
  crackle: number;
  /** Spacing of the paper's fibres the nib rides over, mm: sets the grain of the sound. */
  fiberMm: number;
  /** How much the fibres modulate the sound, 0 (glass) .. 1 (rough). */
  texture: number;
}

const PAPER: Record<PaperTexture, FeelProfile> = {
  smooth: { grainPitchMm: 1.3, grainJitter: 0.2, hapticStrength: 0.35, soundBaseHz: 2300, soundHzPer100MmS: 700, soundQ: 0.75, soundGain: 0.4, crackle: 0.05, fiberMm: 0.12, texture: 0.25 },
  standard: { grainPitchMm: 0.85, grainJitter: 0.3, hapticStrength: 0.55, soundBaseHz: 2000, soundHzPer100MmS: 850, soundQ: 0.7, soundGain: 0.5, crackle: 0.15, fiberMm: 0.2, texture: 0.45 },
  toothy: { grainPitchMm: 0.55, grainJitter: 0.4, hapticStrength: 0.8, soundBaseHz: 1700, soundHzPer100MmS: 1000, soundQ: 0.65, soundGain: 0.6, crackle: 0.3, fiberMm: 0.3, texture: 0.65 },
};

export function feelForPaper(texture: PaperTexture): FeelProfile {
  return { ...(PAPER[texture] ?? PAPER.standard) };
}

/** Paper × pen: graphite is grittier and brighter, a rolling ball smoother, felt duller, rubber broad. */
export function feelOf(texture: PaperTexture, pen: PenType | 'eraser'): FeelProfile {
  const p = feelForPaper(texture);
  const min1 = (v: number) => Math.min(1, v);
  switch (pen) {
    case 'pencil':
      return { ...p, grainPitchMm: p.grainPitchMm * 0.75, hapticStrength: min1(p.hapticStrength * 1.25), soundBaseHz: p.soundBaseHz * 1.3, soundQ: p.soundQ * 0.85, soundGain: min1(p.soundGain * 1.15), crackle: min1(p.crackle * 1.8), texture: min1(p.texture * 1.25) };
    case 'fountain':
      return { ...p, hapticStrength: p.hapticStrength * 0.85, soundGain: p.soundGain * 0.85, crackle: p.crackle * 0.6, soundQ: p.soundQ * 1.1 };
    case 'ballpoint':
      return { ...p, soundBaseHz: p.soundBaseHz * 0.85, soundGain: p.soundGain * 0.8, crackle: p.crackle * 0.4, texture: p.texture * 0.6 };
    case 'calligraphy':
      // A broad steel nib: the edge drags a little more than a round fountain tip, a touch lower in pitch.
      return { ...p, grainPitchMm: p.grainPitchMm * 1.15, hapticStrength: p.hapticStrength * 0.95, soundBaseHz: p.soundBaseHz * 0.9, soundGain: p.soundGain * 0.95, crackle: p.crackle * 0.8, soundQ: p.soundQ * 1.05 };
    case 'brush':
      return { ...p, grainPitchMm: p.grainPitchMm * 1.6, hapticStrength: p.hapticStrength * 0.5, soundBaseHz: p.soundBaseHz * 0.7, soundGain: p.soundGain * 0.5, crackle: p.crackle * 0.2, texture: p.texture * 0.5 };
    case 'marker':
    case 'highlighter':
      return { ...p, grainPitchMm: p.grainPitchMm * 1.4, hapticStrength: p.hapticStrength * 0.6, soundBaseHz: p.soundBaseHz * 0.6, soundQ: p.soundQ * 1.3, soundGain: p.soundGain * 0.7, crackle: p.crackle * 0.2, texture: p.texture * 0.5 };
    case 'eraser':
      return { ...p, grainPitchMm: p.grainPitchMm * 1.8, hapticStrength: p.hapticStrength * 0.7, soundBaseHz: 750, soundHzPer100MmS: 300, soundQ: 0.6, soundGain: p.soundGain * 0.85, crackle: 0, fiberMm: p.fiberMm * 2, texture: 0.5 };
    default:
      return p;
  }
}

/**
 * Volume slider (0..1) → linear gain on a 30 dB taper, so the slider moves loudness evenly
 * instead of doing everything in its first quarter. 0 is silent; 1 is unity.
 */
export function volumeToGain(volume: number): number {
  if (!(volume > 0)) return 0;
  return Math.pow(10, 1.5 * (Math.min(1, volume) - 1));
}

export interface GrainTick {
  intensity: number;
  speedMmPerSec: number;
}

/**
 * Decides when to fire haptic grain ticks as the pen moves. Paper fibres are spatial, so ticks
 * are emitted per distance travelled, not per unit time: slow strokes give sparse distinct bumps,
 * fast strokes a fine buzz. Intensity follows pressure and speed; a rate cap keeps requests within
 * what a phone actuator renders distinctly. Deterministic (seeded jitter) for tests and tuning.
 */
export class GrainScheduler {
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private hasLast = false;
  private travelled = 0;
  private nextPitch: number;
  private lastTickT = -1e12;
  private smoothedSpeed = 0;
  private rng: number;
  userStrength: number;

  constructor(
    private profile: FeelProfile,
    private unitsPerMm = 96 / 25.4,
    private maxRateHz = 140,
    userStrength = 1,
    seed = 0x51a7e,
  ) {
    this.userStrength = userStrength;
    this.rng = seed | 0;
    this.nextPitch = profile.grainPitchMm;
  }

  get speed(): number { return this.smoothedSpeed; }

  setProfile(p: FeelProfile): void {
    this.profile = p;
    this.nextPitch = this.jittered();
  }

  reset(): void {
    this.hasLast = false;
    this.travelled = 0;
    this.smoothedSpeed = 0;
    this.lastTickT = -1e12;
    this.nextPitch = this.jittered();
  }

  /** One pen sample (page units, ms); pressure 0..1 or negative if unknown. */
  onSample(x: number, y: number, t: number, pressure: number): GrainTick | null {
    if (!this.hasLast) {
      this.lastX = x; this.lastY = y; this.lastT = t; this.hasLast = true;
      return null;
    }
    const dMm = Math.hypot(x - this.lastX, y - this.lastY) / this.unitsPerMm;
    const dt = Math.max(1, t - this.lastT);
    this.lastX = x; this.lastY = y; this.lastT = t;
    const inst = dMm / (dt / 1000);
    // Time-based smoothing (τ ≈ 12 ms) so the estimate settles equally fast at 60, 120 or 240 Hz.
    const a = 1 - Math.exp(-dt / 12);
    this.smoothedSpeed = this.smoothedSpeed === 0 ? inst : this.smoothedSpeed + (inst - this.smoothedSpeed) * a;
    this.travelled += dMm;
    if (this.travelled < this.nextPitch) return null;
    if (t - this.lastTickT < 1000 / this.maxRateHz) {
      this.travelled = Math.min(this.travelled, this.nextPitch * 2);
      return null;
    }
    this.travelled -= this.nextPitch;
    if (this.travelled > this.nextPitch) this.travelled = this.nextPitch;
    this.nextPitch = this.jittered();
    this.lastTickT = t;
    const pf = pressure < 0 ? 0.65 : 0.35 + 0.65 * clamp01(pressure);
    const sf = smoothstep(1.5, 25, this.smoothedSpeed) * (1 - 0.4 * smoothstep(250, 600, this.smoothedSpeed));
    const intensity = clamp01(this.profile.hapticStrength * pf * (0.35 + 0.65 * sf) * this.userStrength);
    if (intensity < 0.02) return null;
    return { intensity, speedMmPerSec: this.smoothedSpeed };
  }

  private jittered(): number {
    this.rng = (Math.imul(this.rng, 1103515245) + 12345) | 0;
    const r = ((this.rng >>> 8) & 0xffff) / 65535;
    return this.profile.grainPitchMm * (1 + this.profile.grainJitter * (r * 2 - 1));
  }
}

/**
 * Real-time procedural nib-on-paper sound, modelled on what a nib actually does:
 *
 *   noise ─ tilt ─┬─ high-pass ─ low-pass (resonant top) ─ × fibre texture ─ × envelope ─ soft clip
 *   contact tap ──┤
 *   fibre crackle ┘
 *
 * The band (~0.35×…2.4× the centre) gives a soft broadband "shh" rather than a whistle; its centre
 * rises with speed. The nib rides over paper fibres every `fiberMm`, so the level is modulated at
 * speed ÷ fibre spacing by a smoothed random texture: slow strokes sound grainy, fast ones smooth.
 * Crackle and the pen-down tap are short decaying bursts fed through the same band so they sound
 * like paper, not digital clicks. Loudness rises compressively with speed and with pressure.
 *
 * Allocation-free; runs inside an AudioWorklet on the web and is ported 1:1 to the Android audio
 * thread (InkwrightNative). Self-contained on purpose (no references outside the class) so its
 * source can be shipped into an AudioWorklet via `ScratchSynth.toString()`.
 */
export class ScratchSynth {
  profile: FeelProfile;
  /** Linear output gain (see volumeToGain). */
  userVolume = 1;
  private targetAmp = 0;
  private targetHz: number;
  private speed = 0;
  private amp = 0;
  private hz: number;
  private noise = 0x12345678;
  private rand = 0x0badf00d;
  private tilt = 0;
  // High-pass and low-pass biquads (direct form I).
  private hb0 = 0; private hb1 = 0; private hb2 = 0; private ha1 = 0; private ha2 = 0;
  private hx1 = 0; private hx2 = 0; private hy1 = 0; private hy2 = 0;
  private lb0 = 0; private lb1 = 0; private lb2 = 0; private la1 = 0; private la2 = 0;
  private lx1 = 0; private lx2 = 0; private ly1 = 0; private ly2 = 0;
  private fiberPhase = 0;
  private fiberTarget = 1;
  private fiber = 1;
  private burst = 0;
  private tap = 0;
  private readonly attack: number;
  private readonly release: number;
  private readonly hzCoef: number;
  private readonly tiltCoef: number;
  private readonly fiberCoef: number;
  private readonly burstDecay: number;
  private readonly tapDecay: number;

  constructor(private sampleRate: number, profile: FeelProfile) {
    this.profile = profile;
    this.targetHz = profile.soundBaseHz;
    this.hz = profile.soundBaseHz;
    const coef = (s: number) => 1 - Math.exp(-1 / (s * sampleRate));
    this.attack = coef(0.005);
    this.release = coef(0.06);
    this.hzCoef = coef(0.02);
    this.tiltCoef = coef(1 / (2 * Math.PI * 3500));
    this.fiberCoef = coef(0.0007);
    this.burstDecay = Math.exp(-1 / (0.0012 * sampleRate));
    this.tapDecay = Math.exp(-1 / (0.004 * sampleRate));
    this.updateFilters(this.hz);
  }

  /** Pen speed (mm/s) and pressure (0..1, negative if unknown). Call as often as samples arrive. */
  setTarget(speedMmPerSec: number, pressure: number): void {
    const p = this.profile;
    const v = Math.max(0, speedMmPerSec);
    const press = pressure < 0 ? 0.65 : 0.35 + 0.65 * Math.max(0, Math.min(1, pressure));
    // Silent when the nib rests; loudness then grows compressively with speed, as friction noise does.
    const motion = v < 1.5 ? 0 : 1 - Math.exp(-(v - 1.5) / 40);
    this.targetAmp = Math.max(0, Math.min(1, p.soundGain * press * motion));
    this.targetHz = Math.max(250, Math.min(this.sampleRate * 0.2, p.soundBaseHz + p.soundHzPer100MmS * (v / 100)));
    this.speed = v;
  }

  /** The soft "tk" of the nib meeting paper. */
  touch(pressure: number): void {
    const press = pressure < 0 ? 0.6 : 0.3 + 0.7 * Math.max(0, Math.min(1, pressure));
    this.tap = Math.max(this.tap, 0.55 * press * Math.min(1, this.profile.soundGain * 1.6));
  }

  silence(): void {
    this.targetAmp = 0;
    this.speed = 0;
  }

  get isAudible(): boolean {
    return this.amp > 1e-4 || this.targetAmp > 0 || this.tap > 1e-4;
  }

  render(out: Float32Array, offset = 0, frames = out.length - offset): void {
    const p = this.profile;
    const tAmp = this.targetAmp;
    const tHz = this.targetHz;
    const fiberStep = p.fiberMm > 0 ? this.speed / p.fiberMm / this.sampleRate : 0;
    const depth = Math.max(0, Math.min(0.9, p.texture));
    const crackleProb = p.crackle > 0 ? Math.min(0.02, ((this.speed / Math.max(0.05, p.grainPitchMm)) * p.crackle) / this.sampleRate) : 0;
    const glide = 1 - Math.pow(1 - this.hzCoef, 32);
    const vol = this.userVolume;
    for (let i = 0; i < frames; i++) {
      this.amp += (tAmp - this.amp) * (tAmp > this.amp ? this.attack : this.release);
      if ((i & 31) === 0) {
        this.hz += (tHz - this.hz) * glide;
        this.updateFilters(this.hz);
      }
      // Source: noise with a gentle high-frequency tilt (paper is soft, not white).
      const n = this.nextNoise();
      this.tilt += (n - this.tilt) * this.tiltCoef;
      let x = n * 0.55 + this.tilt * 0.75;
      if (crackleProb > 0 && this.nextUniform() < crackleProb) this.burst = Math.max(this.burst, 0.5 + 0.5 * this.nextUniform());
      if (this.burst > 1e-4 || this.tap > 1e-4) {
        x += this.nextNoise() * (this.burst * 1.4 + this.tap * 0.8);
        this.burst *= this.burstDecay;
        this.tap *= this.tapDecay;
      }
      // Band: high-pass then resonant low-pass.
      const h = this.hb0 * x + this.hb1 * this.hx1 + this.hb2 * this.hx2 - this.ha1 * this.hy1 - this.ha2 * this.hy2;
      this.hx2 = this.hx1; this.hx1 = x; this.hy2 = this.hy1; this.hy1 = h;
      const l = this.lb0 * h + this.lb1 * this.lx1 + this.lb2 * this.lx2 - this.la1 * this.ly1 - this.la2 * this.ly2;
      this.lx2 = this.lx1; this.lx1 = h; this.ly2 = this.ly1; this.ly1 = l;
      // Fibres: a new random level each time the nib crosses one, smoothed so it never clicks.
      if (fiberStep > 0) {
        this.fiberPhase += fiberStep;
        if (this.fiberPhase >= 1) { this.fiberPhase -= Math.floor(this.fiberPhase); this.fiberTarget = 1 - depth * this.nextUniform(); }
      }
      this.fiber += (this.fiberTarget - this.fiber) * this.fiberCoef;
      const tapLevel = this.tap > 1e-4 ? 1 : 0;
      const env = Math.max(this.amp, tapLevel * 0.35);
      const c = Math.max(-1.5, Math.min(1.5, l * this.fiber * env * vol * 3.4));
      out[offset + i] = c - (c * c * c) / 6.75;
    }
    if (this.amp < 1e-5 && tAmp === 0) this.amp = 0;
  }

  private updateFilters(centre: number): void {
    const sr = this.sampleRate;
    const hp = Math.max(120, centre * 0.35);
    const lp = Math.min(sr * 0.45, centre * 2.4);
    let w = (2 * Math.PI * hp) / sr;
    let cs = Math.cos(w);
    let al = Math.sin(w) / (2 * 0.6);
    let a0 = 1 + al;
    this.hb0 = (1 + cs) / 2 / a0; this.hb1 = -(1 + cs) / a0; this.hb2 = this.hb0;
    this.ha1 = (-2 * cs) / a0; this.ha2 = (1 - al) / a0;
    w = (2 * Math.PI * lp) / sr;
    cs = Math.cos(w);
    al = Math.sin(w) / (2 * Math.max(0.3, this.profile.soundQ));
    a0 = 1 + al;
    this.lb0 = (1 - cs) / 2 / a0; this.lb1 = (1 - cs) / a0; this.lb2 = this.lb0;
    this.la1 = (-2 * cs) / a0; this.la2 = (1 - al) / a0;
  }

  private nextNoise(): number {
    let s = this.noise;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.noise = s | 0;
    return Math.max(-1, Math.min(1, this.noise / 0x7fffffff));
  }

  private nextUniform(): number {
    let s = this.rand;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.rand = s | 0;
    return (this.rand >>> 1) / 0x7fffffff;
  }
}

/** Cubic soft clipper: linear near zero, exactly ±1 at ±1.5 and flat beyond. */
export function softClip(v: number): number {
  const c = Math.max(-1.5, Math.min(1.5, v));
  return c - (c * c * c) / 6.75;
}
