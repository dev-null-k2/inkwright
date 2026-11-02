/**
 * The meter: what every AI call cost, in tokens and money, per provider and day — and what the
 * context budgeter saved compared with sending everything uncompressed. Usage is written to the
 * vault (`ai/usage/<YYYY-MM>/<device>.json`, one file per device so devices never overwrite each
 * other) so budgets hold across devices and the AI usage page shows the whole picture.
 *
 * Prices are list prices in USD per million tokens; they change, and contracts differ, so the
 * table is only a starting point: `policy.prices` overrides any entry (Settings › AI › Routing &
 * privacy › Prices). Calls to models on the device cost nothing. Unknown cloud models are
 * metered in tokens with cost shown as unknown, never guessed.
 */
import type { VaultFS } from '@inkstone/core';
import type { AIPolicy, Price } from './policy.ts';

/**
 * List prices (USD per 1M tokens: input, output, cached input) as published by each provider when
 * this table was last reviewed (2026-11). Patterns are matched against the model id, longest
 * pattern first; `*` matches anything.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  // Anthropic
  'claude-opus-4*': { input: 15, output: 75, cachedInput: 1.5 },
  'claude-opus-4-5*': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-sonnet-4*': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-haiku-4*': { input: 1, output: 5, cachedInput: 0.1 },
  'claude-3-5-haiku*': { input: 0.8, output: 4, cachedInput: 0.08 },
  // OpenAI
  'gpt-5': { input: 1.25, output: 10, cachedInput: 0.125 },
  'gpt-5-mini*': { input: 0.25, output: 2, cachedInput: 0.025 },
  'gpt-5-nano*': { input: 0.05, output: 0.4, cachedInput: 0.005 },
  'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5 },
  'gpt-4.1-mini*': { input: 0.4, output: 1.6, cachedInput: 0.1 },
  'gpt-4.1-nano*': { input: 0.1, output: 0.4, cachedInput: 0.025 },
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4o-mini*': { input: 0.15, output: 0.6, cachedInput: 0.075 },
  // Google
  'gemini-2.5-pro*': { input: 1.25, output: 10, cachedInput: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedInput: 0.075 },
  'gemini-2.5-flash-lite*': { input: 0.1, output: 0.4, cachedInput: 0.025 },
  // Others (OpenAI-compatible hosts)
  'mistral-large*': { input: 2, output: 6 },
  'mistral-small*': { input: 0.1, output: 0.3 },
  'deepseek-chat*': { input: 0.27, output: 1.1, cachedInput: 0.07 },
  'grok-4*': { input: 3, output: 15, cachedInput: 0.75 },
};

function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(s);
}

/** The price for a model: the policy's overrides first, then the defaults; most specific pattern wins. */
export function priceFor(policy: Pick<AIPolicy, 'prices'> | null, model: string): Price | null {
  const bare = model.replace(/^.*\//, ''); // OpenRouter-style "anthropic/claude-…"
  for (const table of [policy?.prices ?? {}, DEFAULT_PRICES]) {
    const hits = Object.keys(table).filter((p) => globMatch(p, bare) || globMatch(p, model)).sort((a, b) => b.replace(/\*/g, '').length - a.replace(/\*/g, '').length);
    if (hits.length) return table[hits[0]!]!;
  }
  return null;
}

export function costUsd(price: Price | null, inputTokens: number, outputTokens: number): number | null {
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ---- Ledger --------------------------------------------------------------------------------------

/** One row of the ledger: a provider and model on one day. */
export interface UsageRow {
  /** YYYY-MM-DD in the device's local time. */
  day: string;
  /** The budget key: provider config id in the app, provider id on the server (e.g. `anthropic`). */
  provider: string;
  /** "Anthropic · claude-sonnet-4-5" */
  label: string;
  model: string;
  /** Ran on the device (free, never left it). */
  local: boolean;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens these calls would have used without the context budgeter. */
  uncompressedInputTokens: number;
  /** Cost in USD; null while any call's price was unknown. */
  costUsd: number | null;
  /** What the saved input tokens would have cost. */
  savedUsd: number | null;
  /** Values replaced by placeholders before they left the device. */
  redactions: number;
  /** Calls the policy refused. */
  blocked: number;
}

export interface UsageFile {
  version: 1;
  device: string;
  month: string;
  rows: UsageRow[];
}

/** What a single call reports to the meter. */
export interface UsageEvent {
  at: number;
  provider: string;
  label: string;
  model: string;
  local: boolean;
  inputTokens: number;
  outputTokens: number;
  uncompressedInputTokens: number;
  redactions: number;
  blocked?: boolean;
}

export const usageDir = (month: string) => `ai/usage/${month}`;

const pad = (n: number) => String(n).padStart(2, '0');
export const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const monthOf = (t: number) => dayOf(t).slice(0, 7);

/** Adds one call to a list of rows (pure; exported for tests). */
export function addUsage(rows: UsageRow[], e: UsageEvent, price: Price | null): UsageRow[] {
  const day = dayOf(e.at);
  const out = rows.map((r) => ({ ...r }));
  let row = out.find((r) => r.day === day && r.provider === e.provider && r.model === e.model);
  if (!row) {
    row = { day, provider: e.provider, label: e.label, model: e.model, local: e.local, calls: 0, inputTokens: 0, outputTokens: 0, uncompressedInputTokens: 0, costUsd: 0, savedUsd: 0, redactions: 0, blocked: 0 };
    out.push(row);
  }
  row.label = e.label;
  if (e.blocked) {
    row.blocked++;
    return out;
  }
  row.calls++;
  row.inputTokens += e.inputTokens;
  row.outputTokens += e.outputTokens;
  row.uncompressedInputTokens += Math.max(e.uncompressedInputTokens, e.inputTokens);
  row.redactions += e.redactions;
  const p = e.local ? { input: 0, output: 0 } : price;
  const c = costUsd(p, e.inputTokens, e.outputTokens);
  const saved = costUsd(p, Math.max(0, e.uncompressedInputTokens - e.inputTokens), 0);
  row.costUsd = row.costUsd == null || c == null ? null : row.costUsd + c;
  row.savedUsd = row.savedUsd == null || saved == null ? null : row.savedUsd + saved;
  return out;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  uncompressedInputTokens: number;
  costUsd: number;
  /** Some calls had no known price (their cost is not in `costUsd`). */
  costUnknown: boolean;
  savedUsd: number;
  redactions: number;
  blocked: number;
}

export function totalsOf(rows: readonly UsageRow[]): UsageTotals {
  const t: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, uncompressedInputTokens: 0, costUsd: 0, costUnknown: false, savedUsd: 0, redactions: 0, blocked: 0 };
  for (const r of rows) {
    t.calls += r.calls;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.uncompressedInputTokens += r.uncompressedInputTokens;
    if (r.costUsd == null) t.costUnknown = true;
    else t.costUsd += r.costUsd;
    t.savedUsd += r.savedUsd ?? 0;
    t.redactions += r.redactions;
    t.blocked += r.blocked;
  }
  return t;
}

/**
 * Reads and writes this device's usage file and sums every device's for a month. Writes are
 * batched (one write per `flushMs`), since a busy agent run makes many calls a second.
 */
export class UsageStore {
  private pending: UsageEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private closed = false;

  constructor(private fs: VaultFS, readonly device: string, private policy: () => AIPolicy | null, private flushMs = 1500) {}

  record(e: UsageEvent): void {
    if (this.closed) return;
    this.pending.push(e);
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Stops writing: pending entries are dropped and later ones ignored. Call `flush()` first to
   * keep them (shutdown does); tests close without flushing so nothing writes after cleanup.
   */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closed = true;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Writes recorded calls now. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending.splice(0);
    if (!batch.length || this.closed) return this.writing;
    this.writing = this.writing.then(async () => {
      const byMonth = new Map<string, UsageEvent[]>();
      for (const e of batch) byMonth.set(monthOf(e.at), [...(byMonth.get(monthOf(e.at)) ?? []), e]);
      for (const [month, events] of byMonth) {
        const path = `${usageDir(month)}/${this.device}.json`;
        const file = await this.read(path, month);
        for (const e of events) file.rows = addUsage(file.rows, e, priceFor(this.policy(), e.model));
        await this.fs.writeText(path, `${JSON.stringify(file, null, 1)}\n`);
      }
      this.listeners.forEach((l) => l());
    }).catch((e) => console.warn('usage meter: write failed', e));
    return this.writing;
  }

  private async read(path: string, month: string): Promise<UsageFile> {
    try {
      const raw = await this.fs.readText(path);
      const f = raw ? (JSON.parse(raw) as UsageFile) : null;
      if (f && Array.isArray(f.rows)) return f;
    } catch {
      /* unreadable: start over (the old file is overwritten) */
    }
    return { version: 1, device: this.device, month, rows: [] };
  }

  /** Every device's rows for a month (YYYY-MM), plus this device's unflushed calls. */
  async month(month: string): Promise<UsageRow[]> {
    const rows: UsageRow[] = [];
    for (const e of await this.fs.list(usageDir(month))) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const f = await this.read(`${usageDir(month)}/${e.name}`, month);
      rows.push(...f.rows);
    }
    let pending: UsageRow[] = [];
    for (const e of this.pending) if (monthOf(e.at) === month) pending = addUsage(pending, e, priceFor(this.policy(), e.model));
    return [...rows, ...pending];
  }

  /** Spent this month on a budget key (all devices). Unknown prices count as zero. */
  async spent(provider: string, now = Date.now()): Promise<number> {
    return totalsOf((await this.month(monthOf(now))).filter((r) => r.provider === provider)).costUsd;
  }
}
