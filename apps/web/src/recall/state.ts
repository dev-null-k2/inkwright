/**
 * Memory timeline state in the app. Two kinds of settings, kept apart on purpose:
 *
 * - **Shared** (`recall/config.json` in the vault, synced): retention, pace, excluded apps and
 *   titles, microphone. Every device that shows the timeline prunes with the same retention.
 * - **This device** (local storage, never synced): whether *this* computer captures, and pauses.
 *   Turning capture on is a decision about one machine and must never spread through sync.
 */
import { create } from 'zustand';
import { DEFAULT_RECALL_CONFIG, RecallStore, type RecallConfig, type SkipReason } from '@inkwright/core';
import { safeStorage } from '../platform/env.ts';
import type { AppVault } from '../lib/vault.ts';

const LOCAL_KEY = 'inkwright.recall.device.v1';

interface LocalPrefs {
  /** This device captures its screen (desktop app only). */
  capture: boolean;
  /** Paused until (epoch ms). */
  pausedUntil: number | null;
  /** Short id naming this device in capture file names. */
  deviceId: string;
}

function loadLocal(): LocalPrefs {
  let v: Partial<LocalPrefs> = {};
  try { v = JSON.parse(safeStorage.get(LOCAL_KEY) ?? '{}') as Partial<LocalPrefs>; } catch { /* defaults */ }
  const deviceId = typeof v.deviceId === 'string' && /^[0-9A-Za-z_-]{4,24}$/.test(v.deviceId) ? v.deviceId : Math.random().toString(36).slice(2, 10);
  return { capture: v.capture === true, pausedUntil: typeof v.pausedUntil === 'number' ? v.pausedUntil : null, deviceId };
}

export type CaptureStatus =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'capturing'; at: number | null }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'needs-permission' }
  | { kind: 'unsupported'; why: string }
  | { kind: 'error'; message: string };

interface RecallState extends LocalPrefs {
  config: RecallConfig;
  configLoaded: boolean;
  status: CaptureStatus;
  /** Microphone transcription is running on this device. */
  listening: boolean;
  /** Bumped when captures change (new capture, erase), so open views reload. */
  version: number;
  setLocal(p: Partial<LocalPrefs>): void;
}

export const useRecall = create<RecallState>((set, get) => ({
  ...loadLocal(),
  config: { ...DEFAULT_RECALL_CONFIG },
  configLoaded: false,
  status: { kind: 'off' },
  listening: false,
  version: 0,
  setLocal(p) {
    set(p);
    const { capture, pausedUntil, deviceId } = get();
    safeStorage.set(LOCAL_KEY, JSON.stringify({ capture, pausedUntil, deviceId }));
  },
}));

let store: { vault: AppVault; store: RecallStore } | null = null;

/** The vault's capture store for this device. */
export function recallStore(vault: AppVault): RecallStore {
  if (store?.vault !== vault) store = { vault, store: new RecallStore(vault.fs, useRecall.getState().deviceId) };
  return store.store;
}

export async function loadRecallConfig(vault: AppVault): Promise<RecallConfig> {
  const config = await recallStore(vault).readConfig();
  useRecall.setState({ config, configLoaded: true });
  return config;
}

export async function saveRecallConfig(vault: AppVault, patch: Partial<Omit<RecallConfig, 'formatVersion' | 'updatedAt'>>): Promise<void> {
  const { formatVersion: _v, updatedAt: _u, ...current } = useRecall.getState().config;
  const config = await recallStore(vault).writeConfig({ ...current, ...patch });
  useRecall.setState({ config });
}

export const bumpRecall = () => useRecall.setState((s) => ({ version: s.version + 1 }));

/** Whether capture is paused right now. */
export const isPaused = (s: Pick<LocalPrefs, 'pausedUntil'> = useRecall.getState(), now = Date.now()) => s.pausedUntil != null && now < s.pausedUntil;
