import { useId } from 'react';

/**
 * Notebook covers in the style of suminagashi — "floating ink", the Japanese art of dropping ink
 * on still water in rings and lifting the pattern onto paper. Every notebook gets its own cover,
 * generated deterministically from its id (same cover on every device, no image files to sync) and
 * inked in the notebook's colour. Pure SVG: rings around a few drop points, then a turbulence
 * displacement that drifts them the way a breath across the water would.
 */

export interface SuminagashiSpec {
  /** Drop points in a 120×160 cover, with how far their rings reach. */
  drops: { x: number; y: number; reach: number }[];
  /** Ring radii and widths, shared by every drop (inked rings alternate with water). */
  rings: { r: number; w: number; tint: 0 | 1 }[];
  /** Turbulence frequency and displacement strength. */
  frequency: number;
  scale: number;
  seed: number;
}

/** FNV-1a 32-bit: stable seed from any string. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny deterministic PRNG. */
function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function suminagashi(seedText: string): SuminagashiSpec {
  const seed = hashSeed(seedText);
  const r = rng(seed);
  const count = 2 + Math.floor(r() * 2);
  const drops = Array.from({ length: count }, () => ({ x: 14 + r() * 92, y: 18 + r() * 124, reach: 70 + r() * 90 }));
  const rings: SuminagashiSpec['rings'] = [];
  let radius = 2 + r() * 3;
  let tint: 0 | 1 = 0;
  while (radius < 175) {
    const w = 1.2 + r() * 3.6;
    rings.push({ r: radius, w, tint });
    radius += w + 2.2 + r() * 4.5;
    tint = tint === 0 ? 1 : 0;
  }
  return { drops, rings, frequency: 0.009 + r() * 0.012, scale: 16 + r() * 22, seed: seed % 997 };
}

/** `#AARRGGBB` → css rgb(). */
function argb(c: string): string {
  const h = c.replace('#', '');
  const hex = h.length === 8 ? h.slice(2) : h.length === 6 ? h : '3d5a80';
  return `#${hex}`;
}

export function NotebookCover({ id, color, size = 120, title }: { id: string; color: string; size?: number; title?: string }) {
  const uid = useId().replace(/:/g, '');
  const spec = suminagashi(id);
  const ink = argb(color);
  const w = size, h = Math.round(size * 4 / 3);
  return (
    <svg className="nb-cover" width={w} height={h} viewBox="0 0 120 160" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <filter id={`drift-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency={spec.frequency} numOctaves={2} seed={spec.seed} />
          <feDisplacementMap in="SourceGraphic" scale={spec.scale} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <clipPath id={`page-${uid}`}><rect width="120" height="160" rx="5" /></clipPath>
        <linearGradient id={`spine-${uid}`} x1="0" x2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.28" />
          <stop offset="0.6" stopColor="#000" stopOpacity="0.08" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#page-${uid})`}>
        <rect width="120" height="160" fill="#f4f2ef" />
        <g filter={`url(#drift-${uid})`} fill="none">
          {spec.drops.map((d, i) => (
            <g key={i}>
              {spec.rings.filter((ring) => ring.r < d.reach).map((ring, k) => (
                <circle key={k} cx={d.x} cy={d.y} r={ring.r} stroke={ink} strokeOpacity={ring.tint === 0 ? 0.92 : 0.38} strokeWidth={ring.w} />
              ))}
            </g>
          ))}
        </g>
        <rect width="14" height="160" fill={`url(#spine-${uid})`} />
        <rect x="0.5" y="0.5" width="119" height="159" rx="4.5" fill="none" stroke="#000" strokeOpacity="0.12" />
      </g>
    </svg>
  );
}

/** A single ink drop spreading on water: the library's empty-desk illustration. */
export function InkRipple({ size = 168 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  const spec = suminagashi('inkwright-empty-desk');
  return (
    <svg className="ink-ripple" width={size} height={size} viewBox="0 0 160 160" aria-hidden>
      <defs>
        <filter id={`ripple-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.014" numOctaves={2} seed={7} />
          <feDisplacementMap in="SourceGraphic" scale="14" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <radialGradient id={`fade-${uid}`}>
          <stop offset="0.55" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={`mask-${uid}`}><rect width="160" height="160" fill={`url(#fade-${uid})`} /></mask>
      </defs>
      <g mask={`url(#mask-${uid})`} filter={`url(#ripple-${uid})`} fill="none">
        {spec.rings.filter((r) => r.r < 78).map((r, k) => (
          <circle key={k} cx="80" cy="80" r={r.r} stroke="var(--ink)" strokeOpacity={r.tint === 0 ? 0.55 : 0.18} strokeWidth={r.w} />
        ))}
      </g>
      <circle cx="80" cy="80" r="5" fill="var(--eye)" />
      <circle cx="80" cy="80" r="2" fill="var(--eye-core)" />
    </svg>
  );
}
