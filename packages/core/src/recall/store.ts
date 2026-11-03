/**
 * Reading and writing the memory timeline in the vault (`recall/`, see format.ts), with
 * retention and erasing. Works over any `VaultFS`, so the app, the desktop shell's folder vault,
 * the MCP server and the tests share it.
 */
import type { VaultFS } from '../fs.ts';
import { dayKey, parseDayKey } from '../daily.ts';
import {
  RECALL_CONFIG_PATH,
  RECALL_DIR,
  capturePath,
  dayBounds,
  decodeCaptures,
  decodeRecallConfig,
  encodeCaptures,
  encodeRecallConfig,
  decodeErasures,
  encodeErasures,
  erasurePath,
  isErasureFile,
  Erasures,
  sortCaptures,
  type Capture,
  type Erasure,
  type RecallConfig,
} from './format.ts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^\d{2}-[0-9A-Za-z_-]{1,24}\.jsonl$/;

/** The newest capture time that retention keeps (anything older goes). */
export function retentionCutoff(now: number, retentionDays: number): number {
  return now - Math.max(1, retentionDays) * 86_400_000;
}

/** Days (keys) that lie entirely before the cutoff, and the day that straddles it (trimmed line by line). */
export function daysToPrune(days: readonly string[], cutoff: number): { whole: string[]; partial: string | null } {
  const whole: string[] = [];
  let partial: string | null = null;
  for (const d of days) {
    const b = dayBounds(d);
    if (!b) continue;
    if (b.to <= cutoff) whole.push(d);
    else if (b.from < cutoff) partial = d;
  }
  return { whole, partial };
}

export class RecallStore {
  /** Writes are serialised so two captures in the same hour never race on one file. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly fs: VaultFS, private readonly device = 'device') {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async readConfig(): Promise<RecallConfig> {
    return decodeRecallConfig(await this.fs.readText(RECALL_CONFIG_PATH).catch(() => null));
  }

  async writeConfig(next: Omit<RecallConfig, 'formatVersion' | 'updatedAt'>, now = Date.now()): Promise<RecallConfig> {
    const c: RecallConfig = { ...next, formatVersion: 1, updatedAt: now };
    await this.fs.writeText(RECALL_CONFIG_PATH, encodeRecallConfig(c));
    return c;
  }

  /** Appends captures (each to its device-hour file). */
  append(captures: readonly Capture[]): Promise<void> {
    if (!captures.length) return Promise.resolve();
    return this.serial(async () => {
      const byPath = new Map<string, Capture[]>();
      for (const c of captures) {
        const p = capturePath(c.at, c.device ?? this.device);
        let list = byPath.get(p);
        if (!list) byPath.set(p, (list = []));
        list.push(c);
      }
      for (const [path, list] of byPath) {
        const existing = (await this.fs.readText(path)) ?? '';
        const sep = existing && !existing.endsWith('\n') ? '\n' : '';
        await this.fs.writeText(path, existing + sep + encodeCaptures(list));
      }
    });
  }

  /** Days with captures, newest first. */
  async days(): Promise<string[]> {
    const entries = await this.fs.list(RECALL_DIR).catch(() => []);
    return entries.filter((e) => e.kind === 'dir' && DAY_RE.test(e.name) && parseDayKey(e.name)).map((e) => e.name).sort().reverse();
  }

  private async dayFiles(day: string): Promise<string[]> {
    const entries = await this.fs.list(`${RECALL_DIR}/${day}`).catch(() => []);
    return entries.filter((e) => e.kind === 'file' && FILE_RE.test(e.name)).map((e) => `${RECALL_DIR}/${day}/${e.name}`);
  }

  /** Every device's erasure files (format.ts `Erasure`). */
  private async erasureFiles(): Promise<string[]> {
    const entries = await this.fs.list(RECALL_DIR).catch(() => []);
    return entries.filter((e) => e.kind === 'file').map((e) => `${RECALL_DIR}/${e.name}`).filter(isErasureFile);
  }

  /** What every device erased, so captures that sync brought back stay hidden. */
  async erasures(): Promise<Erasures> {
    const records: Erasure[] = [];
    for (const f of await this.erasureFiles()) records.push(...decodeErasures((await this.fs.readText(f).catch(() => null)) ?? ''));
    return new Erasures(records);
  }

  /** Records an erasure in this device's file, before any capture file is touched. */
  private async recordErasure(e: Erasure): Promise<void> {
    const path = erasurePath(this.device);
    const existing = (await this.fs.readText(path).catch(() => null)) ?? '';
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    await this.fs.writeText(path, existing + sep + encodeErasures([e]));
  }

  private async readDayWith(day: string, erased: Erasures): Promise<Capture[]> {
    const out: Capture[] = [];
    for (const f of await this.dayFiles(day)) out.push(...decodeCaptures((await this.fs.readText(f)) ?? ''));
    return sortCaptures(dedupe(out).filter((c) => !erased.covers(c)));
  }

  /** Every capture of a day (all devices, without erased ones), oldest first. */
  async readDay(day: string): Promise<Capture[]> {
    if (!DAY_RE.test(day)) return [];
    return this.readDayWith(day, await this.erasures());
  }

  /** Captures in `[from, to)`, oldest first. */
  async readRange(from: number, to: number): Promise<Capture[]> {
    // Day keys from the day `from` falls on through the day `to` falls on (calendar steps, so DST is safe).
    const keys = new Set<string>();
    const start = new Date(from);
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d.getTime() < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) keys.add(dayKey(d));
    const days = (await this.days()).filter((d) => keys.has(d));
    const erased = await this.erasures();
    const out: Capture[] = [];
    for (const d of days) out.push(...(await this.readDayWith(d, erased)).filter((c) => (c.end ?? c.at) >= from && c.at < to));
    return sortCaptures(out);
  }

  /** Rewrites capture files without the lines `drop` matches (deleting emptied files); returns how many went. */
  private async rewrite(files: readonly string[], drop: (c: Capture) => boolean): Promise<number> {
    let removed = 0;
    for (const f of files) {
      const all = decodeCaptures((await this.fs.readText(f)) ?? '');
      const keep = all.filter((c) => !drop(c));
      if (keep.length === all.length) continue;
      removed += all.length - keep.length;
      if (keep.length) await this.fs.writeText(f, encodeCaptures(keep));
      else await this.fs.delete(f);
    }
    return removed;
  }

  /** Removes single moments (by id) wherever they are. */
  erase(ids: ReadonlySet<string>, day?: string, now = Date.now()): Promise<number> {
    if (!ids.size) return Promise.resolve(0);
    return this.serial(async () => {
      await this.recordErasure({ at: now, ids: [...ids] });
      let removed = 0;
      for (const d of day ? [day] : await this.days()) removed += await this.rewrite(await this.dayFiles(d), (c) => ids.has(c.id));
      return removed;
    });
  }

  /** Deletes a whole day (everything captured on it up to now, on every device). */
  eraseDay(day: string, now = Date.now()): Promise<void> {
    const b = DAY_RE.test(day) ? dayBounds(day) : null;
    if (!b) return Promise.resolve();
    return this.serial(async () => {
      await this.recordErasure({ at: now, from: b.from, to: Math.min(b.to, now + 1) });
      await this.fs.deleteDir(`${RECALL_DIR}/${day}`);
    });
  }

  /** "Erase everything": every capture on every device (through sync); the settings stay. */
  eraseAll(now = Date.now()): Promise<void> {
    return this.serial(async () => {
      await this.recordErasure({ at: now, from: 0, to: now + 1 });
      for (const e of await this.fs.list(RECALL_DIR).catch(() => [])) {
        const path = `${RECALL_DIR}/${e.name}`;
        if (e.kind === 'dir') await this.fs.deleteDir(path);
        else if (path !== RECALL_CONFIG_PATH && !isErasureFile(path)) await this.fs.delete(path);
      }
    });
  }

  /**
   * Deletes captures older than the retention period, removes for good any erased capture that
   * sync brought back, and lets erasure records expire once everything they cover is past
   * retention. Returns how many days were removed whole and how many single captures went.
   */
  prune(now: number, retentionDays: number): Promise<{ days: number; captures: number }> {
    return this.serial(async () => {
      const cutoff = retentionCutoff(now, retentionDays);
      const days = await this.days();
      const { whole } = daysToPrune(days, cutoff);
      for (const d of whole) await this.fs.deleteDir(`${RECALL_DIR}/${d}`);
      const erased = await this.erasures();
      let captures = 0;
      for (const d of days) {
        if (!whole.includes(d)) captures += await this.rewrite(await this.dayFiles(d), (c) => c.at < cutoff || erased.covers(c));
      }
      // Erasure records: this device trims its own file; any device deletes a file whose records
      // have all expired (if its device appended meanwhile, sync keeps that newer copy).
      for (const f of await this.erasureFiles()) {
        const all = decodeErasures((await this.fs.readText(f).catch(() => null)) ?? '');
        const keep = all.filter((e) => e.at >= cutoff);
        if (!keep.length) await this.fs.delete(f);
        else if (f === erasurePath(this.device) && keep.length < all.length) await this.fs.writeText(f, encodeErasures(keep));
      }
      return { days: whole.length, captures };
    });
  }

  /** Total stored text (characters) and capture count, for the settings screen. */
  async usage(): Promise<{ days: number; captures: number; bytes: number }> {
    let captures = 0;
    let bytes = 0;
    const days = await this.days();
    const erased = await this.erasures();
    for (const d of days) {
      for (const f of await this.dayFiles(d)) {
        const t = (await this.fs.readText(f)) ?? '';
        bytes += t.length;
        captures += decodeCaptures(t).filter((c) => !erased.covers(c)).length;
      }
    }
    return { days: days.length, captures, bytes };
  }
}

function dedupe(cs: Capture[]): Capture[] {
  const seen = new Set<string>();
  return cs.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
