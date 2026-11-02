/** `#AARRGGBB` (vault colours) → CSS `#RRGGBB`. */
export const argbCss = (hex: string | undefined, fallback = 'var(--ink-3)'): string => {
  if (!hex) return fallback;
  const c = hex.replace('#', '');
  return c.length === 8 ? `#${c.slice(2)}` : c.length === 6 ? `#${c}` : fallback;
};
