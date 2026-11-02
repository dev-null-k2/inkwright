import { describe, expect, it } from 'vitest';
import { LOCAL_MODELS, variantFiles, type RepoFile } from '../src/index.ts';

/**
 * Opt-in (INKSTONE_REAL_MODELS=1): checks every catalog variant against the live Hugging Face
 * repository — the weights still exist and the size shown before downloading is what will be
 * downloaded (within 2%). Catches upstream renames or re-quantizations before users do.
 */
describe.skipIf(!process.env.INKSTONE_REAL_MODELS)('local model catalog against Hugging Face', () => {
  for (const spec of LOCAL_MODELS) {
    it(`${spec.label} (${spec.repo})`, async () => {
      const res = await fetch(`https://huggingface.co/api/models/${spec.repo}/tree/main?recursive=true`);
      expect(res.ok).toBe(true);
      const rows = (await res.json()) as { type: string; path: string; size: number; lfs?: { size: number } }[];
      const tree: RepoFile[] = rows.filter((r) => r.type === 'file').map((r) => ({ path: r.path, size: r.lfs?.size ?? r.size }));
      for (const v of spec.variants) {
        const files = variantFiles(spec, v, tree);
        const total = files.reduce((a, f) => a + f.size, 0);
        expect(Math.abs(total - v.bytes) / v.bytes, `${spec.id} ${v.dtype}: catalog ${v.bytes}, live ${total}`).toBeLessThan(0.02);
        expect(files.some((f) => f.path === 'tokenizer.json')).toBe(true);
        expect(files.some((f) => f.path === 'config.json')).toBe(true);
      }
    }, 30_000);
  }
});
