import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { registerNativeLLM, type NativeLLM, type NativeLLMAvailability, type NativeLLMRequest } from '../../platform/native-llm.ts';

/**
 * The iOS shell's own plugin (ios/App/App/InkwrightApplePlugin.swift): Apple's on-device model
 * (Foundation Models, iOS 26 and later with Apple Intelligence on) and Apple Pencil double-tap and
 * squeeze. Absent everywhere else.
 */
export interface AppleAvailability {
  state: NativeLLMAvailability;
  /** modelNotReady | appleIntelligenceNotEnabled | deviceNotEligible | osTooOld | unknown */
  reason?: string;
}

export interface InkwrightApplePlugin {
  availability(): Promise<AppleAvailability>;
  generate(o: { id: string; messages: NativeLLMRequest['messages']; maxTokens?: number; temperature?: number }): Promise<{ text: string }>;
  cancel(o: { id: string }): Promise<void>;
  addListener(event: 'llmDelta', cb: (e: { id: string; text: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'pencil', cb: (e: { action: 'doubleTap' | 'squeeze' }) => void): Promise<PluginListenerHandle>;
}

export const isIOSApp = (() => {
  try { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'; } catch { return false; }
})();

let plugin: InkwrightApplePlugin | null = isIOSApp ? registerPlugin<InkwrightApplePlugin>('InkwrightApple') : null;

/** The plugin, or null outside the iOS app. */
export function applePlugin(): InkwrightApplePlugin | null {
  return plugin;
}

/** Tests only. */
export function setApplePluginForTests(p: InkwrightApplePlugin | null) {
  plugin = p;
  registered = false;
}

/** Why Apple's model can't answer, in words for Settings; null when it can. */
export function describeAppleAvailability(a: AppleAvailability): string | null {
  if (a.state === 'available') return null;
  switch (a.reason) {
    case 'modelNotReady': return 'Apple Intelligence is still getting its model ready. It works once the download finishes.';
    case 'appleIntelligenceNotEnabled': return 'Turn on Apple Intelligence in Settings › Apple Intelligence & Siri to use it here.';
    case 'deviceNotEligible': return 'This device doesn’t support Apple Intelligence.';
    case 'osTooOld': return 'Apple’s on-device model needs iOS 26 or later.';
    default: return 'Apple’s on-device model isn’t available right now.';
  }
}

let seq = 0;

/** Apple's model as a NativeLLM, streamed through `llmDelta` events. */
export function createAppleLLM(p: InkwrightApplePlugin, deviceName = 'this device'): NativeLLM {
  return {
    id: 'apple-intelligence',
    label: `Apple Intelligence (on ${deviceName})`,
    // The on-device model's context window is 4096 tokens.
    contextTokens: 4096,
    availability: () => p.availability().then((a) => a.state).catch(() => 'unavailable' as const),
    async generate(req, onDelta, signal) {
      const id = `apple-${Date.now().toString(36)}-${++seq}`;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const handle = await p.addListener('llmDelta', (e) => { if (e.id === id && e.text) onDelta(e.text); });
      const onAbort = () => { void p.cancel({ id }); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const r = await p.generate({ id, messages: req.messages, ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}), ...(req.temperature != null ? { temperature: req.temperature } : {}) });
        return { text: r.text ?? '' };
      } catch (e) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        throw e;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        void handle.remove();
      }
    },
  };
}

let registered = false;

/** Registers Apple's model with the assistant when running in the iOS app. Idempotent. */
export function initAppleAI(): Promise<void> {
  if (!plugin || registered) return Promise.resolve();
  registered = true;
  const device = /iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? 'this iPad' : 'this iPhone';
  registerNativeLLM(createAppleLLM(plugin, device));
  return Promise.resolve();
}
