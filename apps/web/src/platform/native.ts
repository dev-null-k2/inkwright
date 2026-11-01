import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isNative, nativePlatform } from './env.ts';

/**
 * Inkstone's own native plugin (android/app/src/main/java/app/inkstone/InkstoneNativePlugin.kt):
 * fine-grained haptic grain via VibrationEffect primitives, stylus button key events (Moto Pen
 * Ultra, S Pen, USI pens), and on-device ML Kit handwriting recognition.
 */
export interface InkstoneNativePlugin {
  capabilities(): Promise<{ richHaptics: boolean; recognition: boolean; stylusKeys: boolean }>;
  grain(opts: { intensity: number }): Promise<void>;
  confirm(): Promise<void>;
  prepareRecognizer(opts: { language: string }): Promise<{ state: 'ready' | 'downloading' | 'failed' | 'unsupported' }>;
  recognize(opts: { language: string; lines: { strokes: { x: number[]; y: number[]; t: number[] }[]; width: number; height: number; preContext: string }[] }): Promise<{ lines: string[] }>;
  addListener(event: 'stylusButton', cb: (e: { pressed: boolean; keyCode: number }) => void): Promise<PluginListenerHandle>;
}

export const InkstoneNative = registerPlugin<InkstoneNativePlugin>('InkstoneNative');

export const hasNativePlugin = isNative && nativePlatform === 'android';
