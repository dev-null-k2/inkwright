/**
 * The bridge to the desktop shell (apps/desktop, Tauri 2). Everything desktop-only goes through
 * here, and every call is a dynamic import of `@tauri-apps/api`, so the web and Android builds
 * never load it. `isDesktop` is decided at run time (the shell injects `__TAURI_INTERNALS__`), not
 * by the build, so a desktop build opened in a browser behaves as the web app.
 */

export const isDesktop: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export class NotOnDesktopError extends Error {
  constructor() {
    super('This needs the Inkwright desktop app.');
    this.name = 'NotOnDesktopError';
  }
}

/** Calls a command of the desktop shell (src-tauri/src/lib.rs). */
export async function invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  if (!isDesktop) throw new NotOnDesktopError();
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(cmd, args as Record<string, unknown> | undefined, headers ? { headers } : undefined);
}

/** Listens to an event from the shell; resolves to the unsubscribe function. */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  const { listen: on } = await import('@tauri-apps/api/event');
  return on<T>(event, (e) => handler(e.payload));
}

/** Byte responses (`tauri::ipc::Response`) arrive as an ArrayBuffer. */
export function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  // Checked by tag, not instanceof: buffers can come from another realm (a worker, a test DOM).
  if (Object.prototype.toString.call(v) === '[object ArrayBuffer]') return new Uint8Array(v as ArrayBuffer);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('Expected bytes from the desktop app');
}

export interface DesktopInfo {
  version: string;
  os: 'macos' | 'windows' | 'linux' | string;
  arch: string;
  vaultDir: string;
  keepInTray: boolean;
  mcpEnabled: boolean;
  mcpPort: number;
  updatesConfigured: boolean;
  sidecarBundled: boolean;
}

export const desktopInfo = () => invoke<DesktopInfo>('desktop_info');

export interface McpInfo {
  running: boolean;
  url: string | null;
  binary: string | null;
  error: string | null;
  log: string[];
  enabled: boolean;
  port: number;
  token: string;
}

export const mcpStatus = () => invoke<McpInfo>('mcp_status');
export const mcpConfigure = (o: { enabled: boolean; port?: number; newToken?: boolean }) => invoke<McpInfo>('mcp_configure', o);
