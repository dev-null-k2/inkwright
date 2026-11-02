/**
 * `window.inkstone` — the plugin API for scripts on this page: browser extensions, userscripts,
 * the devtools console, or a page that embeds Inkstone. Off by default; Settings › Developer ›
 * Automation API switches it on and chooses its permissions.
 *
 * It is the plugin API with the same permission model: calls go through the same dispatcher
 * (plugins/dispatcher.ts) as sandboxed plugins, under a caller named "Automation API" that holds
 * only the permissions ticked in Settings. Writes appear in Activity under that name.
 *
 *   await inkstone.notes.list({ tag: 'work' })
 *   inkstone.events.on('note.updated', (e) => console.log(e.title))
 *   inkstone.commands.register('stamp', () => inkstone.editor.insertText(new Date().toString()), { title: 'Insert date' })
 */
import { createElement } from 'react';
import { create } from 'zustand';
import { Terminal } from 'lucide-react';
import { createPluginClient, envelope, isProtocolMessage, toWireError, type InkstoneAPI, type Permission, type PluginToHost } from '@inkstone/plugin-api';
import { safeStorage } from '../platform/env.ts';
import { registerPaletteActions } from '../lib/palette.ts';
import { dispatch, type Caller } from '../plugins/dispatcher.ts';
import { hostEnv, setEventSink } from '../plugins/host.ts';

export interface AutomationSettings {
  enabled: boolean;
  permissions: Permission[];
  /** Sites `net.fetch` may reach. */
  hosts: string[];
}

const KEY = 'inkstone.developer.v1';

function load(): AutomationSettings {
  try {
    const v = JSON.parse(safeStorage.get(KEY) ?? 'null') as { automation?: Partial<AutomationSettings> } | null;
    const a = v?.automation ?? {};
    return { enabled: a.enabled === true, permissions: Array.isArray(a.permissions) ? a.permissions : ['notes:read', 'editor:read', 'events'], hosts: Array.isArray(a.hosts) ? a.hosts : [] };
  } catch {
    return { enabled: false, permissions: ['notes:read', 'editor:read', 'events'], hosts: [] };
  }
}

/** Per device: a script on this browser is not a script on the phone. */
export const useAutomation = create<AutomationSettings>(() => load());
useAutomation.subscribe((s) => safeStorage.set(KEY, JSON.stringify({ automation: s })));

export type AutomationAPI = Omit<InkstoneAPI, 'commands'> & {
  readonly version: 1;
  readonly commands: {
    /** Adds a command; with `title` it also appears in the search palette. */
    register(id: string, run: () => void | Promise<void>, opts?: { title?: string }): void;
  };
};

declare global {
  interface Window {
    inkstone?: AutomationAPI;
  }
}

/** Builds the API over an in-process channel to the dispatcher. */
function createAutomationApi(): { api: AutomationAPI; close(): void } {
  const toClient = new Set<(m: unknown) => void>();
  const pending = new Map<number, (m: PluginToHost) => void>();
  let seq = 0;
  const commands = new Map<string, string>();
  const caller: Caller = {
    id: 'automation',
    label: 'Automation API',
    permissions: () => new Set(useAutomation.getState().enabled ? useAutomation.getState().permissions : []),
    networkHosts: useAutomation.getState().hosts,
    storage: {
      get: async (k) => JSON.parse(safeStorage.get(`inkstone.automation.storage.${k}`) ?? 'null') ?? undefined,
      set: async (k, v) => safeStorage.set(`inkstone.automation.storage.${k}`, JSON.stringify(v)),
      delete: async (k) => safeStorage.remove(`inkstone.automation.storage.${k}`),
      keys: async () => {
        const out: string[] = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith('inkstone.automation.storage.')) out.push(k.slice('inkstone.automation.storage.'.length));
          }
        } catch {
          /* storage blocked */
        }
        return out;
      },
    },
    settings: async () => ({}),
    subscribe: (event) => {
      sink.events.add(event);
      setEventSink('automation', sink);
    },
    postMessage: () => {},
    addCommand: (id, title) => { commands.set(id, title); },
  };
  const sink = {
    events: new Set<string>(),
    allowed: (note?: { locked: boolean }) => caller.permissions().has('events') && !note?.locked,
    deliver: (name: string, data: unknown) => { for (const l of toClient) l(envelope({ kind: 'event' as const, name, data })); },
  };
  const deliver = (m: unknown) => queueMicrotask(() => { for (const l of toClient) l(m); });

  const client = createPluginClient({
    send(m) {
      if (!isProtocolMessage(m)) return;
      if (m.kind === 'call') {
        // Hosts are read per call, so editing them in Settings applies at once.
        caller.networkHosts = useAutomation.getState().hosts;
        dispatch(hostEnv(), caller, m.method, m.params).then(
          (value) => deliver(envelope({ kind: 'result' as const, id: m.id, ok: true as const, value: value === undefined ? null : value })),
          (e) => deliver(envelope({ kind: 'result' as const, id: m.id, ok: false as const, error: toWireError(e) })),
        );
      } else if (m.kind === 'reply') pending.get(m.id)?.(m);
    },
    listen(h) {
      toClient.add(h);
      return () => toClient.delete(h);
    },
  });

  const invoke = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => {
        pending.delete(id);
        if (m.kind === 'reply' && m.ok) resolve();
        else reject(new Error(m.kind === 'reply' && !m.ok ? m.error.message : 'failed'));
      });
      deliver(envelope({ kind: 'invoke' as const, id, target: 'command' as const, name, args: null }));
    });

  const unpalette = registerPaletteActions('automation', () =>
    [...commands].map(([id, title]) => ({ id: `automation:${id}`, label: title, keywords: 'script automation', hint: 'Script', icon: createElement(Terminal, { size: 16 }), run: () => { void invoke(id).catch((e) => console.error(e)); } })),
  );

  const api: AutomationAPI = {
    ...client.api,
    version: 1,
    commands: {
      register(id, run, opts) {
        client.api.commands.register(id, run);
        if (opts?.title) void dispatch(hostEnv(), caller, 'commands.add', [id, opts.title]);
      },
    },
  };
  return {
    api: Object.freeze(api),
    close() {
      client.close();
      unpalette();
      setEventSink('automation', null);
    },
  };
}

/** Developer module: keeps `window.inkstone` in step with the Settings switch. */
export function startAutomationApi(): () => void {
  let current: { api: AutomationAPI; close(): void } | null = null;
  const apply = (on: boolean) => {
    if (on && !current) {
      current = createAutomationApi();
      Object.defineProperty(window, 'inkstone', { value: current.api, configurable: true, enumerable: false, writable: false });
      window.dispatchEvent(new CustomEvent('inkstone:ready'));
    } else if (!on && current) {
      current.close();
      current = null;
      delete window.inkstone;
    }
  };
  apply(useAutomation.getState().enabled);
  const unsub = useAutomation.subscribe((s) => apply(s.enabled));
  return () => {
    unsub();
    apply(false);
  };
}
