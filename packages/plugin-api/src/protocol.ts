/**
 * The wire protocol between a sandboxed plugin frame and the app (the host), over
 * `postMessage`. Versioned: every message carries `p: "inkstone-plugin"` and `v: 1`, and the
 * host ignores anything else, so a future v2 can run side by side with v1 plugins.
 *
 * Plugin → host: `ready`, `call` (an API method, answered by `result`), `reply` (the answer to a
 * host `invoke`), `log`. Host → plugin: `boot`, `result`, `invoke` (run a command, AI tool,
 * importer or exporter handler), `event`.
 */
import type { PluginManifest } from './manifest.ts';
import type { Permission } from './permissions.ts';

export const PROTOCOL = 'inkstone-plugin' as const;
export const PROTOCOL_VERSION = 1 as const;

export type ErrorCode = 'permission_denied' | 'out_of_scope' | 'not_found' | 'invalid_argument' | 'unavailable' | 'timeout' | 'internal';

export interface WireError {
  code: ErrorCode;
  message: string;
}

/** Error thrown by API calls; `code` says why (stable, for programs), `message` is for people. */
export class PluginApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'PluginApiError';
    this.code = code;
  }
}

interface Envelope {
  p: typeof PROTOCOL;
  v: typeof PROTOCOL_VERSION;
}

export type InvokeTarget = 'command' | 'aiTool' | 'importer' | 'exporter';

export type PluginToHost = Envelope &
  (
    | { kind: 'ready' }
    | { kind: 'call'; id: number; method: MethodName; params: unknown[] }
    | { kind: 'reply'; id: number; ok: true; value: unknown }
    | { kind: 'reply'; id: number; ok: false; error: WireError }
    | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  );

export type HostToPlugin = Envelope &
  (
    | { kind: 'boot'; manifest: PluginManifest; code: string; role: 'main' | 'panel'; panelId?: string; permissions: Permission[]; appVersion: string; platform: string }
    | { kind: 'result'; id: number; ok: true; value: unknown }
    | { kind: 'result'; id: number; ok: false; error: WireError }
    | { kind: 'invoke'; id: number; target: InvokeTarget; name: string; args: unknown }
    | { kind: 'event'; name: string; data: unknown }
  );

/**
 * API methods and the permission each one needs (`null`: none). The host refuses calls to
 * methods not listed here, so this table is the complete attack surface of a plugin.
 */
export const METHODS = {
  'app.info': null,
  'notes.list': 'notes:read',
  'notes.search': 'notes:read',
  'notes.get': 'notes:read',
  'notes.create': 'notes:write',
  'notes.append': 'notes:write',
  'notes.update': 'notes:write',
  'editor.current': 'editor:read',
  'editor.selection': 'editor:read',
  'editor.insertText': 'editor:write',
  'events.subscribe': 'events',
  'storage.get': null,
  'storage.set': null,
  'storage.delete': null,
  'storage.keys': null,
  'settings.get': null,
  'net.fetch': 'network',
  'ui.toast': null,
  'ui.openNote': null,
  'ui.setHeight': null,
  'clipboard.writeText': 'clipboard:write',
  'messages.post': null,
  /** Automation API only (`window.inkstone`): plugins declare commands in their manifest. */
  'commands.add': null,
} as const satisfies Record<string, Permission | null>;

export type MethodName = keyof typeof METHODS;

export function isMethod(v: unknown): v is MethodName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(METHODS, v);
}

/** The permission a method needs, or null. */
export function permissionFor(method: MethodName): Permission | null {
  return METHODS[method];
}

export function envelope<T extends object>(body: T): Envelope & T {
  return { p: PROTOCOL, v: PROTOCOL_VERSION, ...body };
}

/** True for well-formed messages of this protocol version (anything else is dropped). */
export function isProtocolMessage(data: unknown): data is Envelope & { kind: string } {
  return !!data && typeof data === 'object' && (data as Envelope).p === PROTOCOL && (data as Envelope).v === PROTOCOL_VERSION && typeof (data as { kind?: unknown }).kind === 'string';
}

/** Turns anything thrown into a wire error without leaking stack traces. */
export function toWireError(e: unknown): WireError {
  if (e instanceof PluginApiError) return { code: e.code, message: e.message };
  const code = (e as { code?: unknown })?.code;
  const known: ErrorCode[] = ['permission_denied', 'out_of_scope', 'not_found', 'invalid_argument', 'unavailable', 'timeout', 'internal'];
  return { code: known.includes(code as ErrorCode) ? (code as ErrorCode) : 'internal', message: e instanceof Error ? e.message : String(e) };
}
