/**
 * Engine downloads as app state, so any screen can show "downloading DuckDB, one time…" while a
 * feature waits for it, and Settings can offer to fetch engines ahead of going offline.
 */
import { create } from 'zustand';
import { ENGINES, type EngineId } from './catalog.ts';
import { engineStatus, ensureEngine, onEngineChange, removeEngine, type EngineProgress, type EngineStatus } from './store.ts';

interface EngineState {
  /** Downloads in progress (or failed: `error` set) in this tab. */
  downloads: Partial<Record<EngineId, EngineProgress & { error?: string }>>;
  /** Last known stored state per engine. */
  status: Partial<Record<EngineId, EngineStatus>>;
}

export const useEngines = create<EngineState>(() => ({ downloads: {}, status: {} }));

// Reads can finish out of order (a slow one started when Settings opened can land after the one a
// finished download started); only the newest read of each engine is applied.
const reads: Partial<Record<EngineId, number>> = {};
let readSeq = 0;

/** Re-reads what is stored for one engine (or all). */
export async function refreshEngineStatus(id?: EngineId): Promise<void> {
  const ids = id ? [id] : ENGINES.map((e) => e.id);
  const seq = ++readSeq;
  for (const i of ids) reads[i] = seq;
  const entries = await Promise.all(ids.map(async (i) => [i, await engineStatus(i)] as const));
  const current = entries.filter(([i]) => reads[i] === seq);
  if (current.length) useEngines.setState((s) => ({ status: { ...s.status, ...Object.fromEntries(current) } }));
}

let watching = false;
/** Keeps `status` current when a worker or another tab downloads or removes an engine. */
export function watchEngines(): void {
  if (watching) return;
  watching = true;
  onEngineChange((id) => void refreshEngineStatus(id));
}

/** `ensureEngine` with its progress published for the UI; failures are recorded and re-thrown. */
export async function downloadEngine(id: EngineId, opts: { files?: string[]; signal?: AbortSignal } = {}): Promise<Record<string, string>> {
  watchEngines();
  const set = (p: (EngineProgress & { error?: string }) | null) => useEngines.setState((s) => {
    const downloads = { ...s.downloads };
    if (p) downloads[id] = p;
    else delete downloads[id];
    return { downloads };
  });
  let last = 0;
  try {
    const urls = await ensureEngine(id, {
      ...opts,
      onProgress: (p) => {
        // Throttled: a 30 MB download reports thousands of chunks.
        const now = Date.now();
        if (now - last > 100 || p.loaded >= p.total) { last = now; set(p); }
      },
    });
    set(null);
    await refreshEngineStatus(id);
    return urls;
  } catch (e) {
    set({ loaded: 0, total: 0, error: (e as Error).message });
    throw e;
  }
}

export async function deleteEngine(id: EngineId): Promise<void> {
  await removeEngine(id);
  await refreshEngineStatus(id);
}
