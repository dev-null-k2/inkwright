/**
 * The frame of Settings: a search field, eight groups and, inside a group, its sections as tabs.
 *
 * Wide screens (≥ 900 px) show the groups in a side column next to the open group. Phones and
 * folded screens show the group list first (each with a line saying what is inside); opening a
 * group fills the screen and Back returns to the list. The section components themselves live in
 * screens/Settings.tsx and elsewhere; this file only decides where they appear.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, Blocks, Bot, ChevronRight, Cloud, Info, Palette, PenLine, ShieldCheck, Waypoints } from 'lucide-react';
import { useApp } from '../state/app.ts';
import { IconButton, cx, useMediaQuery } from '../ui/primitives.tsx';
import { contributionOn, useModules } from '../modules/registry.ts';
import { GROUPS, SECTION_LABELS, resolveSettingsTarget, type GroupId, type SectionId, type SettingMatch, type SettingsTarget } from './groups.ts';
import { SettingsSearch, revealSetting } from './SettingsSearch.tsx';

const ICONS: Record<GroupId, ReactNode> = {
  writing: <PenLine size={17} />,
  appearance: <Palette size={17} />,
  ai: <Bot size={17} />,
  sync: <Cloud size={17} />,
  knowledge: <Waypoints size={17} />,
  privacy: <ShieldCheck size={17} />,
  extend: <Blocks size={17} />,
  about: <Info size={17} />,
};

export function SettingsLayout({ section, renderSection }: { section?: string; renderSection: (id: SectionId) => ReactNode }) {
  const navigate = useApp((s) => s.navigate);
  const wide = useMediaQuery('(min-width: 900px)');
  // Sections owned by a switched-off module (Settings › Extend › Modules) are hidden.
  const mods = useModules((m) => m.enabled);
  const visible = useMemo(() => new Set(GROUPS.flatMap((g) => g.sections).filter((id) => contributionOn('settingsSections', id, mods))), [mods]);
  const groups = GROUPS.filter((g) => g.sections.some((s) => visible.has(s)));
  const fallback = (): SettingsTarget | null => (wide ? resolveSettingsTarget('writing', visible) : null);
  const [target, setTarget] = useState<SettingsTarget | null>(() => resolveSettingsTarget(section, visible) ?? fallback());
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState<string | null>(null);
  const main = useRef<HTMLElement>(null);

  // A new link (#settings/<id>, or #settings for the start) while Settings is open.
  useEffect(() => { setTarget(resolveSettingsTarget(section, visible) ?? fallback()); }, [section]); // eslint-disable-line react-hooks/exhaustive-deps
  // A module switched off under the open section: stay in the group if anything is left there.
  useEffect(() => {
    if (target && !visible.has(target.section)) setTarget(resolveSettingsTarget(target.group, visible) ?? fallback());
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening a group on a wide screen with nothing open yet (e.g. after resizing).
  useEffect(() => { if (wide && !target) setTarget(fallback()); }, [wide]); // eslint-disable-line react-hooks/exhaustive-deps
  // After a search pick: scroll to the setting once its section has rendered.
  useEffect(() => {
    if (!reveal || !main.current) return;
    void revealSetting(main.current, reveal).then(() => setReveal(null));
  }, [reveal, target]);

  const group = target ? GROUPS.find((g) => g.id === target.group)! : null;
  const tabs = group ? group.sections.filter((s) => visible.has(s)) : [];

  const open = (id: GroupId) => { setQuery(''); setTarget(resolveSettingsTarget(id, visible)); };
  const pick = (m: SettingMatch) => {
    setQuery('');
    setTarget({ group: m.group.id, section: m.entry.section });
    setReveal(m.entry.target ?? m.entry.label);
  };
  const back = () => {
    if (!wide && target) setTarget(null);
    else navigate({ name: 'library' });
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!target) return;
    const i = tabs.indexOf(target.section);
    const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTarget({ ...target, section: tabs[to]! });
    requestAnimationFrame(() => document.getElementById(`set-tab-${tabs[to]}`)?.focus());
  };

  const search = <SettingsSearch query={query} onQuery={setQuery} visible={visible} onPick={pick} />;
  const showList = wide || !target;

  return (
    <div className={cx('settings', wide && 'is-wide')}>
      <header className="set-top">
        <IconButton label="Back" onClick={back}><ArrowLeft size={20} /></IconButton>
        <h1>{!wide && group ? group.label : 'Settings'}</h1>
      </header>
      <div className="set-body">
        {showList && (
          <div className={cx('set-side', !wide && 'is-home')}>
            {search}
            {!query.trim() && (
              <nav className="set-nav" aria-label="Settings groups">
                {groups.map((g) => (
                  <button key={g.id} type="button" className={cx('nav-item', 'set-group-item', group?.id === g.id && 'is-on')} aria-current={group?.id === g.id ? 'page' : undefined} onClick={() => open(g.id)}>
                    <span className="nav-icon">{ICONS[g.id]}</span>
                    <span className="set-group-text">
                      <span className="nav-label">{g.label}</span>
                      {!wide && <span className="set-group-hint">{g.hint}</span>}
                    </span>
                    {!wide && <ChevronRight size={16} className="set-group-chevron" aria-hidden />}
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
        {group && target && (
          <main className="set-main" ref={main}>
            {wide && <h2 className="set-page-title">{group.label}</h2>}
            {tabs.length > 1 && (
              <div className="set-tabs" role="tablist" aria-label={group.label} onKeyDown={onTabKey}>
                {tabs.map((id) => (
                  <button key={id} id={`set-tab-${id}`} type="button" role="tab" aria-selected={target.section === id} aria-controls="set-panel"
                    tabIndex={target.section === id ? 0 : -1} className={cx('set-tab', target.section === id && 'is-on')} onClick={() => setTarget({ ...target, section: id })}>
                    {SECTION_LABELS[id]}
                  </button>
                ))}
              </div>
            )}
            <div id="set-panel" className="set-panel" key={target.section} {...(tabs.length > 1 ? { role: 'tabpanel', 'aria-labelledby': `set-tab-${target.section}` } : {})}>
              {renderSection(target.section)}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
