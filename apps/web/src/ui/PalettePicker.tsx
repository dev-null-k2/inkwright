import type { Palette } from '../state/settings.ts';
import { cx } from './primitives.tsx';

/**
 * The four palettes, each shown as a tiny desk: the desk colour, a sheet of paper, the pen tray and
 * the "you are here" accent — so people choose by seeing, not by reading names.
 */
const PALETTES: { id: Palette; name: string; hint: string; day: [string, string, string]; night: [string, string, string] }[] = [
  { id: 'duan', name: 'Duan', hint: 'Slate inkwright, jade eye', day: ['#e8e5ea', '#2e2533', '#5e9c7e'], night: ['#1a161c', '#2b2431', '#8cc4a8'] },
  { id: 'aizome', name: 'Aizome', hint: 'Indigo cloth, sashiko gold', day: ['#e2e6ee', '#1c2641', '#c08a3a'], night: ['#111727', '#222b47', '#e3b86b'] },
  { id: 'celadon', name: 'Celadon', hint: 'Porcelain glaze, iron foot', day: ['#e1e8e2', '#2b3a33', '#b26b48'], night: ['#131a17', '#25332c', '#e1a37f'] },
  { id: 'sumi', name: 'Sumi', hint: 'Black on white, for e-ink', day: ['#ffffff', '#000000', '#000000'], night: ['#000000', '#000000', '#ffffff'] },
];

function Swatch({ colors }: { colors: [string, string, string] }) {
  const [desk, tray, eye] = colors;
  return (
    <svg width="64" height="44" viewBox="0 0 64 44" aria-hidden>
      <rect width="64" height="44" rx="7" fill={desk} />
      <rect x="0.5" y="0.5" width="63" height="43" rx="6.5" fill="none" stroke="#000" strokeOpacity="0.12" />
      <rect x="17" y="6" width="30" height="31" rx="1" fill="#fbf9f4" stroke="#000" strokeOpacity="0.08" />
      <path d="M21 15h22M21 20h22M21 25h16" stroke="#000" strokeOpacity="0.12" strokeWidth="1" />
      <rect x="6" y="9" width="7" height="26" rx="3.5" fill={tray} stroke={desk === tray ? '#fff' : 'none'} strokeOpacity="0.5" />
      <circle cx="9.5" cy="15" r="2.2" fill={eye} />
    </svg>
  );
}

export function PalettePicker({ value, onChange }: { value: Palette; onChange: (p: Palette) => void }) {
  return (
    <div className="palette-grid" role="radiogroup" aria-label="Palette">
      {PALETTES.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className={cx('palette-tile', value === p.id && 'is-on')} onClick={() => onChange(p.id)}>
          <span className="palette-swatches"><Swatch colors={p.day} /><Swatch colors={p.night} /></span>
          <span className="palette-name">{p.name}</span>
          <span className="palette-hint">{p.hint}</span>
        </button>
      ))}
    </div>
  );
}
