import { GrainScheduler, ScratchSynth, feelOf, volumeToGain, type FeelProfile, type PaperTexture, type PenType } from '@inkwright/core';
import type { FeelSink, PointerKind } from '../canvas/engine.ts';
import { InkwrightNative, hasNativePlugin } from './native.ts';

export interface FeelSettings {
  haptics: boolean;
  hapticStrength: number;
  sound: boolean;
  /** Slider position 0..1; mapped to gain on a 30 dB taper (volumeToGain). */
  soundVolume: number;
}

/** Synth target updates are throttled to this pen-time interval (ms). */
const TARGET_INTERVAL = 6;

/**
 * The paper-feel engine on this device.
 *
 * - Android app, pen strokes: handed to the native engine (InkwrightNative.feelBegin), which reads
 *   the stylus straight from MotionEvents and renders sound on a low-latency AudioTrack and haptic
 *   grain on the actuator — no WebAudio latency and no per-sample bridge traffic.
 * - Everywhere else (and finger drawing): distance-based haptic grain through the plugin when
 *   present, and the same synth in an AudioWorklet, updated on every pen sample.
 *
 * The audio graph is prepared when a note opens (prepare()), so the first stroke is not delayed
 * by start-up; browsers that insist on a user gesture get it resumed on the first pen-down.
 */
export class PaperFeel implements FeelSink {
  private scheduler: GrainScheduler;
  private texture: PaperTexture = 'standard';
  private kind: PenType | 'eraser' = 'fountain';
  private audio: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private audioReady: Promise<void> | null = null;
  private nativeFeel = false;
  private nativeStroke = false;
  private lastTargetT = -1e9;
  private lastPressure = -1;
  private restTimer = 0;
  private disposed = false;
  /** Whether the native audio stream is held open for this editor. */
  private nativePrepared = false;
  settings: FeelSettings;

  constructor(settings: FeelSettings) {
    this.settings = settings;
    this.scheduler = new GrainScheduler(feelOf('standard', 'fountain'), undefined, undefined, settings.hapticStrength);
    if (hasNativePlugin) {
      void InkwrightNative.capabilities().then((c) => { if (this.disposed) return; this.nativeFeel = !!c.nativeFeel; this.syncNativeStream(); }).catch(() => {});
    }
  }

  get profile(): FeelProfile {
    return feelOf(this.texture, this.kind);
  }

  setPaper(texture: PaperTexture) {
    this.texture = texture;
    this.apply();
  }

  update(settings: FeelSettings) {
    this.settings = settings;
    this.syncNativeStream();
    this.scheduler.userStrength = settings.hapticStrength;
    this.node?.port.postMessage({ type: 'volume', value: this.gain() });
  }

  private gain(): number {
    return this.settings.sound ? volumeToGain(this.settings.soundVolume) : 0;
  }

  private apply() {
    const profile = this.profile;
    this.scheduler.setProfile(profile);
    this.node?.port.postMessage({ type: 'profile', value: profile });
  }

  /** Get audio ready before the first stroke (call when a note opens). */
  prepare() {
    this.syncNativeStream();
    if (!this.nativeFeel) this.ensureAudio();
  }

  /**
   * Keeps the native stream open only while it can be heard: sound on and this editor alive. An open
   * stream with nothing to play still wakes the audio path (and Bluetooth speakers).
   */
  private syncNativeStream() {
    if (!this.nativeFeel) return;
    const want = !this.disposed && this.settings.sound;
    if (want === this.nativePrepared) return;
    this.nativePrepared = want;
    void InkwrightNative.feelPrepare({ active: want }).catch(() => {});
  }

  /** Builds the AudioWorklet graph. Safe to call repeatedly; resumes a suspended context. */
  private ensureAudio() {
    if (!this.settings.sound) return;
    if (this.audioReady) {
      if (this.audio?.state === 'suspended') void this.audio.resume().catch(() => {});
      return;
    }
    this.audioReady = (async () => {
      try {
        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
        if (!Ctx) return;
        const ctx = new Ctx({ latencyHint: 'interactive' });
        const code = `const Synth = (${ScratchSynth.toString()});
class InkwrightScratch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.synth = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'init') { this.synth = new Synth(sampleRate, m.profile); this.synth.userVolume = m.volume; }
      else if (!this.synth) return;
      else if (m.type === 'profile') this.synth.profile = m.value;
      else if (m.type === 'volume') this.synth.userVolume = m.value;
      else if (m.type === 'target') this.synth.setTarget(m.speed, m.pressure);
      else if (m.type === 'touch') this.synth.touch(m.pressure);
      else if (m.type === 'silence') this.synth.silence();
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (this.synth && out) this.synth.render(out, 0, out.length);
    return true;
  }
}
registerProcessor('inkwright-scratch', InkwrightScratch);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'inkwright-scratch', { numberOfOutputs: 1, outputChannelCount: [1] });
        node.connect(ctx.destination);
        node.port.postMessage({ type: 'init', profile: this.profile, volume: this.gain() });
        this.audio = ctx;
        this.node = node;
        // Started outside a gesture the context may be suspended; the first pen-down resumes it.
        if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      } catch (e) {
        console.warn('Writing sound unavailable', e);
      }
    })();
  }

  begin(kind: PenType | 'eraser', pointer: PointerKind = 'pen', pressure = -1) {
    if (kind !== this.kind) { this.kind = kind; this.apply(); }
    this.scheduler.reset();
    this.lastTargetT = -1e9;
    this.lastPressure = pressure;
    this.nativeStroke = this.nativeFeel && pointer === 'pen';
    if (this.nativeStroke) {
      const { haptics, hapticStrength, sound } = this.settings;
      void InkwrightNative.feelBegin({ profile: this.profile, sound, soundGain: this.gain(), haptics, hapticStrength, pressure }).catch(() => { this.nativeStroke = false; });
      return;
    }
    this.ensureAudio();
    if (this.settings.sound && this.node && pointer === 'pen') this.node.port.postMessage({ type: 'touch', pressure });
  }

  sample(x: number, y: number, t: number, pressure: number) {
    if (this.nativeStroke) return;
    const tick = this.scheduler.onSample(x, y, t, pressure);
    if (tick && this.settings.haptics && hasNativePlugin) void InkwrightNative.grain({ intensity: tick.intensity }).catch(() => {});
    if (!this.settings.sound || !this.node) return;
    // Every sample, not just grain ticks, so the sound follows the pen without lag.
    if (t - this.lastTargetT >= TARGET_INTERVAL || Math.abs(pressure - this.lastPressure) > 0.15) {
      this.lastTargetT = t;
      this.lastPressure = pressure;
      this.node.port.postMessage({ type: 'target', speed: this.scheduler.speed, pressure });
    }
    // A nib resting on the glass sends no samples: fade the sound instead of scratching on.
    clearTimeout(this.restTimer);
    const node = this.node;
    this.restTimer = window.setTimeout(() => { node.port.postMessage({ type: 'target', speed: 0, pressure }); this.lastTargetT = -1e9; }, 60);
  }

  end() {
    if (this.nativeStroke) {
      this.nativeStroke = false;
      void InkwrightNative.feelEnd().catch(() => {});
      return;
    }
    clearTimeout(this.restTimer);
    this.node?.port.postMessage({ type: 'silence' });
  }

  confirm() {
    if (!this.settings.haptics) return;
    if (hasNativePlugin) void InkwrightNative.confirm().catch(() => {});
    else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate(12); } catch { /* ignore */ }
    }
  }

  /** A short sample stroke at the current settings, for adjusting volume and feel. */
  preview(settings: FeelSettings = this.settings) {
    this.update(settings);
    if (this.nativeFeel) {
      void InkwrightNative.feelPreview({ profile: this.profile, soundGain: this.gain(), haptics: settings.haptics, hapticStrength: settings.hapticStrength }).catch(() => {});
      return;
    }
    this.ensureAudio();
    void (this.audioReady ?? Promise.resolve()).then(() => {
      const node = this.node;
      if (!node || !settings.sound) return;
      node.port.postMessage({ type: 'touch', pressure: 0.6 });
      const start = performance.now();
      const step = () => {
        const f = (performance.now() - start) / 700;
        if (f >= 1) { node.port.postMessage({ type: 'silence' }); return; }
        node.port.postMessage({ type: 'target', speed: 80 * Math.sin(Math.PI * f), pressure: 0.6 });
        setTimeout(step, 16);
      };
      step();
    });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.restTimer);
    void this.audio?.close().catch(() => {});
    this.audio = null;
    this.node = null;
    this.audioReady = null;
    this.syncNativeStream();
  }
}
