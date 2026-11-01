import { GrainScheduler, ScratchSynth, feelOf, type PaperTexture, type PenType } from '@inkstone/core';
import type { FeelSink } from '../canvas/engine.ts';
import { InkstoneNative, hasNativePlugin } from './native.ts';

export interface FeelSettings {
  haptics: boolean;
  hapticStrength: number;
  sound: boolean;
  soundVolume: number;
}

/**
 * The paper-feel engine on this device: distance-based haptic grain (native actuator primitives
 * on Android, nothing on platforms without a usable actuator) and a procedural writing sound
 * synthesized in an AudioWorklet so it never stutters with the UI.
 */
export class PaperFeel implements FeelSink {
  private scheduler: GrainScheduler;
  private texture: PaperTexture = 'standard';
  private kind: PenType | 'eraser' = 'fountain';
  private audio: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private audioReady: Promise<void> | null = null;
  settings: FeelSettings;

  constructor(settings: FeelSettings) {
    this.settings = settings;
    this.scheduler = new GrainScheduler(feelOf('standard', 'fountain'), undefined, undefined, settings.hapticStrength);
  }

  setPaper(texture: PaperTexture) {
    this.texture = texture;
    this.apply();
  }

  update(settings: FeelSettings) {
    this.settings = settings;
    this.scheduler.userStrength = settings.hapticStrength;
    this.node?.port.postMessage({ type: 'volume', value: settings.sound ? settings.soundVolume : 0 });
  }

  private apply() {
    const profile = feelOf(this.texture, this.kind);
    this.scheduler.setProfile(profile);
    this.node?.port.postMessage({ type: 'profile', value: profile });
  }

  /** Audio must be started from a user gesture on the web. */
  private ensureAudio() {
    if (!this.settings.sound || this.audioReady) return;
    this.audioReady = (async () => {
      try {
        const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
        if (!Ctx) return;
        const ctx = new Ctx({ latencyHint: 'interactive' });
        const code = `const Synth = (${ScratchSynth.toString()});
class InkstoneScratch extends AudioWorkletProcessor {
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
      else if (m.type === 'silence') this.synth.silence();
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (this.synth && out) this.synth.render(out, 0, out.length);
    return true;
  }
}
registerProcessor('inkstone-scratch', InkstoneScratch);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'inkstone-scratch', { numberOfOutputs: 1, outputChannelCount: [1] });
        node.connect(ctx.destination);
        node.port.postMessage({ type: 'init', profile: feelOf(this.texture, this.kind), volume: this.settings.soundVolume });
        this.audio = ctx;
        this.node = node;
      } catch (e) {
        console.warn('Writing sound unavailable', e);
      }
    })();
  }

  begin(kind: PenType | 'eraser') {
    if (kind !== this.kind) { this.kind = kind; this.apply(); }
    this.scheduler.reset();
    this.ensureAudio();
    if (this.audio?.state === 'suspended') void this.audio.resume();
  }

  sample(x: number, y: number, t: number, pressure: number) {
    const tick = this.scheduler.onSample(x, y, t, pressure);
    if (!tick) return;
    if (this.settings.haptics && hasNativePlugin) void InkstoneNative.grain({ intensity: tick.intensity }).catch(() => {});
    if (this.settings.sound && this.node) this.node.port.postMessage({ type: 'target', speed: tick.speedMmPerSec, pressure });
  }

  end() {
    this.node?.port.postMessage({ type: 'silence' });
  }

  confirm() {
    if (!this.settings.haptics) return;
    if (hasNativePlugin) void InkstoneNative.confirm().catch(() => {});
    else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate(12); } catch { /* ignore */ }
    }
  }

  dispose() {
    void this.audio?.close();
  }
}
