/**
 * The module registry: every major feature declares itself here — what it is, whether it is on
 * by default, what it needs, and what it adds to the app — so people can switch features off
 * (Settings › Modules) and future features plug in the same way.
 *
 * A module's declaration is metadata plus optional runtime hooks:
 *
 * - `contributes` names everything the module adds (menu items, palette actions, panels, page
 *   object types, AI tools, importers/exporters, routine templates, settings sections, screens,
 *   background work). The app uses it: palette actions and settings sections owned by a disabled
 *   module disappear, and Settings › Modules shows the list.
 * - `activate` (lazy, dynamic-import inside) starts background work and returns how to stop it;
 *   it runs when the module is on and stops the moment it is switched off.
 * - `aiTools` adds tools to the assistant while the module is on.
 *
 * Switching a module off never touches notes: its data stays in the vault and still renders —
 * read-only, or as a placeholder (see each module's `whenOff`) — and comes back to life when it
 * is switched on again.
 */
import { create } from 'zustand';
import type { AgentTool } from '@inkstone/ai';
import { safeStorage } from '../platform/env.ts';
import { setPaletteActionFilter } from '../lib/palette.ts';

export interface ModuleContributions {
  /** Labels of the items it adds to the editor's ••• menu (and other menus). */
  menuItems?: string[];
  /** Ids of search-palette actions it owns (hidden while it is off). */
  paletteActions?: string[];
  /** Side panels and dialogs. */
  panels?: string[];
  /** Page object types it creates (`PageInk.objects[].type`); they stay drawn while it is off. */
  objectTypes?: string[];
  /** Names of assistant tools. */
  aiTools?: string[];
  importers?: string[];
  exporters?: string[];
  /** Ids of routine templates (`ROUTINE_TEMPLATES`). */
  routineTemplates?: string[];
  /** Ids of Settings sections it owns (hidden while it is off). */
  settingsSections?: string[];
  /** Whole screens (routes). */
  screens?: string[];
  /** Work it does in the background while on. */
  background?: string[];
}

export interface ModuleDefinition {
  id: string;
  name: string;
  /** One or two plain sentences: what it does for the user. */
  description: string;
  defaultEnabled: boolean;
  /** Modules that must be on for this one to work. */
  dependencies?: string[];
  contributes: ModuleContributions;
  /** What happens to existing notes' data while the module is off. */
  whenOff?: string;
  /** Starts background work (dynamic imports inside keep startup fast); returns a stop function. */
  activate?: () => Promise<(() => void) | void>;
  /** Assistant tools while the module is on. */
  aiTools?: () => Promise<AgentTool[]>;
}

export interface ModulePreset {
  id: string;
  name: string;
  description: string;
  /** Modules switched on; every other optional module is switched off. */
  modules: string[];
}

const definitions = new Map<string, ModuleDefinition>();
const presets = new Map<string, ModulePreset>();

/** Adds a module (built-ins at startup; later features the same way). Re-registering replaces it. */
export function registerModule(def: ModuleDefinition): void {
  definitions.set(def.id, def);
  useModules.setState((s) => (def.id in s.enabled ? s : { enabled: { ...s.enabled, [def.id]: stored?.enabled[def.id] ?? def.defaultEnabled } }));
}

export function registerPreset(p: ModulePreset): void {
  presets.set(p.id, p);
}

export const listModules = (): ModuleDefinition[] => [...definitions.values()];
export const getModule = (id: string): ModuleDefinition | undefined => definitions.get(id);
export const listPresets = (): ModulePreset[] => [...presets.values()];

// ---- State ---------------------------------------------------------------------------------------

const KEY = 'inkstone.modules.v1';

interface Stored {
  enabled: Record<string, boolean>;
  preset?: string | null;
}

function loadStored(): Stored | null {
  try {
    const raw = safeStorage.get(KEY);
    const v = raw ? (JSON.parse(raw) as Stored) : null;
    return v && typeof v.enabled === 'object' ? v : null;
  } catch {
    return null;
  }
}

const stored = loadStored();

interface ModulesState {
  /** Module id → on. Unknown ids (a module from a newer version) are kept untouched. */
  enabled: Record<string, boolean>;
  /** The preset last applied, while nothing was changed since. */
  preset: string | null;
}

/** Per device (like other settings): a phone can run a leaner set than the laptop. */
export const useModules = create<ModulesState>(() => ({ enabled: { ...(stored?.enabled ?? {}) }, preset: stored?.preset ?? null }));

useModules.subscribe((s) => safeStorage.set(KEY, JSON.stringify({ enabled: s.enabled, preset: s.preset })));

/** Whether a module is on (unregistered ids count as on, so gating never hides core features by mistake). */
export function isModuleOn(id: string, enabled: Record<string, boolean> = useModules.getState().enabled): boolean {
  return enabled[id] ?? definitions.get(id)?.defaultEnabled ?? true;
}

/** React hook: re-renders when the module is switched. */
export function useModule(id: string): boolean {
  return useModules((s) => isModuleOn(id, s.enabled));
}

// ---- Dependencies --------------------------------------------------------------------------------

export interface TogglePlan {
  /** Every module whose state changes, in order. */
  enable: string[];
  disable: string[];
}

/**
 * What switching `id` on or off implies: turning on also turns on everything it needs
 * (transitively); turning off also turns off everything that needs it.
 */
export function planToggle(id: string, on: boolean, enabled: Record<string, boolean> = useModules.getState().enabled): TogglePlan {
  const plan: TogglePlan = { enable: [], disable: [] };
  if (on) {
    const visit = (m: string, path: Set<string>) => {
      if (path.has(m)) return; // a cycle in declarations: stop rather than loop
      path.add(m);
      for (const dep of definitions.get(m)?.dependencies ?? []) visit(dep, path);
      if (!isModuleOn(m, enabled) && !plan.enable.includes(m)) plan.enable.push(m);
    };
    visit(id, new Set());
  } else {
    const visit = (m: string) => {
      if (plan.disable.includes(m)) return;
      if (isModuleOn(m, enabled) || m === id) plan.disable.push(m);
      for (const d of definitions.values()) if (d.dependencies?.includes(m)) visit(d.id);
    };
    visit(id);
  }
  return plan;
}

export function applyPlan(plan: TogglePlan): void {
  useModules.setState((s) => {
    const enabled = { ...s.enabled };
    for (const m of plan.enable) enabled[m] = true;
    for (const m of plan.disable) enabled[m] = false;
    return { enabled, preset: null };
  });
}

/** Switches to a preset: its modules (and what they need) on, every other module off. */
export function applyPreset(presetId: string): void {
  const p = presets.get(presetId);
  if (!p) throw new Error(`Unknown preset ${presetId}`);
  const on = new Set<string>();
  const add = (m: string) => {
    if (on.has(m)) return;
    on.add(m);
    for (const d of definitions.get(m)?.dependencies ?? []) add(d);
  };
  p.modules.forEach(add);
  useModules.setState((s) => {
    const enabled = { ...s.enabled };
    for (const d of definitions.values()) enabled[d.id] = on.has(d.id);
    return { enabled, preset: presetId };
  });
}

/** Back to each module's default. */
export function resetModules(): void {
  useModules.setState({ enabled: Object.fromEntries([...definitions.values()].map((d) => [d.id, d.defaultEnabled])), preset: null });
}

// ---- Contributions -------------------------------------------------------------------------------

/** The module that owns a contribution, if any (e.g. a palette action id or a settings section). */
export function ownerOf(kind: keyof ModuleContributions, id: string): ModuleDefinition | undefined {
  for (const d of definitions.values()) if (d.contributes[kind]?.includes(id)) return d;
  return undefined;
}

/** False when the contribution belongs to a module that is off. */
export function contributionOn(kind: keyof ModuleContributions, id: string, enabled: Record<string, boolean> = useModules.getState().enabled): boolean {
  const owner = ownerOf(kind, id);
  return !owner || isModuleOn(owner.id, enabled);
}

setPaletteActionFilter((id) => contributionOn('paletteActions', id));

/** Assistant tools from every module that is on. A failing module never breaks the assistant. */
export async function collectModuleAiTools(): Promise<AgentTool[]> {
  const out: AgentTool[] = [];
  for (const d of definitions.values()) {
    if (!d.aiTools || !isModuleOn(d.id)) continue;
    try {
      out.push(...(await d.aiTools()));
    } catch (e) {
      console.warn(`Module ${d.id} could not provide its assistant tools`, e);
    }
  }
  return out;
}

// ---- Background work ----------------------------------------------------------------------------

const running = new Map<string, Promise<(() => void) | void>>();

async function reconcile(): Promise<void> {
  for (const d of definitions.values()) {
    if (!d.activate) continue;
    const on = isModuleOn(d.id);
    const job = running.get(d.id);
    if (on && !job) {
      const started = d.activate().catch((e) => {
        console.warn(`Module ${d.id} could not start`, e);
        running.delete(d.id);
      });
      running.set(d.id, started);
    } else if (!on && job) {
      running.delete(d.id);
      void job.then((stop) => stop?.());
    }
  }
}

let unsubscribe: (() => void) | null = null;

/** Starts every enabled module's background work and follows later switches. Call once at boot. */
export function startModules(): () => void {
  void reconcile();
  unsubscribe ??= useModules.subscribe((s, prev) => { if (s.enabled !== prev.enabled) void reconcile(); });
  return () => {
    unsubscribe?.();
    unsubscribe = null;
    for (const [id, job] of running) {
      running.delete(id);
      void job.then((stop) => stop?.());
    }
  };
}

/** Test helper: forget every registration. */
export function __resetRegistryForTests(): void {
  definitions.clear();
  presets.clear();
  running.clear();
  unsubscribe?.();
  unsubscribe = null;
  useModules.setState({ enabled: {}, preset: null });
}
