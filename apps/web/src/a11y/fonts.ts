/**
 * Fonts for the reading view, chosen from what is installed on this device. Where the browser
 * offers the Local Font Access API (Chromium, after the user allows it) the full list is used;
 * elsewhere a short list of fonts people with dyslexia often prefer is checked by measuring text
 * against the generic fallbacks (a font that isn't installed measures like its fallback).
 */

export const READING_CANDIDATES = [
  'OpenDyslexic', 'Lexend', 'Atkinson Hyperlegible', 'Andika', 'Comic Sans MS', 'Verdana', 'Tahoma',
  'Trebuchet MS', 'Century Gothic', 'Arial', 'Helvetica', 'Calibri', 'Segoe UI', 'Roboto', 'Noto Sans',
  'Open Sans', 'Georgia', 'Hanken Grotesk Variable', 'Newsreader Variable',
] as const;

let ctx: CanvasRenderingContext2D | null = null;

export function isFontAvailable(family: string): boolean {
  if (typeof document === 'undefined') return false;
  // Our own bundled fonts are always there.
  if (/Variable$/.test(family)) return true;
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return false;
  const sample = 'mmmmmmmmmmlli WwQq@#0123';
  return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
    ctx!.font = `32px ${fallback}`;
    const base = ctx!.measureText(sample).width;
    ctx!.font = `32px "${family}", ${fallback}`;
    return ctx!.measureText(sample).width !== base;
  });
}

/** Families installed on this device that suit reading (cheap check, no permission prompt). */
export function availableReadingFonts(): string[] {
  return READING_CANDIDATES.filter(isFontAvailable);
}

/** Every installed family, when the browser can list them (asks the user first). */
export async function queryInstalledFonts(): Promise<string[] | null> {
  const q = (globalThis as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!q) return null;
  try {
    const fonts = await q();
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}
