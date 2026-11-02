import { create } from 'zustand';
import { safeStorage } from '../platform/env.ts';

/**
 * The developer module's own small settings slice, so turning it off removes it entirely: no
 * editor menu, no code-link badges or runbook buttons, no palette actions, no agent tools, and
 * nothing of it loads (tree-sitter, SQLite) until it is on. On by default on computers and
 * tablets, off on phones (where nobody mounts a repository).
 */
export interface DevSettings {
  devTools: boolean;
  /** Variables for ```http blocks (`{{name}}`), e.g. a base URL. Never secrets: they sync nowhere but are shown. */
  httpVars: Record<string, string>;
}

const KEY = 'inkwright.dev.v1';

function isPhone(): boolean {
  try {
    return window.matchMedia('(pointer: coarse) and (max-width: 699px)').matches;
  } catch {
    return false;
  }
}

function load(): DevSettings {
  const defaults: DevSettings = { devTools: !isPhone(), httpVars: {} };
  try {
    const raw = safeStorage.get(KEY);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<DevSettings>) } : defaults;
  } catch {
    return defaults;
  }
}

interface Store extends DevSettings {
  set: (patch: Partial<DevSettings>) => void;
}

export const useDevSettings = create<Store>((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    const { set: _s, ...rest } = get();
    safeStorage.set(KEY, JSON.stringify(rest));
  },
}));

export const devToolsOn = () => useDevSettings.getState().devTools;
