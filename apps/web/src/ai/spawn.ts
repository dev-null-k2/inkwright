/**
 * Starts the on-device AI worker. Kept in its own module so the single-file preview build (which
 * inlines every asset) can swap it for `spawn-unavailable.ts` and not embed the model runtime.
 */
export function spawnLocalWorker(): Worker {
  return new Worker(new URL('./local-worker.ts', import.meta.url), { type: 'module', name: 'inkwright-ai' });
}
