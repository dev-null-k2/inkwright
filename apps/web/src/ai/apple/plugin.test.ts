import { describe, expect, it, vi } from 'vitest';
import { createAppleLLM, describeAppleAvailability, type InkwrightApplePlugin } from './plugin.ts';

function fakePlugin(chunks: string[], opts: { fail?: Error; hang?: boolean } = {}) {
  let listener: ((e: { id: string; text: string }) => void) | null = null;
  const cancel = vi.fn(async () => {});
  const p = {
    availability: vi.fn(async () => ({ state: 'available' as const })),
    cancel,
    addListener: vi.fn(async (_e: string, cb: any) => { listener = cb; return { remove: async () => { listener = null; } }; }),
    generate: vi.fn(async ({ id }: { id: string }) => {
      if (opts.fail) throw opts.fail;
      listener?.({ id: 'someone-else', text: 'NOT MINE' });
      for (const c of chunks) listener?.({ id, text: c });
      if (opts.hang) await new Promise((_, reject) => cancel.mockImplementation(async () => reject(new Error('cancelled'))));
      return { text: chunks.join('') };
    }),
  };
  return { p: p as unknown as InkwrightApplePlugin, cancel, generate: p.generate, listenerGone: () => listener === null };
}

describe("Apple's on-device model", () => {
  it('streams only its own deltas and resolves with the whole answer', async () => {
    const f = fakePlugin(['The budget ', 'is $4000.']);
    const llm = createAppleLLM(f.p, 'this iPad');
    const seen: string[] = [];
    const r = await llm.generate({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Budget?' }], maxTokens: 200 }, (d) => seen.push(d));
    expect(r.text).toBe('The budget is $4000.');
    expect(seen).toEqual(['The budget ', 'is $4000.']);
    expect(llm.label).toBe('Apple Intelligence (on this iPad)');
    expect(f.generate.mock.calls[0]![0]).toMatchObject({ maxTokens: 200, messages: [{ role: 'system' }, { role: 'user' }] });
    expect(f.listenerGone()).toBe(true);
  });

  it('cancels the native run when the request is aborted', async () => {
    const f = fakePlugin(['partial'], { hang: true });
    const llm = createAppleLLM(f.p);
    const ac = new AbortController();
    const run = llm.generate({ messages: [{ role: 'user', content: 'Long answer' }] }, () => {}, ac.signal);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.cancel).toHaveBeenCalledOnce();
  });

  it('reports unavailable when the plugin errors, and explains every reason in words', async () => {
    const f = fakePlugin([]);
    (f.p.availability as any).mockRejectedValueOnce(new Error('boom'));
    expect(await createAppleLLM(f.p).availability()).toBe('unavailable');
    expect(describeAppleAvailability({ state: 'available' })).toBeNull();
    for (const reason of ['modelNotReady', 'appleIntelligenceNotEnabled', 'deviceNotEligible', 'osTooOld', undefined]) {
      expect(describeAppleAvailability({ state: 'unavailable', ...(reason ? { reason } : {}) })).toMatch(/\w/);
    }
  });
});
