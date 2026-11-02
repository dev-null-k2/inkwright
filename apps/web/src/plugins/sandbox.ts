/**
 * A plugin's sandboxed frame, host side.
 *
 * Isolation comes from three layers:
 * - `<iframe sandbox="allow-scripts">` without `allow-same-origin`: an opaque origin, so no
 *   access to the app's DOM, cookies, IndexedDB (the vault) or localStorage, no popups, no top
 *   navigation, no forms;
 * - the frame's own Content Security Policy: scripts only from the runtime file and blob:
 *   modules (no eval, no remote scripts), `connect-src 'none'` (no fetch/XHR/WebSocket — network
 *   goes through the permission-checked `net.fetch`), images only from data:/blob:;
 * - the app's CSP (built into hosted and native builds) still applies to the frame: its
 *   `frame-src` stops the frame from navigating itself to another site.
 *
 * Messages are accepted only from this frame's window and only in the versioned protocol.
 */
import { PROTOCOL, PROTOCOL_VERSION, PluginApiError, envelope, isProtocolMessage, toWireError, type InvokeTarget, type PluginManifest, type PluginToHost, type WireError } from '@inkstone/plugin-api';
import runtimeUrl from './sandbox-runtime.ts?worker&url';

export interface FrameOptions {
  manifest: PluginManifest;
  code: string;
  role: 'main' | 'panel';
  panelId?: string;
  /** Where a panel frame goes; main frames are hidden and attached to <body>. */
  container?: HTMLElement;
  /** Answers API calls (the dispatcher, bound to this plugin's caller). */
  onCall(method: string, params: unknown[]): Promise<unknown>;
  onLog?(level: string, message: string): void;
  onHeight?(px: number): void;
}

/** The theme variables a panel gets, so it matches the app's palette and night mode. */
const THEME_VARS = ['--desk', '--chrome', '--chrome-2', '--raised', '--ink', '--ink-2', '--ink-3', '--line', '--line-strong', '--iron', '--iron-soft', '--seal', '--moss', '--font-ui', '--font-title', '--font-mono'];

function theme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const v of THEME_VARS) {
    const val = cs.getPropertyValue(v).trim();
    if (val) out[v] = val;
  }
  out['color-scheme'] = cs.colorScheme || 'light';
  return out;
}

function frameCsp(runtime: string): string {
  return [
    "default-src 'none'",
    `script-src ${runtime} blob:`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export class PluginFrame {
  readonly iframe: HTMLIFrameElement;
  readonly ready: Promise<void>;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private onMessage: (e: MessageEvent) => void;
  private destroyed = false;

  constructor(private o: FrameOptions) {
    const runtime = new URL(runtimeUrl, document.baseURI).href;
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('allow', '');
    f.title = `${o.manifest.name}${o.role === 'panel' ? ' panel' : ''}`;
    f.dataset.plugin = o.manifest.id;
    f.className = o.role === 'panel' ? 'plugin-frame' : 'plugin-frame is-hidden';
    if (o.role === 'main') f.setAttribute('aria-hidden', 'true');
    f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(runtime)}"><script src="${runtime}"></script></head><body></body></html>`;
    this.iframe = f;

    let markReady: () => void = () => {};
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      setTimeout(() => reject(new PluginApiError('timeout', `${o.manifest.name} did not start within 15 s.`)), 15_000);
    });
    this.ready.catch(() => {});

    this.onMessage = (e: MessageEvent) => {
      if (e.source !== f.contentWindow || !isProtocolMessage(e.data)) return;
      const m = e.data as PluginToHost;
      if (m.kind === 'ready') markReady();
      else if (m.kind === 'log') o.onLog?.(m.level, m.message);
      else if (m.kind === 'reply') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else p.reject(new PluginApiError(m.error.code, m.error.message));
      } else if (m.kind === 'call') {
        void o.onCall(m.method, Array.isArray(m.params) ? m.params : []).then(
          (value) => this.post(envelope({ kind: 'result' as const, id: m.id, ok: true as const, value: value === undefined ? null : value })),
          (err) => this.post(envelope({ kind: 'result' as const, id: m.id, ok: false as const, error: toWireError(err) as WireError })),
        );
      }
    };
    window.addEventListener('message', this.onMessage);
    f.addEventListener('load', () => {
      this.post({ p: PROTOCOL, v: PROTOCOL_VERSION, kind: 'boot', code: o.code, role: o.role, ...(o.panelId ? { panelId: o.panelId } : {}), theme: theme() } as never);
    });
    (o.container ?? document.body).append(f);
  }

  private post(m: unknown): void {
    if (!this.destroyed) this.iframe.contentWindow?.postMessage(m, '*');
  }

  /** Runs a registered handler (command, AI tool, importer, exporter) and returns its result. */
  async invoke(target: InvokeTarget, name: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginApiError('timeout', `${this.o.manifest.name} did not finish “${name}” within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.post(envelope({ kind: 'invoke' as const, id, target, name, args }));
    });
  }

  /** Delivers an event (or a message from another frame of the same plugin). */
  event(name: string, data: unknown): void {
    this.post(envelope({ kind: 'event' as const, name, data }));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('message', this.onMessage);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PluginApiError('unavailable', `${this.o.manifest.name} was stopped.`));
    }
    this.pending.clear();
    this.iframe.remove();
  }
}
