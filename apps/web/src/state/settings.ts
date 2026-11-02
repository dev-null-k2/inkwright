import { create } from 'zustand';
import { DEFAULT_PAPER, PAGE_SIZES, type PageSize, type PaperSpec } from '@inkstone/core';
import type { ButtonAction, InputPrefs, PenPreset } from '../canvas/engine.ts';
import { safeStorage } from '../platform/env.ts';

export interface AIProviderConfig {
  /** Local id of this configuration. */
  id: string;
  /** Provider registry id, e.g. "openai", "anthropic", "gemini", "openrouter", "ollama", "custom". */
  providerId: string;
  label: string;
  model: string;
  baseUrl?: string;
  /** Whether a key is saved in the secret store under `ai-key:<id>`. */
  hasKey: boolean;
  azureApiVersion?: string;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  feel: { haptics: boolean; hapticStrength: number; sound: boolean; soundVolume: number };
  input: Omit<InputPrefs, 'highlighter'> & { buttonAction: ButtonAction };
  tray: PenPreset[];
  activePresetId: string;
  highlighterId: string;
  eraserMode: 'stroke' | 'precise';
  eraserSize: number;
  defaultPaper: PaperSpec;
  defaultPageSize: PageSize;
  recognition: { engine: 'auto' | 'native' | 'ai' | 'off'; language: string; autoAI: boolean };
  ai: { providers: AIProviderConfig[]; activeId: string | null; confirmDestructive: boolean };
  sync: {
    googleClientId: string;
    account: { email: string; name: string; picture?: string } | null;
    drive: { enabled: boolean; folderName: string; lastSync: number | null };
    webdav: { enabled: boolean; url: string; username: string; lastSync: number | null };
    folder: { enabled: boolean; name: string | null; lastSync: number | null };
  };
  library: { sort: 'updated' | 'created' | 'title'; view: 'grid' | 'list' };
  recentColors: string[];
  onboardingDone: boolean;
}

export const DEFAULT_TRAY: PenPreset[] = [
  { id: 'fountain-black', pen: 'fountain', color: '#FF1B1F24', size: 2.6 },
  { id: 'ballpoint-blue', pen: 'ballpoint', color: '#FF1F3A93', size: 1.8 },
  { id: 'pencil-graphite', pen: 'pencil', color: '#FF4A4F57', size: 2.2 },
  { id: 'brush-ink', pen: 'brush', color: '#FF1B1F24', size: 6 },
  { id: 'marker-red', pen: 'marker', color: '#FFC0392B', size: 4 },
  { id: 'highlighter-yellow', pen: 'highlighter', color: '#FFFFD54A', size: 16 },
];

export const INK_PALETTE = [
  '#FF1B1F24', '#FF4A4F57', '#FF1F3A93', '#FF2F6FB5', '#FF1E7F74', '#FF3D7A3A',
  '#FFB8432F', '#FFC0392B', '#FFD9822B', '#FF7A3E9D', '#FFB0477A', '#FFFFFFFF',
];

export const HIGHLIGHT_PALETTE = ['#FFFFD54A', '#FF9BE58A', '#FF8FD3F5', '#FFF7A7C4', '#FFFFB35C', '#FFC6B3FF'];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  feel: { haptics: true, hapticStrength: 0.8, sound: true, soundVolume: 0.5 },
  input: { fingerAction: 'scroll', buttonAction: 'eraser', scratchToErase: true, holdToShape: true, tapGestures: true, pressureCurve: 1, instantInk: true },
  tray: DEFAULT_TRAY,
  activePresetId: 'fountain-black',
  highlighterId: 'highlighter-yellow',
  eraserMode: 'stroke',
  eraserSize: 22,
  defaultPaper: DEFAULT_PAPER,
  defaultPageSize: PAGE_SIZES.A4,
  recognition: { engine: 'auto', language: 'en-US', autoAI: false },
  ai: { providers: [], activeId: null, confirmDestructive: true },
  sync: {
    googleClientId: (import.meta.env?.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '',
    account: null,
    drive: { enabled: false, folderName: 'Inkstone', lastSync: null },
    webdav: { enabled: false, url: '', username: '', lastSync: null },
    folder: { enabled: false, name: null, lastSync: null },
  },
  library: { sort: 'updated', view: 'grid' },
  recentColors: [],
  onboardingDone: false,
};

const KEY = 'inkstone.settings.v1';

function load(): Settings {
  const raw = safeStorage.get(KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const s = JSON.parse(raw) as Partial<Settings>;
    // Deep-merge one level so new settings get defaults after an update.
    const out: any = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const d = DEFAULT_SETTINGS[k] as any;
      const v = (s as any)[k];
      if (v === undefined) continue;
      out[k] = d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v) ? { ...d, ...v } : v;
    }
    if (!Array.isArray(out.tray) || !out.tray.length) out.tray = DEFAULT_TRAY;
    return out as Settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface SettingsStore extends Settings {
  update: (fn: (s: Settings) => Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  update: (fn) => {
    const patch = fn(get());
    set(patch);
    const { update: _u, reset: _r, ...rest } = get();
    safeStorage.set(KEY, JSON.stringify(rest));
  },
  reset: () => {
    safeStorage.remove(KEY);
    set({ ...DEFAULT_SETTINGS });
  },
}));

export const settingsSnapshot = (): Settings => {
  const { update: _u, reset: _r, ...rest } = useSettings.getState();
  return rest;
};

export function activePreset(s: Settings): PenPreset {
  return s.tray.find((p) => p.id === s.activePresetId) ?? s.tray[0] ?? DEFAULT_TRAY[0]!;
}

export function highlighterPreset(s: Settings): PenPreset {
  return s.tray.find((p) => p.id === s.highlighterId) ?? s.tray.find((p) => p.pen === 'highlighter') ?? DEFAULT_TRAY[5]!;
}

export function inputPrefs(s: Settings): InputPrefs {
  return { ...s.input, highlighter: highlighterPreset(s) };
}
