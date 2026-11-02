/**
 * Runs inside a plugin's sandboxed frame (bundled on its own and loaded as the frame's only
 * script). It waits for the host's `boot` message with the plugin's code, loads that code as an
 * ES module from a blob: URL created inside the sandbox, and gives it the `InkwrightAPI` built
 * over postMessage to the parent. Main frames call `activate`; panel frames render one panel.
 *
 * The frame's own Content Security Policy (set by the host, see sandbox.ts) allows only this
 * script and blob: modules, no network, and no other frames; the iframe sandbox gives it an
 * opaque origin, so it has no cookies, storage or access to the app.
 */
import { PROTOCOL, PROTOCOL_VERSION, createPluginClient, envelope, type PluginModule, type PluginToHost } from '@inkwright/plugin-api';

interface Boot {
  p: typeof PROTOCOL;
  v: typeof PROTOCOL_VERSION;
  kind: 'boot';
  code: string;
  role: 'main' | 'panel';
  panelId?: string;
  theme?: Record<string, string>;
}

/**
 * WebRTC is the one way out of the frame that its `connect-src 'none'` does not cover: a peer
 * connection reaches any STUN/TURN server it names (and leaks through the DNS lookup), without the
 * `network` permission (security review SR-12). Plugins have no use for it, so the constructors
 * are removed before any plugin code exists. A nested frame can't bring them back: inside this
 * opaque-origin sandbox every child frame is cross-origin to the plugin.
 */
for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'RTCCertificate']) {
  try {
    delete (globalThis as Record<string, unknown>)[k];
  } catch {
    /* not present in this browser */
  }
}

const send = (m: PluginToHost) => parent.postMessage(m, '*');
const log = (level: 'info' | 'warn' | 'error', message: string) => send(envelope({ kind: 'log' as const, level, message }));

let booted = false;

addEventListener('message', async (e: MessageEvent) => {
  const m = e.data as Boot;
  if (e.source !== parent || booted || !m || m.p !== PROTOCOL || m.v !== PROTOCOL_VERSION || m.kind !== 'boot') return;
  booted = true;
  applyTheme(m.theme ?? {});
  const client = createPluginClient({
    send,
    listen(h) {
      const l = (ev: MessageEvent) => { if (ev.source === parent) h(ev.data); };
      addEventListener('message', l);
      return () => removeEventListener('message', l);
    },
  });
  // Unhandled errors in plugin code show up in the host's plugin log, not silently.
  addEventListener('error', (ev) => log('error', ev.message));
  addEventListener('unhandledrejection', (ev) => log('error', String((ev.reason as Error)?.message ?? ev.reason)));
  try {
    const url = URL.createObjectURL(new Blob([m.code], { type: 'text/javascript' }));
    const mod = (await import(/* @vite-ignore */ url)) as { default?: PluginModule | ((api: unknown) => unknown) };
    URL.revokeObjectURL(url);
    const plugin: PluginModule = typeof mod.default === 'function' ? { activate: mod.default as PluginModule['activate'] } : (mod.default ?? {});
    if (m.role === 'main') {
      await plugin.activate?.(client.api);
    } else {
      const render = m.panelId ? plugin.panels?.[m.panelId] : undefined;
      if (!render) throw new Error(`This plugin has no panel "${m.panelId}".`);
      await render(document.body, client.api);
      // Grow the frame to its content.
      const fit = () => client.api.ui.setHeight?.(Math.ceil(document.documentElement.scrollHeight));
      new ResizeObserver(fit).observe(document.body);
      fit();
    }
    send(envelope({ kind: 'ready' as const }));
  } catch (err) {
    log('error', `Could not start: ${(err as Error).message ?? err}`);
    send(envelope({ kind: 'ready' as const }));
  }
});

/** The app's palette as CSS variables, so panels look like the rest of Inkwright. */
function applyTheme(theme: Record<string, string>): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme)) if (/^--[a-z0-9-]+$/.test(k)) root.style.setProperty(k, v);
  const style = document.createElement('style');
  style.textContent = `
    :root { color-scheme: ${theme['color-scheme'] ?? 'light'}; }
    html, body { margin: 0; background: transparent; color: var(--ink, #2b2330); font: 15px/1.5 var(--font-ui, system-ui, sans-serif); }
    body { padding: 2px; }
    button { font: inherit; color: inherit; background: var(--chrome, #f1eff3); border: 1px solid var(--line, rgba(0,0,0,.1)); border-radius: 10px; padding: 6px 12px; cursor: pointer; }
    a { color: var(--iron, #356b53); }
    input, textarea, select { font: inherit; color: inherit; background: var(--raised, #fff); border: 1px solid var(--line-strong, rgba(0,0,0,.2)); border-radius: 8px; padding: 6px 8px; }
  `;
  document.head.append(style);
}
