import type { PenType } from '@inkwright/core';
import { argbToCss } from '@inkwright/core';

/**
 * Pens drawn as the physical instruments they imitate, tip up, inked with their colour. The pen
 * tray is the one place Inkwright spends its visual boldness.
 */
export function PenNib({ pen, color, size = 1 }: { pen: PenType; color: string; size?: number }) {
  const ink = argbToCss(color);
  const inkSoft = argbToCss(color, 0.55);
  const body = 'var(--pen-body)';
  const bodyEdge = 'var(--pen-edge)';
  const w = 28 * size, h = 64 * size;
  const common = { width: w, height: h, viewBox: '0 0 28 64', 'aria-hidden': true } as const;
  switch (pen) {
    case 'fountain':
      return (
        <svg {...common}>
          <rect x="6" y="26" width="16" height="40" rx="4" fill={body} stroke={bodyEdge} />
          <rect x="6" y="30" width="16" height="3" fill={ink} />
          <path d="M14 3 L20.5 18 Q21 24 18 27 L10 27 Q7 24 7.5 18 Z" fill="#c9cdd2" stroke={bodyEdge} strokeWidth="0.8" />
          <path d="M14 3 L16.4 13 L11.6 13 Z" fill={ink} />
          <line x1="14" y1="9" x2="14" y2="21" stroke={bodyEdge} strokeWidth="0.9" />
          <circle cx="14" cy="21" r="1.4" fill={bodyEdge} />
        </svg>
      );
    case 'ballpoint':
      return (
        <svg {...common}>
          <rect x="7" y="22" width="14" height="44" rx="3" fill={body} stroke={bodyEdge} />
          <rect x="7" y="26" width="14" height="10" fill={ink} opacity="0.9" />
          <path d="M9 22 L13 7 L15 7 L19 22 Z" fill="#c9cdd2" stroke={bodyEdge} strokeWidth="0.8" />
          <circle cx="14" cy="6.2" r="1.7" fill={ink} />
        </svg>
      );
    case 'pencil':
      return (
        <svg {...common}>
          <path d="M6 26 L22 26 L22 66 L6 66 Z" fill={body} stroke={bodyEdge} />
          <path d="M11.3 26 V66 M16.7 26 V66" stroke={bodyEdge} strokeWidth="0.6" opacity="0.6" />
          <path d="M6 26 L14 6 L22 26 Z" fill="#e8d2b0" stroke={bodyEdge} strokeWidth="0.8" />
          <path d="M11 13.5 L14 6 L17 13.5 Z" fill={ink} />
        </svg>
      );
    case 'brush':
      return (
        <svg {...common}>
          <rect x="8" y="30" width="12" height="36" rx="3" fill={body} stroke={bodyEdge} />
          <rect x="7" y="25" width="14" height="7" rx="1.5" fill="#c9cdd2" stroke={bodyEdge} strokeWidth="0.8" />
          <path d="M14 3 C 19 10, 21 18, 20 25 L8 25 C 7 18, 9 10, 14 3 Z" fill={ink} stroke={bodyEdge} strokeWidth="0.7" />
        </svg>
      );
    case 'marker':
      return (
        <svg {...common}>
          <rect x="5" y="24" width="18" height="42" rx="4" fill={body} stroke={bodyEdge} />
          <rect x="5" y="40" width="18" height="6" fill={ink} />
          <path d="M8 24 L10 12 L18 12 L20 24 Z" fill="#c9cdd2" stroke={bodyEdge} strokeWidth="0.8" />
          <path d="M10.5 12 L11.5 5 L17.5 7.5 L17.5 12 Z" fill={ink} stroke={bodyEdge} strokeWidth="0.6" />
        </svg>
      );
    case 'highlighter':
      return (
        <svg {...common}>
          <rect x="3" y="24" width="22" height="42" rx="5" fill={body} stroke={bodyEdge} />
          <rect x="3" y="32" width="22" height="16" fill={inkSoft} />
          <path d="M6 24 L8 13 L20 13 L22 24 Z" fill="#c9cdd2" stroke={bodyEdge} strokeWidth="0.8" />
          <path d="M8.5 13 L8.5 6 L19.5 9 L19.5 13 Z" fill={ink} stroke={bodyEdge} strokeWidth="0.6" />
        </svg>
      );
    case 'calligraphy':
      return (
        <svg {...common}>
          <rect x="8" y="30" width="12" height="36" rx="2.5" fill={body} stroke={bodyEdge} />
          <path d="M7 30 L9 18 L19 18 L21 30 Z" fill="#c9cdd2" stroke={bodyEdge} strokeWidth="0.8" />
          <path d="M8.6 18 L8.6 6 L19.4 3.5 L19.4 18 Z" fill={ink} stroke={bodyEdge} strokeWidth="0.6" />
          <line x1="14" y1="7" x2="14" y2="15" stroke={bodyEdge} strokeWidth="0.8" />
        </svg>
      );
    case 'dashed':
      return (
        <svg {...common}>
          <rect x="7" y="22" width="14" height="44" rx="3" fill={body} stroke={bodyEdge} />
          <path d="M14 28 V62" stroke={ink} strokeWidth="2.4" strokeDasharray="4 3" />
          <path d="M9 22 L13 7 L15 7 L19 22 Z" fill="#c9cdd2" stroke={bodyEdge} strokeWidth="0.8" />
          <circle cx="14" cy="6.2" r="1.7" fill={ink} />
        </svg>
      );
  }
}

/** A short sample stroke drawn with the real ink geometry, for the pen editor. */
export { argbToCss };
