/**
 * Used instead of `spawn.ts` in the single-file preview build (vite.config.ts): that build runs
 * inside claude.ai, where Claude is available without a key, and inlining the 27 MB model
 * runtime would make the file unusably large. `localAISupported()` is false there, so this is
 * only reached if that check is bypassed.
 */
export function spawnLocalWorker(): Worker {
  throw new Error('On-device AI is not part of this build. Use the installed app or the web app.');
}
