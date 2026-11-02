import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Switch, cx } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { useApp } from '../state/app.ts';
import { applyPlan, applyPreset, getModule, listModules, listPresets, planToggle, resetModules, useModules, isModuleOn, type ModuleContributions, type ModuleDefinition } from './registry.ts';

const KIND_LABEL: Record<keyof ModuleContributions, string> = {
  menuItems: 'Menu items',
  paletteActions: 'Search palette actions',
  panels: 'Panels',
  objectTypes: 'Page objects',
  aiTools: 'Assistant tools',
  importers: 'Importers',
  exporters: 'Exporters',
  routineTemplates: 'Routine templates',
  settingsSections: 'Settings sections',
  screens: 'Screens',
  background: 'In the background',
};

const names = (ids: string[]) => ids.map((id) => getModule(id)?.name ?? id).join(', ');

/** Settings › Modules: every feature with an on/off switch, presets, and dependency handling. */
export function ModulesSettings() {
  const enabled = useModules((s) => s.enabled);
  const preset = useModules((s) => s.preset);
  const toast = useApp((a) => a.toast);
  const modules = listModules();

  const toggle = async (m: ModuleDefinition, on: boolean) => {
    const plan = planToggle(m.id, on, enabled);
    if (on) {
      const extra = plan.enable.filter((x) => x !== m.id);
      applyPlan(plan);
      if (extra.length) toast({ text: `${m.name} needs ${names(extra)}, so that is on too.` });
      return;
    }
    const extra = plan.disable.filter((x) => x !== m.id);
    if (extra.length && !(await askConfirm(`Turn off ${m.name}?`, `${names(extra)} ${extra.length === 1 ? 'needs' : 'need'} it and will be turned off too. Your notes keep everything they contain.`, 'Turn off'))) return;
    applyPlan(plan);
  };

  return (
    <>
      <section className="set-group">
        <h2>Start from a preset</h2>
        <div className="set-card">
          <div className="mod-presets" role="radiogroup" aria-label="Presets">
            {listPresets().map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={cx('mod-preset', preset === p.id && 'is-on')} onClick={() => { applyPreset(p.id); toast({ text: `${p.name} preset applied`, tone: 'success' }); }}>
                <span className="mod-preset-name">{p.name}</span>
                <span className="mod-preset-desc">{p.description}</span>
              </button>
            ))}
          </div>
        </div>
        <p className="set-note">A preset switches the modules below; you can change any of them afterwards. Writing, pages, notebooks, sync, export and undo are always on.</p>
      </section>
      <section className="set-group">
        <h2>Modules</h2>
        <div className="set-card mod-list">
          {modules.map((m) => <ModuleRow key={m.id} m={m} on={isModuleOn(m.id, enabled)} onToggle={(v) => void toggle(m, v)} />)}
        </div>
        <p className="set-note">
          Turning a module off removes its menus, panels, background work and assistant tools on this device. Notes keep everything they contain; it shows as it was and comes back to life when you turn the module on again.{' '}
          <button type="button" className="link-btn" onClick={() => resetModules()}>Back to defaults</button>
        </p>
      </section>
    </>
  );
}

function ModuleRow({ m, on, onToggle }: { m: ModuleDefinition; on: boolean; onToggle: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const kinds = (Object.keys(m.contributes) as (keyof ModuleContributions)[]).filter((k) => m.contributes[k]?.length);
  return (
    <div className="mod-row" data-module={m.id}>
      <Switch label={m.name} hint={m.description} checked={on} onChange={onToggle} />
      <div className="mod-meta">
        {m.dependencies?.length ? <span className="mod-needs">Needs {names(m.dependencies)}</span> : null}
        {kinds.length > 0 && (
          <button type="button" className="mod-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            What it adds <ChevronDown size={14} className={cx('mod-chev', open && 'is-open')} />
          </button>
        )}
      </div>
      {open && (
        <dl className="mod-adds">
          {kinds.map((k) => (
            <div key={k}><dt>{KIND_LABEL[k]}</dt><dd>{m.contributes[k]!.join(', ')}</dd></div>
          ))}
          {m.whenOff && <div><dt>When off</dt><dd>{m.whenOff}</dd></div>}
        </dl>
      )}
    </div>
  );
}
