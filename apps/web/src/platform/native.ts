import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isNative, nativePlatform } from './env.ts';

/**
 * Inkstone's own native plugin (android/app/src/main/java/app/inkstone/InkstoneNativePlugin.kt):
 * fine-grained haptic grain via VibrationEffect primitives, stylus button key events (Moto Pen
 * Ultra, S Pen, USI pens), and on-device ML Kit handwriting recognition.
 */
/** Mirrors FeelProfile in @inkstone/core (feel.ts); sent whole so native needs no tables. */
export interface NativeFeelProfile {
  grainPitchMm: number; grainJitter: number; hapticStrength: number;
  soundBaseHz: number; soundHzPer100MmS: number; soundQ: number; soundGain: number;
  crackle: number; fiberMm: number; texture: number;
}

export interface InkstoneNativePlugin {
  capabilities(): Promise<{ richHaptics: boolean; recognition: boolean; stylusKeys: boolean; nativeFeel?: boolean; inkTip?: boolean }>;
  /**
   * Instant ink tip (Android 10+): a transparent front-buffered overlay above the WebView.
   * prepare(active) attaches it when a note opens and removes it when the note closes; returns
   * whether this device supports it.
   */
  inkTipPrepare(opts: { active: boolean }): Promise<{ supported: boolean }>;
  /**
   * The pen stroke that just started (and is already down) is drawn by the web layer a frame or two
   * late; until then native draws its newest tailMs of samples (plus prediction) as a round-capped
   * line of this colour (#AARRGGBB) and width (CSS px), straight from MotionEvents.
   */
  inkTipBegin(opts: { color: string; widthPx: number; tailMs: number }): Promise<void>;
  /** cancelled: clear now. Otherwise keep the last tail ~60 ms (the web ink is on screen by then), then clear. */
  inkTipEnd(opts: { cancelled: boolean }): Promise<void>;
  /**
   * Native paper feel (Android): arms the engine for the pen stroke that just started. From then
   * on native reads the stylus straight from the activity's MotionEvents (with historical
   * samples) and drives the low-latency writing sound and haptic grain itself — no per-sample
   * bridge traffic — until the stylus lifts or feelEnd() is called.
   * soundGain is linear (volumeToGain of the slider). pressure is the pen-down pressure (0..1, or
   * negative when unknown) for the contact tap.
   */
  feelBegin(opts: { profile: NativeFeelProfile; sound: boolean; soundGain: number; haptics: boolean; hapticStrength: number; pressure: number }): Promise<void>;
  feelEnd(): Promise<void>;
  /** Opens (active) or releases the audio stream, so the first stroke after opening a note has no start-up delay. */
  feelPrepare(opts: { active: boolean }): Promise<void>;
  /** Plays a short sample stroke at this gain (Settings/Feel popover preview). */
  feelPreview(opts: { profile: NativeFeelProfile; soundGain: number; haptics: boolean; hapticStrength: number }): Promise<void>;
  grain(opts: { intensity: number }): Promise<void>;
  confirm(): Promise<void>;
  prepareRecognizer(opts: { language: string }): Promise<{ state: 'ready' | 'downloading' | 'failed' | 'unsupported' }>;
  recognize(opts: { language: string; lines: { strokes: { x: number[]; y: number[]; t: number[] }[]; width: number; height: number; preContext: string }[] }): Promise<{ lines: string[] }>;
  addListener(event: 'stylusButton', cb: (e: { pressed: boolean; keyCode: number }) => void): Promise<PluginListenerHandle>;
  /**
   * Files Android handed to Inkstone ("Open with", share sheet) that the web layer hasn't taken
   * yet. Each was copied into the app's cache; `path` is a file:// URI for Capacitor Filesystem.
   */
  takeSharedFiles(): Promise<{ files: SharedFile[] }>;
  /** A file arrived while Inkstone was running (the same files are not returned by takeSharedFiles). */
  addListener(event: 'sharedFiles', cb: (e: { files: SharedFile[] }) => void): Promise<PluginListenerHandle>;
}

export interface SharedFile { name: string; mimeType: string; path: string }

export const InkstoneNative = registerPlugin<InkstoneNativePlugin>('InkstoneNative');

export const hasNativePlugin = isNative && nativePlatform === 'android';
