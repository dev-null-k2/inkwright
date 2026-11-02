/**
 * Memory-timeline capture files (`recall/<day>/<HH>-<device>.jsonl`, docs/VAULT_FORMAT.md
 * § Memory timeline). Each file has a single writer (the device in its name), so conflicts come
 * only from erasing: one device erases a moment ("erase this", retention trimming a day) while
 * the capturing device appends to the same hour. The merge is a three-way union by capture id in
 * which a deletion on either side wins — an erased moment must never come back through sync.
 */
import { decodeCaptures, decodeErasures, encodeCaptures, encodeErasures, sortCaptures, type Capture, type Erasure } from '@inkwright/core';

/**
 * Erasure records (`recall/erased-<device>.jsonl`): a plain union of both sides' lines. Each file
 * has one writer, so both sides differing means the writer trimmed expired records on one side
 * while it appended on the other; keeping every record can only hide more, never bring an erased
 * moment back, and expired records are trimmed again at the next prune.
 */
export function mergeErasureFiles(local: string, remote: string): string {
  const seen = new Map<string, Erasure>();
  for (const e of [...decodeErasures(local), ...decodeErasures(remote)]) {
    const key = JSON.stringify(e);
    if (!seen.has(key)) seen.set(key, e);
  }
  return encodeErasures([...seen.values()].sort((a, b) => a.at - b.at));
}

export function mergeCaptureFiles(base: string | null, local: string, remote: string): string {
  const b = new Set(decodeCaptures(base ?? '').map((c) => c.id));
  const l = decodeCaptures(local);
  const r = decodeCaptures(remote);
  const lIds = new Set(l.map((c) => c.id));
  const rIds = new Set(r.map((c) => c.id));
  const out = new Map<string, Capture>();
  for (const c of [...l, ...r]) {
    // Was in the base and is gone on one side: erased there.
    if (b.has(c.id) && (!lIds.has(c.id) || !rIds.has(c.id))) continue;
    if (!out.has(c.id)) out.set(c.id, c);
  }
  return encodeCaptures(sortCaptures([...out.values()]));
}
