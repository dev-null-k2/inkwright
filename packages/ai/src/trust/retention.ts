/**
 * Retention and legal hold, from the AI policy's `retention` block: how long the activity log,
 * the audit trail and version history are kept. The stores do the deleting (`ActivityStore`
 * takes `maxAgeDays`/`hold`, `VersionHistory.prune` takes `{ maxAgeDays, hold }`, `pruneAudit`
 * drops whole months and records what it removed); this module turns a policy into those
 * options so the app and the server apply the same rules.
 *
 * Legal hold wins over every number: while it is on, nothing is pruned anywhere — not even the
 * activity log's usual 300-run cap or version history's thinning.
 */
import type { AIPolicy } from './policy.ts';

export interface RetentionSettings {
  hold: boolean;
  /** 0 = the store's default. */
  activityDays: number;
  auditDays: number;
  historyDays: number;
}

export function retentionOf(policy: AIPolicy | null | undefined): RetentionSettings {
  const r = policy?.retention;
  return { hold: !!r?.legalHold, activityDays: r?.activityDays ?? 0, auditDays: r?.auditDays ?? 0, historyDays: r?.historyDays ?? 0 };
}

/** Options for `VersionHistory.prune`. */
export function historyPruneOptions(policy: AIPolicy | null | undefined): { hold: boolean; maxAgeDays: number } {
  const r = retentionOf(policy);
  return { hold: r.hold, maxAgeDays: r.historyDays };
}

/** One line for Settings and the audit trail: what the policy keeps. */
export function describeRetention(policy: AIPolicy | null | undefined): string {
  const r = retentionOf(policy);
  if (r.hold) return 'Legal hold is on: nothing is deleted automatically.';
  const part = (days: number, what: string, dflt: string) => `${what} ${days > 0 ? `for ${days} days` : dflt}`;
  return `Keeps ${[part(r.activityDays, 'AI activity', 'for its newest 300 runs'), part(r.auditDays, 'the audit trail', 'forever'), part(r.historyDays, 'version history', 'with the usual thinning')].join(', ')}.`;
}
