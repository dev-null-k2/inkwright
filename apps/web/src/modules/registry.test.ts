import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRegistryForTests,
  applyPlan,
  applyPreset,
  collectModuleAiTools,
  contributionOn,
  isModuleOn,
  planToggle,
  registerModule,
  registerPreset,
  resetModules,
  startModules,
  useModules,
  type ModuleDefinition,
} from './registry.ts';
import { BUILTIN_MODULES, BUILTIN_PRESETS } from './builtin.ts';
import { findActions, registerPaletteActions } from '../lib/palette.ts';

const mod = (id: string, p: Partial<ModuleDefinition> = {}): ModuleDefinition => ({ id, name: id.toUpperCase(), description: '', defaultEnabled: true, contributes: {}, ...p });

beforeEach(() => __resetRegistryForTests());
afterEach(() => __resetRegistryForTests());

describe('module registry', () => {
  it('uses defaults until switched and treats unknown ids as on', () => {
    registerModule(mod('a'));
    registerModule(mod('b', { defaultEnabled: false }));
    expect(isModuleOn('a')).toBe(true);
    expect(isModuleOn('b')).toBe(false);
    expect(isModuleOn('never-registered')).toBe(true);
  });

  it('turns on what a module needs, transitively', () => {
    registerModule(mod('base', { defaultEnabled: false }));
    registerModule(mod('mid', { defaultEnabled: false, dependencies: ['base'] }));
    registerModule(mod('top', { defaultEnabled: false, dependencies: ['mid'] }));
    const plan = planToggle('top', true);
    expect(plan.enable).toEqual(['base', 'mid', 'top']);
    applyPlan(plan);
    expect(['base', 'mid', 'top'].every((m) => isModuleOn(m))).toBe(true);
  });

  it('turns off what depends on a module, and survives dependency cycles', () => {
    registerModule(mod('knowledge'));
    registerModule(mod('graph', { dependencies: ['knowledge'] }));
    registerModule(mod('x', { dependencies: ['y'] }));
    registerModule(mod('y', { dependencies: ['x'] }));
    expect(planToggle('knowledge', false).disable).toEqual(['knowledge', 'graph']);
    expect(planToggle('x', false).disable.sort()).toEqual(['x', 'y']);
    applyPlan(planToggle('x', false));
    expect(planToggle('x', true).enable.sort()).toEqual(['x', 'y']);
  });

  it('applies presets: listed modules and their needs on, the rest off', () => {
    registerModule(mod('a'));
    registerModule(mod('b', { dependencies: ['c'] }));
    registerModule(mod('c', { defaultEnabled: false }));
    registerPreset({ id: 'p', name: 'P', description: '', modules: ['b'] });
    applyPreset('p');
    expect([isModuleOn('a'), isModuleOn('b'), isModuleOn('c')]).toEqual([false, true, true]);
    expect(useModules.getState().preset).toBe('p');
    applyPlan(planToggle('a', true));
    expect(useModules.getState().preset).toBeNull();
    resetModules();
    expect([isModuleOn('a'), isModuleOn('c')]).toEqual([true, false]);
  });

  it('hides contributions of switched-off modules, including palette actions', () => {
    registerModule(mod('kb', { contributes: { paletteActions: ['kb-today'], settingsSections: ['knowledge'] } }));
    const off = registerPaletteActions('test', () => [{ id: 'kb-today', label: 'Today', run() {} }, { id: 'other', label: 'Other', run() {} }]);
    expect(findActions('').map((a) => a.id)).toContain('kb-today');
    applyPlan(planToggle('kb', false));
    expect(contributionOn('settingsSections', 'knowledge')).toBe(false);
    expect(contributionOn('settingsSections', 'about')).toBe(true);
    expect(findActions('').map((a) => a.id)).toEqual(['other']);
    off();
  });

  it('starts background work lazily and stops it when switched off', async () => {
    const stop = vi.fn();
    const activate = vi.fn(async () => stop);
    registerModule(mod('bg', { activate }));
    const dispose = startModules();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    applyPlan(planToggle('bg', false));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    applyPlan(planToggle('bg', true));
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    dispose();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  });

  it('collects assistant tools only from modules that are on, and survives a failing one', async () => {
    const tool = { name: 't', description: '', parameters: { type: 'object' }, execute: async () => 'ok' };
    registerModule(mod('good', { aiTools: async () => [tool] }));
    registerModule(mod('bad', { aiTools: async () => { throw new Error('boom'); } }));
    registerModule(mod('off', { defaultEnabled: false, aiTools: async () => [{ ...tool, name: 'nope' }] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await collectModuleAiTools()).map((t) => t.name)).toEqual(['t']);
    warn.mockRestore();
  });
});

describe('built-in modules and presets', () => {
  it('declare valid, unique ids and dependencies that exist', () => {
    const ids = BUILTIN_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of BUILTIN_MODULES) for (const d of m.dependencies ?? []) expect(ids).toContain(d);
    for (const p of BUILTIN_PRESETS) for (const m of p.modules) expect(ids).toContain(m);
    expect(BUILTIN_PRESETS.map((p) => p.name)).toEqual(['Student', 'Writer', 'Developer', 'Researcher', 'Enterprise', 'Minimal']);
  });

  it('presets make sense: Minimal is bare, Enterprise has no third-party code, Developer has everything', () => {
    for (const m of BUILTIN_MODULES) registerModule(m);
    for (const p of BUILTIN_PRESETS) registerPreset(p);
    applyPreset('minimal');
    expect(BUILTIN_MODULES.filter((m) => isModuleOn(m.id))).toEqual([]);
    applyPreset('enterprise');
    expect(isModuleOn('plugins')).toBe(false);
    expect(isModuleOn('developer')).toBe(false);
    expect(isModuleOn('authorship')).toBe(true);
    applyPreset('developer');
    expect(BUILTIN_MODULES.every((m) => isModuleOn(m.id))).toBe(true);
  });
});
