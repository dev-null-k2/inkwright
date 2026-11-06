import { describe, expect, it, vi } from 'vitest';

const pending: Array<(s: { state: string }) => void> = [];
vi.mock('./store.ts', () => ({
  engineStatus: () => new Promise((r) => pending.push(r)),
  ensureEngine: vi.fn(),
  onEngineChange: vi.fn(),
  removeEngine: vi.fn(),
}));

describe('engine status', () => {
  it('keeps the newest read when an older one finishes last', async () => {
    const { refreshEngineStatus, useEngines } = await import('./progress.ts');
    const older = refreshEngineStatus('tree-sitter'); // e.g. started when Settings opened
    const newer = refreshEngineStatus('tree-sitter'); // started by the finished download
    pending[1]({ state: 'ready' });
    await newer;
    pending[0]({ state: 'missing' });
    await older;
    expect(useEngines.getState().status['tree-sitter']?.state).toBe('ready');
  });
});
