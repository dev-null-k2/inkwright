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
  /** Writing-sound band-pass centre at slow speed, Hz. */
  soundBaseHz: number;
  /** Centre frequency rise per 100 mm/s of pen speed, Hz. */
  soundHzPer100MmS: number;
  /** Band-pass resonance: higher = more pitched (felt), lower = hissier (graphite). */
  soundQ: number;
  soundGain: number;
  /** Fibre "crackle" impulses mixed in, 0..1. */
  crackle: number;
}

const PAPER: Record<PaperTexture, FeelProfile> = {
  smooth: { grainPitchMm: 1.3, grainJitter: 0.2, hapticStrength: 0.35, soundBaseHz: 2600, soundHzPer100MmS: 900, soundQ: 0.9, soundGain: 0.45, crackle: 0.1 },
  standard: { grainPitchMm: 0.85, grainJitter: 0.3, hapticStrength: 0.55, soundBaseHz: 2100, soundHzPer100MmS: 1100, soundQ: 0.8, soundGain: 0.6, crackle: 0.25 },
  toothy: { grainPitchMm: 0.55, grainJitter: 0.4, hapticStrength: 0.8, soundBaseHz: 1700, soundHzPer100MmS: 1300, soundQ: 0.7, soundGain: 0.75, crackle: 0.45 },
};

export function feelForPaper(texture: PaperTexture): FeelProfile {
  return { ...(PAPER[texture] ?? PAPER.standard) };
}

/** Paper × pen: graphite is grittier and brighter, felt softer and duller, rubber dull and broad. */
export function feelOf(texture: PaperTexture, pen: PenType | 'eraser'): FeelProfile {
  const p = feelForPaper(texture);
  switch (pen) {
    case 'pencil':
      return { ...p, grainPitchMm: p.grainPitchMm * 0.75, hapticStrength: Math.min(1, p.hapticStrength * 1.25), soundBaseHz: p.soundBaseHz * 1.35, soundQ: p.soundQ * 0.8, soundGain: Math.min(1, p.soundGain * 1.15), crackle: Math.min(1, p.crackle * 1.6) };
    case 'fountain':
      return { ...p, hapticStrength: p.hapticStrength * 0.85, soundGain: p.soundGain * 0.8, crackle: p.crackle * 0.7 };
    case 'ballpoint':
      return { ...p, soundBaseHz: p.soundBaseHz * 0.9, soundQ: p.soundQ * 1.2 };
    case 'brush':
      return { ...p, grainPitchMm: p.grainPitchMm * 1.6, hapticStrength: p.hapticStrength * 0.5, soundBaseHz: p.soundBaseHz * 0.7, soundGain: p.soundGain * 0.55, crackle: p.crackle * 0.2 };
    case 'marker':
    case 'highlighter':
      return { ...p, grainPitchMm: p.grainPitchMm * 1.4, hapticStrength: p.hapticStrength * 0.6, soundBaseHz: p.soundBaseHz * 0.6, soundQ: p.soundQ * 1.6, soundGain: p.soundGain * 0.7, crackle: p.crackle * 0.3 };
    case 'eraser':
      return { ...p, grainPitchMm: p.grainPitchMm * 1.8, hapticStrength: p.hapticStrength * 0.7, soundBaseHz: 700, soundHzPer100MmS: 300, soundQ: 0.6, soundGain: p.soundGain * 0.8, crackle: 0 };
    default:
      return p;
  }
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
    this.smoothedSpeed = this.smoothedSpeed === 0 ? inst : this.smoothedSpeed * 0.7 + inst * 0.3;
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
 * Real-time procedural nib-on-paper sound:
 *   noise → band-pass (centre ∝ speed) → + fibre crackle → envelope → high-pass → soft clip
 * Fast attack (the nib catching), slower release (the tail as the pen lifts). Allocation-free;
 * runs inside an AudioWorklet on the web and an audio thread natively.
 *
 * Self-contained on purpose (no references outside the class) so its source can be shipped into
 * an AudioWorklet via `ScratchSynth.toString()` without a separate bundle.
 */
export class ScratchSynth {
  profile: FeelProfile;
  userVolume = 1;
  private targetAmp = 0;
  private targetHz: number;
  private crackleRate = 0;
  private amp = 0;
  private hz: number;
  private noise = 0x12345678;
  private crackleState = 0x0badf00d;
  private b0 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private hpIn = 0; private hpOut = 0;
  private readonly hpCoef: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly hzCoef: number;

  constructor(private sampleRate: number, profile: FeelProfile) {
    this.profile = profile;
    this.targetHz = profile.soundBaseHz;
    this.hz = profile.soundBaseHz;
    this.hpCoef = Math.exp((-2 * Math.PI * 180) / sampleRate);
    const coef = (s: number) => 1 - Math.exp(-1 / (s * sampleRate));
    this.attack = coef(0.004);
    this.release = coef(0.07);
    this.hzCoef = coef(0.015);
    this.updateFilter(this.hz);
  }

  setTarget(speedMmPerSec: number, pressure: number): void {
    const p = this.profile;
    const press = pressure < 0 ? 0.6 : 0.3 + 0.7 * Math.max(0, Math.min(1, pressure));
    const k = Math.max(0, Math.min(1, (speedMmPerSec - 2) / 58));
    const motion = k * k * (3 - 2 * k);
    this.targetAmp = Math.max(0, Math.min(1, p.soundGain * press * motion)) * this.userVolume;
    this.targetHz = Math.max(300, Math.min(this.sampleRate * 0.42, p.soundBaseHz + p.soundHzPer100MmS * (speedMmPerSec / 100)));
    this.crackleRate = p.crackle > 0 ? (speedMmPerSec / p.grainPitchMm) * p.crackle : 0;
  }

  silence(): void {
    this.targetAmp = 0;
    this.crackleRate = 0;
  }

  get isAudible(): boolean {
    return this.amp > 1e-4 || this.targetAmp > 0;
  }

  render(out: Float32Array, offset = 0, frames = out.length - offset): void {
    const tAmp = this.targetAmp;
    const tHz = this.targetHz;
    const crackleProb = Math.min(0.2, Math.max(0, this.crackleRate / this.sampleRate));
    const q = this.profile.soundQ;
    const glide = 1 - Math.pow(1 - this.hzCoef, 32);
    for (let i = 0; i < frames; i++) {
      this.amp += (tAmp - this.amp) * (tAmp > this.amp ? this.attack : this.release);
      if ((i & 31) === 0) {
        this.hz += (tHz - this.hz) * glide;
        this.updateFilter(this.hz, q);
      }
      const n = this.nextNoise();
      let y = this.b0 * n + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = n; this.y2 = this.y1; this.y1 = y;
      if (crackleProb > 0 && this.nextUniform() < crackleProb) y += this.nextNoise() * 0.9;
      const hp = this.hpCoef * (this.hpOut + y - this.hpIn);
      this.hpIn = y; this.hpOut = hp;
      const c = Math.max(-1.5, Math.min(1.5, hp * this.amp * 2.2));
      out[offset + i] = c - (c * c * c) / 6.75;
    }
    if (this.amp < 1e-5 && tAmp === 0) this.amp = 0;
  }

  private updateFilter(f: number, q = this.profile.soundQ): void {
    const w0 = (2 * Math.PI * f) / this.sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  private nextNoise(): number {
    let s = this.noise;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.noise = s | 0;
    return Math.max(-1, Math.min(1, this.noise / 0x7fffffff));
  }

  private nextUniform(): number {
    let s = this.crackleState;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.crackleState = s | 0;
    return (this.crackleState >>> 1) / 0x7fffffff;
  }
}

/** Cubic soft clipper: linear near zero, exactly ±1 at ±1.5 and flat beyond. */
export function softClip(v: number): number {
  const c = Math.max(-1.5, Math.min(1.5, v));
  return c - (c * c * c) / 6.75;
}
