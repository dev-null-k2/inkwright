/**
 * The plugin side of the protocol: builds an `InkwrightAPI` over any message transport. The
 * sandbox runtime uses it with `parent.postMessage`; tests and the in-page automation API use it
 * with an in-process channel. The client keeps the handlers a plugin registers (commands, AI
 * tools, importers, exporters) and answers the host's `invoke` messages with them.
 */
import type { CommandHandler, EventPayloads, ExportHandler, ImportHandler, InkwrightAPI, NoteEvent, ToolHandler } from './api.ts';
import { PluginApiError, envelope, isProtocolMessage, toWireError, type HostToPlugin, type InvokeTarget, type MethodName, type PluginToHost } from './protocol.ts';

export interface ClientTransport {
  send(message: PluginToHost): void;
  /** Delivers host messages to `handler` (the client filters by protocol). */
  listen(handler: (message: unknown) => void): () => void;
}

export interface PluginClient {
  api: InkwrightAPI;
  /** Stops listening and rejects pending calls. */
  close(): void;
}

type Handler = (args: unknown) => unknown;

export function createPluginClient(transport: ClientTransport, opts: { timeoutMs?: number } = {}): PluginClient {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const handlers: Record<InvokeTarget, Map<string, Handler>> = { command: new Map(), aiTool: new Map(), importer: new Map(), exporter: new Map() };
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const messageListeners = new Set<(data: unknown) => void>();
  const subscribed = new Set<string>();

  const call = <T>(method: MethodName, ...params: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PluginApiError('timeout', `${method} did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      transport.send(envelope({ kind: 'call' as const, id, method, params }));
    });

  const register = (target: InvokeTarget) => (name: string, run: Handler) => {
    if (typeof run !== 'function') throw new PluginApiError('invalid_argument', `The handler for ${name} must be a function.`);
    handlers[target].set(name, run);
  };

  const onMessage = async (raw: unknown) => {
    if (!isProtocolMessage(raw)) return;
    const msg = raw as HostToPlugin;
    if (msg.kind === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new PluginApiError(msg.error.code, msg.error.message));
    } else if (msg.kind === 'invoke') {
      const run = handlers[msg.target]?.get(msg.name);
      try {
        if (!run) throw new PluginApiError('not_found', `This plugin has no handler for ${msg.target} "${msg.name}".`);
        const value = await run(msg.args);
        transport.send(envelope({ kind: 'reply' as const, id: msg.id, ok: true as const, value: value === undefined ? null : value }));
      } catch (e) {
        transport.send(envelope({ kind: 'reply' as const, id: msg.id, ok: false as const, error: toWireError(e) }));
      }
    } else if (msg.kind === 'event') {
      if (msg.name === 'message') for (const l of messageListeners) l(msg.data);
      else for (const l of listeners.get(msg.name) ?? []) l(msg.data);
    }
  };
  const stop = transport.listen((m) => void onMessage(m));

  const api: InkwrightAPI = {
    app: { info: () => call('app.info') },
    notes: {
      list: (o = {}) => call('notes.list', o),
      search: (query, o = {}) => call('notes.search', query, o),
      get: (id) => call('notes.get', id),
      create: (note) => call('notes.create', note),
      append: (id, text) => call('notes.append', id, text),
      update: (id, patch) => call('notes.update', id, patch),
    },
    editor: {
      current: () => call('editor.current'),
      selection: () => call('editor.selection'),
      insertText: (text) => call('editor.insertText', text),
    },
    commands: { register: register('command') as (id: string, run: CommandHandler) => void },
    ai: { registerTool: register('aiTool') as (name: string, run: ToolHandler) => void },
    importers: { register: register('importer') as (id: string, run: ImportHandler) => void },
    exporters: { register: register('exporter') as (id: string, run: ExportHandler) => void },
    events: {
      on<E extends NoteEvent>(event: E, listener: (data: EventPayloads[E]) => void) {
        let set = listeners.get(event);
        if (!set) listeners.set(event, (set = new Set()));
        set.add(listener as (d: unknown) => void);
        if (!subscribed.has(event)) {
          subscribed.add(event);
          // A refused subscription surfaces as an unhandled rejection in the plugin's console.
          void call('events.subscribe', event).catch((e) => {
            subscribed.delete(event);
            transport.send(envelope({ kind: 'log' as const, level: 'error' as const, message: `events.on("${event}"): ${(e as Error).message}` }));
          });
        }
        return () => void set!.delete(listener as (d: unknown) => void);
      },
    },
    storage: {
      get: (key) => call('storage.get', key),
      set: (key, value) => call('storage.set', key, value),
      delete: (key) => call('storage.delete', key),
      keys: () => call('storage.keys'),
    },
    settings: { get: () => call('settings.get') },
    net: { fetch: (url, init = {}) => call('net.fetch', url, init) },
    ui: {
      toast: (text, tone = 'info') => call('ui.toast', text, tone),
      openNote: (id, page) => call('ui.openNote', id, page),
      setHeight: (px) => void call('ui.setHeight', px).catch(() => {}),
    },
    clipboard: { writeText: (text) => call('clipboard.writeText', text) },
    messages: {
      post: (data) => void call('messages.post', data).catch(() => {}),
      on: (listener) => {
        messageListeners.add(listener);
        return () => void messageListeners.delete(listener);
      },
    },
  };

  return {
    api,
    close() {
      stop();
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new PluginApiError('unavailable', 'The plugin was stopped.'));
      }
      pending.clear();
    },
  };
}
