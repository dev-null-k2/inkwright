/**
 * The search field at the top of Settings: type a setting's name (or a word people use for it,
 * like "dark mode" or "API key") and jump straight to it. Results come from the index in
 * groups.ts; picking one opens its group and tab, scrolls the setting into view, highlights it
 * briefly and moves keyboard focus to its control.
 */
import { useRef, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { SECTION_LABELS, searchSettings, type Requirement, type SectionId, type SettingMatch } from './groups.ts';
import { hasNativePlugin } from '../platform/native.ts';
import { folderSyncSupported } from '../lib/sync.ts';

/** Whether this device has what a setting needs (see `requires` in groups.ts). */
const available = (r: Requirement) => (r === 'android-app' ? hasNativePlugin : folderSyncSupported);

export function SettingsSearch({ query, onQuery, visible, onPick }: {
  query: string;
  onQuery: (q: string) => void;
  visible: ReadonlySet<SectionId>;
  onPick: (m: SettingMatch) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const results = searchSettings(query, visible, available);
  const buttons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && results[0]) { e.preventDefault(); onPick(results[0]); }
    else if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); buttons()[0]?.focus(); }
    else if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); onQuery(''); }
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const all = buttons();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); all[Math.min(all.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) list.current?.parentElement?.querySelector('input')?.focus(); else all[i - 1]?.focus(); }
  };

  return (
    <div className="set-search">
      <label className="set-search-field">
        <Search size={16} aria-hidden />
        <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onInputKey}
          placeholder="Search settings" aria-label="Search settings" aria-controls={query.trim() ? 'set-search-results' : undefined} autoComplete="off" spellCheck={false} enterKeyHint="go" />
        {query && <button type="button" className="set-search-clear" aria-label="Clear search" onClick={() => onQuery('')}><X size={15} /></button>}
      </label>
      {query.trim() && (
        <div className="set-search-results" id="set-search-results" aria-live="polite">
          {results.length ? (
            <ul ref={list} onKeyDown={onListKey} aria-label="Matching settings">
              {results.map((m) => (
                <li key={`${m.entry.section}:${m.entry.label}`}>
                  <button type="button" className="set-result" onClick={() => onPick(m)}>
                    <span className="set-result-label">{m.entry.label}</span>
                    <span className="set-result-where">{m.group.label}{m.group.sections.length > 1 ? ` › ${SECTION_LABELS[m.entry.section]}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="set-search-empty">No setting matches “{query.trim()}”. Try a shorter word.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Scrolls the setting whose visible text is `text` into view inside `root`, highlights its row
 * and focuses its control. Sections render asynchronously (some load data first), so it looks
 * for up to a second. Resolves to whether it was found.
 */
export function revealSetting(root: HTMLElement, text: string): Promise<boolean> {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const find = () => [...root.querySelectorAll<HTMLElement>('h2, h3, .row-label, .field-label, button, .about-name')]
    .find((el) => norm(el.textContent) === text);
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = () => {
      const el = find();
      if (!el) {
        if (performance.now() - started < 1000) requestAnimationFrame(tick);
        else resolve(false);
        return;
      }
      const row = el.closest<HTMLElement>('.row-switch, .row-slider, .field-row, .field, .ag-nav-row') ?? el.closest<HTMLElement>('.set-group') ?? el;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      row.classList.add('is-found');
      setTimeout(() => row.classList.remove('is-found'), 1800);
      const control = el.matches('button') ? el : row.querySelector<HTMLElement>('input, select, textarea, button, [role="radio"][aria-checked="true"]');
      control?.focus({ preventScroll: true });
      resolve(true);
    };
    tick();
  });
}
