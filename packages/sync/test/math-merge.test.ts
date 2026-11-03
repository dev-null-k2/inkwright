import { describe, expect, it } from 'vitest';
import type { MathObject, PageInk } from '@inkwright/core';
import { mergePage } from '../src/index.ts';

/** Solved results carry who read the handwriting and who worked the steps (docs/VAULT_FORMAT.md). */
describe('solved results merge', () => {
  const base: PageInk = { id: 'p', strokes: [], formatVersion: 2 };
  const result = (id: string, over: Partial<MathObject> = {}): MathObject => ({
    type: 'math', id, x: 0, y: 0, createdAt: 1, input: '2+2=', result: '= 4', fontSize: 20, color: '#FF000000', origin: 'solver',
    readBy: 'ML Kit on this device', stepsBy: 'solver', steps: ['Add: 2 + 2 = 4'], ...over,
  });

  it('keeps readBy and stepsBy on results solved on two devices', () => {
    const a = result('a'), b = result('b', { readBy: 'Claude · claude-opus', origin: 'ai', stepsBy: 'ai' });
    const m = mergePage(base, { ...base, objects: [a] }, { ...base, objects: [b] });
    expect(m.objects).toEqual([a, b]);
  });

  it('takes the edited side of a result as a whole object', () => {
    const before = result('a');
    const after = result('a', { result: '= 4', readBy: 'Inkwright’s built-in reader on this device' });
    const m = mergePage({ ...base, objects: [before] }, { ...base, objects: [before] }, { ...base, objects: [after] });
    expect(m.objects).toEqual([after]);
  });
});
