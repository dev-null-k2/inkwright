import { create } from 'zustand';
import { safeStorage } from '../platform/env.ts';

/**
 * Preferences of the "ink that does things" modules (whether each module is on lives in the module
 * registry, Settings › Modules). Per device, like other settings.
 */
export interface ReadingPrefs {
  /** CSS font family for the reading view ('' = the app's own UI font). */
  font: string;
  /** Text size in px. */
  size: number;
  /** Extra space between letters / words, in em. */
  letterSpacing: number;
  wordSpacing: number;
  lineHeight: number;
  /** Highlight the line being read and dim the rest. */
  lineFocus: boolean;
  /** Background behind the text. */
  tint: 'paper' | 'cream' | 'blue' | 'grey';
}

export interface InkActionPrefs {
  /** Where AI answers go on the page. */
  answerIn: 'text' | 'ink';
  /** Handwriting style for AI ink. */
  answerStyle: 'script' | 'print';
  citationStyle: 'apa' | 'ieee';
  reading: ReadingPrefs;
  readAloud: { rate: number; voice: string | null };
}

export const DEFAULT_READING: ReadingPrefs = { font: '', size: 20, letterSpacing: 0.06, wordSpacing: 0.16, lineHeight: 1.8, lineFocus: true, tint: 'cream' };

const DEFAULTS: InkActionPrefs = { answerIn: 'ink', answerStyle: 'script', citationStyle: 'apa', reading: DEFAULT_READING, readAloud: { rate: 1, voice: null } };
const KEY = 'inkwright.inkactions.v1';

function load(): InkActionPrefs {
  try {
    const raw = safeStorage.get(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<InkActionPrefs>;
    return { ...DEFAULTS, ...v, reading: { ...DEFAULT_READING, ...v.reading }, readAloud: { ...DEFAULTS.readAloud, ...v.readAloud } };
  } catch {
    return DEFAULTS;
  }
}

export const useInkPrefs = create<InkActionPrefs & { set: (p: Partial<InkActionPrefs>) => void }>((set, get) => ({
  ...load(),
  set: (p) => {
    set(p);
    const { set: _s, ...rest } = get();
    safeStorage.set(KEY, JSON.stringify(rest));
  },
}));
