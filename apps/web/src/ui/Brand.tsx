/**
 * The Inkwright mark: a Duan inkstone seen from above — the well of wet ink at the top, the grinding
 * face below, and one jade stone-eye, the flaw that makes a Duan stone prized.
 */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect x="8" y="3" width="48" height="58" rx="15" fill="var(--stone)" />
      <rect x="8.75" y="3.75" width="46.5" height="56.5" rx="14.25" fill="none" stroke="var(--stone-rim)" strokeWidth="1.5" />
      <rect x="15" y="26" width="34" height="29" rx="10" fill="#ffffff" fillOpacity="0.06" />
      <ellipse cx="32" cy="15.5" rx="16" ry="7.5" fill="#120d15" />
      <path d="M21 13.5c3.5-2.6 8-3.6 13-3" stroke="#ffffff" strokeOpacity="0.38" strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="42" cy="44" r="6.5" fill="none" stroke="var(--eye)" strokeOpacity="0.35" strokeWidth="1.5" />
      <circle cx="42" cy="44" r="4" fill="var(--eye)" />
      <circle cx="42" cy="44" r="1.6" fill="var(--stone)" />
    </svg>
  );
}
