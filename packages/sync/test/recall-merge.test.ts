import { describe, expect, it } from 'vitest';
import { MemoryFS, RecallStore, decodeCaptures, decodeErasures, encodeCaptures, encodeErasures, type Capture } from '@inkwright/core';
import { MemoryRemote, MemoryStateStore, SyncEngine, mergeCaptureFiles, mergeErasureFiles, mergeFileBytes, mergeKindOf } from '../src/index.ts';

const c = (id: string, at: number): Capture => ({ id, at, kind: 'screen', app: 'Terminal', text: id });
const ids = (s: string) => decodeCaptures(s).map((x) => x.id);
const enc = (s: string) => new TextEncoder().encode(s);

describe('memory timeline captures merge', () => {
  it('applies to capture files only', () => {
    expect(mergeKindOf('recall/2026-11-03/09-mac.jsonl')).toBe('recall-captures');
    expect(mergeKindOf('recall/config.json')).toBeNull();
    expect(mergeKindOf('recall/2026-11-03/notes.txt')).toBeNull();
  });

  it('keeps captures appended on one side while the other side erased a moment', () => {
    const base = encodeCaptures([c('a', 1), c('b', 2)]);
    const capturing = encodeCaptures([c('a', 1), c('b', 2), c('c', 3)]); // the laptop kept capturing
    const erasing = encodeCaptures([c('a', 1)]); // the phone erased "b"
    expect(ids(mergeCaptureFiles(base, capturing, erasing))).toEqual(['a', 'c']);
    expect(ids(mergeCaptureFiles(base, erasing, capturing))).toEqual(['a', 'c']);
  });

  it('never brings an erased moment back, even from a side that never saw the erase', () => {
    expect(ids(mergeCaptureFiles(encodeCaptures([c('a', 1)]), '', encodeCaptures([c('a', 1), c('z', 9)])))).toEqual(['z']);
    // No base (first sync): union.
    expect(ids(mergeCaptureFiles(null, encodeCaptures([c('b', 2)]), encodeCaptures([c('a', 1)])))).toEqual(['a', 'b']);
  });

  it('goes through mergeFileBytes', () => {
    const out = mergeFileBytes('recall/2026-11-03/09-mac.jsonl', enc(encodeCaptures([c('a', 1)])), enc(encodeCaptures([c('a', 1), c('b', 2)])), enc(''));
    expect(ids(new TextDecoder().decode(out!))).toEqual(['b']);
  });
});

describe('erasing the timeline across devices (real sync)', () => {
  let now = 1_780_000_000_000;
  const clock = () => (now += 1000);
  const hour = new Date(2026, 10, 3, 9).getTime();

  function device(remote: MemoryRemote, name: string) {
    const fs = new MemoryFS(clock);
    return { fs, store: new RecallStore(fs, name), engine: new SyncEngine({ local: fs, remote, state: new MemoryStateStore(), clock }) };
  }

  it('an erased day stays erased while another device keeps appending to the same hour', async () => {
    const remote = new MemoryRemote({ clock });
    const laptop = device(remote, 'laptop');
    const phone = device(remote, 'phone');
    await laptop.store.append([{ ...c('secret', hour), device: 'laptop' }]);
    await laptop.engine.sync();
    await phone.engine.sync();
    expect((await phone.store.readDay('2026-11-03')).map((x) => x.id)).toEqual(['secret']);

    // Offline at the same time: the phone erases the day, the laptop captures one more moment.
    await phone.store.eraseDay('2026-11-03', hour + 120_000);
    await laptop.store.append([{ ...c('later', hour + 60_000), device: 'laptop' }]);
    await laptop.engine.sync();
    await phone.engine.sync();
    await laptop.engine.sync();

    // Sync lets the laptop's edit beat the phone's deletion, so the file is back, but nothing in it shows.
    expect(await phone.fs.readText('recall/2026-11-03/09-laptop.jsonl')).toContain('secret');
    for (const d of [laptop, phone]) expect(await d.store.readDay('2026-11-03')).toEqual([]);
    expect(await phone.store.usage()).toMatchObject({ captures: 0 });

    // Pruning removes the resurrected lines for good, on every device.
    await laptop.store.prune(hour + 3_600_000, 14);
    await laptop.engine.sync();
    await phone.engine.sync();
    expect(await phone.fs.readText('recall/2026-11-03/09-laptop.jsonl')).toBeNull();

    // A moment captured after the erase is kept.
    await laptop.store.append([{ ...c('after', hour + 180_000), device: 'laptop' }]);
    await laptop.engine.sync();
    await phone.engine.sync();
    expect((await phone.store.readDay('2026-11-03')).map((x) => x.id)).toEqual(['after']);
  });

  it('an erased moment stays erased when its emptied file is deleted on one side and appended on the other', async () => {
    const remote = new MemoryRemote({ clock });
    const laptop = device(remote, 'laptop');
    const phone = device(remote, 'phone');
    await laptop.store.append([{ ...c('only', hour), device: 'laptop' }]);
    await laptop.engine.sync();
    await phone.engine.sync();
    expect(await phone.store.erase(new Set(['only']))).toBe(1);
    await laptop.store.append([{ ...c('next', hour + 30_000), device: 'laptop' }]);
    await phone.engine.sync();
    await laptop.engine.sync();
    await phone.engine.sync();
    for (const d of [laptop, phone]) expect((await d.store.readDay('2026-11-03')).map((x) => x.id)).toEqual(['next']);
  });

  it('erasure records merge as a union and expire with retention', async () => {
    expect(mergeKindOf('recall/erased-laptop.jsonl')).toBe('recall-erasures');
    const a = encodeErasures([{ at: 1, ids: ['x'] }]);
    const b = encodeErasures([{ at: 1, ids: ['x'] }, { at: 2, from: 0, to: 3 }]);
    expect(decodeErasures(mergeErasureFiles(a, b))).toEqual([{ at: 1, ids: ['x'] }, { at: 2, from: 0, to: 3 }]);

    const fs = new MemoryFS();
    const store = new RecallStore(fs, 'laptop');
    await store.erase(new Set(['gone']), undefined, hour);
    await store.prune(hour + 2 * 86_400_000, 14);
    expect(await fs.readText('recall/erased-laptop.jsonl')).not.toBeNull();
    await store.prune(hour + 15 * 86_400_000, 14);
    expect(await fs.readText('recall/erased-laptop.jsonl')).toBeNull();
  });
});
