/**
 * The audit trail: an append-only, hash-chained, signed record of what AI saw and did — every
 * model call (which provider, which route and why, which notes' content it carried, what was
 * redacted, tokens and cost), every note an agent read or changed, policy decisions and blocks.
 * The activity log (`activity.ts`) answers "what changed and how do I undo it"; the audit trail
 * answers "what did the AI see, where did it go, and can I prove this record is complete".
 *
 * Format (docs/TRUST.md): JSON Lines in `ai/audit/<device>/<YYYY-MM>.jsonl`, one chain per device
 * (devices never write each other's files, so sync never merges them). Each event carries
 * `seq`, `prev` (the previous event's hash) and `hash` = SHA-256 of its canonical JSON without
 * `hash`/`sig`; with a signer, `sig` is an ES256 signature over the hash by a key whose public
 * half is declared by the chain's `key` event. Like the authorship chain, editing, removing or
 * reordering any event breaks every hash after it, and a forged event fails its signature.
 *
 * Honest limits: someone holding the device's private key (the device itself, unlocked) can
 * rewrite the whole chain consistently, and dropping events from the end leaves a valid shorter
 * chain. Exporting the JSONL (or just the head hash) somewhere else anchors it; `verifyAudit`
 * then reports whether a known head is still present.
 */
import { canonicalJson, sha256, type VaultFS } from '@inkstone/core';

export type AuditKind = 'key' | 'ai_call' | 'read' | 'write' | 'proposal' | 'policy' | 'blocked' | 'retention';

export interface AuditActor {
  /** assistant | routine | external | smart-ink | listen | ask | server … */
  source: string;
  label?: string;
  runId?: string;
}

export interface AuditNoteRef {
  id: string;
  title?: string;
}

/** The fields callers supply; the chain fields are added by `AuditLog`. */
export interface AuditEntry {
  kind: AuditKind;
  actor?: AuditActor;
  /** Plain one-line description for the audit view. */
  summary?: string;
  provider?: string;
  model?: string;
  /** Ran on the device (nothing left it). */
  local?: boolean;
  task?: string;
  /** Why the call went where it went (from the route decision). */
  route?: string;
  /** Notes whose content was sent (ai_call) or touched (read/write). */
  notes?: AuditNoteRef[];
  tool?: string;
  /** Counts per kind of what the privacy firewall replaced (never the values). */
  redactions?: Record<string, number>;
  tokens?: { input: number; output: number; uncompressed?: number };
  costUsd?: number | null;
  outcome?: 'ok' | 'error' | 'blocked';
  error?: string;
  /** Free-form extra data (small). */
  data?: Record<string, unknown>;
}

export interface AuditEvent extends AuditEntry {
  v: 1;
  seq: number;
  at: number;
  /** Device id (short key fingerprint, or the server's host id). */
  dev: string;
  prev: string;
  hash: string;
  sig?: string;
}

/** Signs event hashes (ES256 over the 32 hash bytes). */
export interface AuditSigner {
  /** Public key (EC P-256 JWK) declared in the chain's `key` event. */
  publicJwk: JsonWebKey;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export const AUDIT_DIR = 'ai/audit';
export const genesisOf = (dev: string) => `genesis:${dev}`;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export function eventHash(e: Omit<AuditEvent, 'hash' | 'sig'> | AuditEvent): string {
  const { hash: _h, sig: _s, ...rest } = e as AuditEvent;
  return hex(sha256(canonicalJson(rest)));
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
export const auditFile = (dev: string, month: string) => `${AUDIT_DIR}/${dev}/${month}.jsonl`;

/** Makes an ES256 signer from a WebCrypto private key (non-extractable keys work). */
export function webCryptoSigner(privateKey: CryptoKey, publicJwk: JsonWebKey): AuditSigner {
  return {
    publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data as BufferSource)),
  };
}

/** A fresh ES256 signer (for a process that has no persistent key). */
export async function ephemeralSigner(): Promise<AuditSigner> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  return webCryptoSigner(kp.privateKey, await crypto.subtle.exportKey('jwk', kp.publicKey));
}

/**
 * This device's chain. `record` is synchronous and cheap (it queues); events are linked, signed
 * and appended on `flush`, which reads the file's last event first, so a restart (or a second
 * tab) continues the chain instead of forking it.
 */
export class AuditLog {
  private queue: Array<AuditEntry & { at: number }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private keyDeclared = false;
  private listeners = new Set<() => void>();
  private closed = false;

  constructor(private fs: VaultFS, readonly dev: string, private signer: AuditSigner | null = null, private clock: () => number = Date.now, private flushMs = 800) {}

  record(entry: AuditEntry): void {
    if (this.closed) return;
    this.queue.push({ ...entry, at: this.clock() });
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

  /** Links, signs and writes everything recorded so far. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0);
    if (!batch.length || this.closed) return this.writing;
    this.writing = this.writing.then(() => this.append(batch)).catch((e) => console.warn('audit: write failed', e));
    return this.writing;
  }

  /** The last event of the chain (and the month file it is in), read from disk. */
  private async tail(): Promise<{ seq: number; hash: string; month: string } | null> {
    const months = (await this.fs.list(`${AUDIT_DIR}/${this.dev}`)).filter((e) => e.kind === 'file' && e.name.endsWith('.jsonl')).map((e) => e.name).sort();
    for (let i = months.length - 1; i >= 0; i--) {
      const lines = ((await this.fs.readText(`${AUDIT_DIR}/${this.dev}/${months[i]}`)) ?? '').trim().split('\n').filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j--) {
        try {
          const last = JSON.parse(lines[j]!) as AuditEvent;
          return { seq: last.seq, hash: last.hash, month: months[i]!.replace(/\.jsonl$/, '') };
        } catch {
          /* a torn last line: skip it */
        }
      }
    }
    return null;
  }

  private async append(batch: Array<AuditEntry & { at: number }>): Promise<void> {
    const t = await this.tail();
    let seq = t?.seq ?? 0;
    let prev = t?.hash ?? genesisOf(this.dev);
    let month = t?.month ?? '';
    const lines = new Map<string, string[]>();
    for (const entry of batch) {
      // Each month file starts by declaring the signing key (and this process declares its key
      // once), so a month verifies on its own even after retention removed older months.
      const m = monthOf(entry.at);
      const declare = this.signer && (m !== month || !this.keyDeclared);
      const todo: Array<AuditEntry & { at: number }> = declare
        ? [{ kind: 'key', at: entry.at, summary: 'Signing key for this device’s audit trail', data: { alg: 'ES256', publicJwk: this.signer!.publicJwk } }, entry]
        : [entry];
      if (declare) this.keyDeclared = true;
      month = m;
      for (const e of todo) {
        const { at, ...entryFields } = e;
        const ev: Omit<AuditEvent, 'hash' | 'sig'> = { v: 1, seq: ++seq, at, dev: this.dev, prev, ...stripUndefined(entryFields) };
        const hash = eventHash(ev);
        const full: AuditEvent = { ...ev, hash };
        if (this.signer) full.sig = b64u(await this.signer.sign(fromHex(hash)));
        prev = hash;
        lines.set(m, [...(lines.get(m) ?? []), JSON.stringify(full)]);
      }
    }
    for (const [m, ls] of lines) {
      const path = auditFile(this.dev, m);
      const existing = (await this.fs.readText(path)) ?? '';
      await this.fs.writeText(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${ls.join('\n')}\n`);
    }
    this.listeners.forEach((l) => l());
  }

  /** This device's events, newest last (optionally only the latest `limit`). */
  async events(limit?: number): Promise<AuditEvent[]> {
    await this.flush();
    const out = await readChain(this.fs, this.dev);
    return limit ? out.slice(-limit) : out;
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Device ids that have an audit chain in this vault. */
export async function auditDevices(fs: VaultFS): Promise<string[]> {
  return (await fs.list(AUDIT_DIR)).filter((e) => e.kind === 'dir').map((e) => e.name).sort();
}

/** One device's events in order (unparseable lines are returned as `null` placeholders by `parseJsonl`). */
export async function readChain(fs: VaultFS, dev: string): Promise<AuditEvent[]> {
  const months = (await fs.list(`${AUDIT_DIR}/${dev}`)).filter((e) => e.kind === 'file' && e.name.endsWith('.jsonl')).map((e) => e.name).sort();
  const out: AuditEvent[] = [];
  for (const m of months) out.push(...(parseJsonl((await fs.readText(`${AUDIT_DIR}/${dev}/${m}`)) ?? '').filter((e): e is AuditEvent => e != null)));
  return out;
}

export function parseJsonl(text: string): Array<AuditEvent | null> {
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l) as AuditEvent;
    } catch {
      return null;
    }
  });
}

/** Every device's chain as one JSONL export (devices one after another, each in order). */
export async function exportAuditJsonl(fs: VaultFS): Promise<string> {
  const lines: string[] = [];
  for (const dev of await auditDevices(fs)) for (const e of await readChain(fs, dev)) lines.push(JSON.stringify(e));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ---- Verification -----------------------------------------------------------------------------------

export interface ChainReport {
  dev: string;
  events: number;
  /** Events with a valid signature, and events that should have had one but don't verify. */
  signed: number;
  badSignatures: number[];
  /** Key fingerprints used (hex of the public point hash, first 10 bytes). */
  keys: string[];
  /** The first event does not start at genesis: older events were removed by retention. */
  startsAfterPruning: boolean;
  head: string | null;
}

export interface AuditVerifyReport {
  ok: boolean;
  chains: ChainReport[];
  /** Plain-language problems: "dev abc: event 12 was changed (hash mismatch)". */
  problems: string[];
  /** When `expectHeads` was given: heads that are no longer in the log (truncated or rewritten). */
  missingHeads: string[];
}

async function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

function keyFingerprint(jwk: JsonWebKey): string {
  return hex(sha256(`${jwk.x}.${jwk.y}`).subarray(0, 10));
}

/**
 * Verifies an exported JSONL (or the events of several devices): each device's chain must be
 * contiguous (`seq` +1, `prev` = previous `hash`), every hash must match its event, and every
 * signature must verify against the key declared before it. `expectHeads` are hashes you
 * recorded earlier (a previous export's heads); each must still be in the log.
 */
export async function verifyAudit(input: string | AuditEvent[], opts: { expectHeads?: string[]; trustedKeys?: string[] } = {}): Promise<AuditVerifyReport> {
  const problems: string[] = [];
  const parsed = typeof input === 'string' ? parseJsonl(input) : input;
  parsed.forEach((e, i) => { if (e == null) problems.push(`line ${i + 1} is not valid JSON`); });
  const events = parsed.filter((e): e is AuditEvent => e != null);
  const byDev = new Map<string, AuditEvent[]>();
  for (const e of events) byDev.set(e.dev, [...(byDev.get(e.dev) ?? []), e]);
  const chains: ChainReport[] = [];
  const allHashes = new Set(events.map((e) => e.hash));
  for (const [dev, list] of byDev) {
    const r: ChainReport = { dev, events: list.length, signed: 0, badSignatures: [], keys: [], startsAfterPruning: false, head: list[list.length - 1]?.hash ?? null };
    let key: CryptoKey | null = null;
    let prev: AuditEvent | null = null;
    for (const e of list) {
      const recomputed = eventHash(e);
      if (recomputed !== e.hash) problems.push(`${dev}: event ${e.seq} was changed after it was written (hash mismatch)`);
      if (!prev) {
        if (e.prev !== genesisOf(dev)) {
          r.startsAfterPruning = true;
          const explained = list.some((x) => x.kind === 'retention' && x.data?.prunedHead === e.prev);
          if (!explained) problems.push(`${dev}: the chain starts at event ${e.seq}, after events that are missing and not explained by a retention record`);
        }
      } else {
        if (e.seq !== prev.seq + 1) problems.push(`${dev}: event ${prev.seq + 1}${e.seq > prev.seq + 2 ? `–${e.seq - 1}` : ''} missing or out of order (found ${e.seq} after ${prev.seq})`);
        if (e.prev !== prev.hash) problems.push(`${dev}: event ${e.seq} does not link to event ${prev.seq} (removed, inserted or reordered)`);
      }
      if (e.kind === 'key' && e.data?.publicJwk) {
        const jwk = e.data.publicJwk as JsonWebKey;
        try {
          key = await importKey(jwk);
          const fp = keyFingerprint(jwk);
          r.keys.push(fp);
          if (opts.trustedKeys && !opts.trustedKeys.includes(fp)) problems.push(`${dev}: event ${e.seq} declares a key (${fp}) that is not one of the trusted keys`);
        } catch {
          problems.push(`${dev}: event ${e.seq} declares an unreadable key`);
        }
      }
      if (e.sig) {
        let ok = false;
        if (key) {
          try { ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64u(e.sig) as BufferSource, fromHex(e.hash) as BufferSource); } catch { ok = false; }
        }
        if (ok && recomputed === e.hash) r.signed++;
        else {
          r.badSignatures.push(e.seq);
          problems.push(`${dev}: event ${e.seq} has a signature that does not verify`);
        }
      } else if (key) {
        problems.push(`${dev}: event ${e.seq} is unsigned although the chain has a signing key`);
      }
      prev = e;
    }
    chains.push(r);
  }
  const missingHeads = (opts.expectHeads ?? []).filter((h) => !allHashes.has(h));
  for (const h of missingHeads) problems.push(`a previously recorded head (${h.slice(0, 12)}…) is no longer in the log: events were removed from the end or rewritten`);
  return { ok: problems.length === 0, chains, problems, missingHeads };
}

/**
 * Drops whole months older than `days` from this device's chain and records what was dropped
 * (the hash the remaining chain now starts after), so verification can tell retention from
 * tampering. Returns the number of events removed. Never runs under legal hold.
 */
export async function pruneAudit(fs: VaultFS, log: AuditLog, days: number, now: number, legalHold: boolean): Promise<number> {
  if (legalHold || days <= 0) return 0;
  await log.flush();
  const cutoff = now - days * 86_400_000;
  const dir = `${AUDIT_DIR}/${log.dev}`;
  const months = (await fs.list(dir)).filter((e) => e.kind === 'file' && e.name.endsWith('.jsonl')).map((e) => e.name).sort();
  let removed = 0;
  let prunedHead: string | null = null;
  for (const name of months.slice(0, -1)) {
    // A month goes only when everything in it is older than the cutoff (the next month starts after it).
    const events = parseJsonl((await fs.readText(`${dir}/${name}`)) ?? '').filter((e): e is AuditEvent => !!e);
    const last = events[events.length - 1];
    if (!last || last.at >= cutoff) break;
    removed += events.length;
    prunedHead = last.hash;
    await fs.delete(`${dir}/${name}`);
  }
  if (removed) log.record({ kind: 'retention', summary: `Removed ${removed} audit events older than ${days} days`, data: { prunedHead, removed, days } });
  await log.flush();
  return removed;
}
