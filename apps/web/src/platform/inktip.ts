import type { InkTipSink } from '../canvas/engine.ts';
import { InkstoneNative, hasNativePlugin } from './native.ts';

/**
 * How much of the stroke the native tip draws. It must outlast the web layer's presentation lag
 * (30–50 ms at 120 Hz, more when the WebView is busy or the panel drops to 60 Hz) or a gap opens
 * between the web ink and the tip; extra length is invisible since it lies on top of the same ink.
 */
const TAIL_MS = 90;

/**
 * Bridges the engine's instant-ink-tip hooks to the Android app. A no-op everywhere else
 * (browsers, iOS, older app builds without the overlay).
 */
export class NativeInkTip implements InkTipSink {
  private supported = false;
  private active = false;

  constructor() {
    if (!hasNativePlugin) return;
    void InkstoneNative.capabilities().then((c) => { this.supported = !!c.inkTip; if (this.supported && this.active) void this.prepare(true); }).catch(() => {});
  }

  /** Attach the overlay while a note is open. */
  async prepare(active: boolean) {
    this.active = active;
    if (!this.supported) return;
    try {
      const r = await InkstoneNative.inkTipPrepare({ active });
      if (active && !r.supported) this.supported = false;
    } catch { this.supported = false; }
  }

  begin(opts: { color: string; widthPx: number }) {
    if (!this.supported || !this.active) return;
    void InkstoneNative.inkTipBegin({ color: opts.color, widthPx: opts.widthPx, tailMs: TAIL_MS }).catch(() => {});
  }

  end(cancelled = false) {
    if (!this.supported || !this.active) return;
    void InkstoneNative.inkTipEnd({ cancelled }).catch(() => {});
  }
}
