/**
 * "Show my notes as of <date>": swaps the app's vault for a read-only view of the past (core
 * timeline.ts) so the library, its search, links and the graph all show what was there then,
 * and swaps the real vault back when you return to today. Sync pauses meanwhile (lib/sync.ts
 * skips a vault with `asOf`), and an open note can be looked at but not changed.
 */
import { create } from 'zustand';
import { AsOfFS, VersionHistory, Vault, type VaultFS } from '@inkstone/core';
import { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';

export interface TimeTravelState {
  /** The moment shown, or null for today. */
  asOf: number | null;
  loading: boolean;
  /** Notes whose content at that moment isn't recorded (left out). */
  unknown: { id: string; title: string }[];
  /** The real vault, kept while looking at the past. */
  present: AppVault | null;
}

export const useTimeTravel = create<TimeTravelState>(() => ({ asOf: null, loading: false, unknown: [], present: null }));

let job = 0;

/** Shows the vault as it was at `t` (or moves to another moment while already in the past). */
export async function travelTo(t: number): Promise<void> {
  const app = useApp.getState();
  const present = useTimeTravel.getState().present ?? app.vault;
  if (!present) return;
  const mine = ++job;
  useTimeTravel.setState({ loading: true });
  try {
    if (!useTimeTravel.getState().present) {
      // The open note is saved before leaving the present.
      const { activeSession } = await import('../lib/session.ts');
      await activeSession()?.flush();
    }
    const fs = await AsOfFS.open(present.fs, t);
    const past = AppVault.over(fs, t);
    await past.buildIndex();
    if (mine !== job) return;
    useTimeTravel.setState({ asOf: t, unknown: fs.report.unknown, present, loading: false });
    useApp.setState({ vault: past });
    await useApp.getState().refresh();
    if (useApp.getState().route.name === 'editor') useApp.getState().navigate({ name: 'library' });
  } catch (e) {
    if (mine === job) useTimeTravel.setState({ loading: false });
    throw e;
  }
}

/** Back to the present: the real vault, the library as it is now. */
export async function backToToday(): Promise<void> {
  job++;
  const { present } = useTimeTravel.getState();
  useTimeTravel.setState({ asOf: null, unknown: [], present: null, loading: false });
  if (!present) return;
  useApp.setState({ vault: present });
  await useApp.getState().refresh();
  if (useApp.getState().route.name === 'editor') useApp.getState().navigate({ name: 'library' });
}

/**
 * Moments the vault has history for: every snapshot time across all notes, oldest first (the
 * scrubber's ticks), plus each note's creation.
 */
export async function vaultMoments(fs: VaultFS): Promise<number[]> {
  const vault = new Vault(fs);
  const history = new VersionHistory(vault);
  const out = new Set<number>();
  for (const n of await vault.listNotes({ includeTrashed: true })) {
    out.add(n.createdAt);
    for (const s of await history.list(n.id).catch(() => [])) out.add(s.takenAt);
  }
  return [...out].sort((a, b) => a - b);
}
