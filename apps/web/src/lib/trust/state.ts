/**
 * The app's side of the trust layer: the AI policy (`ai/policy.json` in the vault, plus an
 * optional managed policy an administrator serves next to the app as `managed-policy.json`),
 * and the long-lived services every guarded AI call reports to — the audit trail (signed with
 * this device's authorship key), the usage meter, the proposal store and the originals store.
 *
 * Everything here is created once the vault is open (`initTrust`, from the agent hub). Before
 * that, `currentPolicy()` is the defaults, so nothing is ever less protected than out of the box.
 */
import { create } from 'zustand';
import {
  AuditLog,
  DEFAULT_POLICY,
  POLICY_PATH,
  ProposalStore,
  UsageStore,
  accessFor,
  isLocalOnly,
  mergeManagedPolicy,
  notebookChain,
  parsePolicy,
  pruneAudit,
  serializePolicy,
  webCryptoSigner,
  type AIPolicy,
  type NoteLabel,
  type TrustServices,
} from '@inkstone/ai';
import type { NoteMeta } from '@inkstone/core';
import { deviceKey, shortDeviceId } from '../../authorship/keys.ts';
import { isArtifact } from '../../platform/env.ts';
import { useApp } from '../../state/app.ts';
import type { AppVault } from '../vault.ts';
import { IdbContentStore } from './originals.ts';

interface TrustState {
  ready: boolean;
  /** The policy in force: the user's, tightened by the managed one if there is one. */
  policy: AIPolicy;
  /** The user's own file as parsed. */
  userPolicy: AIPolicy;
  /** Problems in the user's file (shown in Settings). */
  errors: string[];
  /** The administrator's policy, when this deployment ships one. */
  managed: AIPolicy | null;
  /** This device's audit chain id. */
  device: string;
  /** Bumped when usage, audit or proposals change, so views re-read. */
  version: number;
}

export const useTrust = create<TrustState>(() => ({
  ready: false,
  policy: DEFAULT_POLICY,
  userPolicy: DEFAULT_POLICY,
  errors: [],
  managed: null,
  device: '',
  version: 0,
}));

let vaultRef: AppVault | null = null;
let services: (TrustServices & { audit: AuditLog; usage: UsageStore; proposals: ProposalStore }) | null = null;
let starting: Promise<void> | null = null;

export function currentPolicy(): AIPolicy {
  return useTrust.getState().policy;
}

/** The services guarded calls report to (null until the vault is open). */
export function trustServices(): typeof services {
  return services;
}

/**
 * An enterprise build (the Docker appliance) sets `VITE_MANAGED_POLICY_URL` (e.g.
 * `managed-policy.json`, served next to the app); other builds never ask for one.
 */
async function fetchManagedPolicy(): Promise<AIPolicy | null> {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string; VITE_MANAGED_POLICY_URL?: string } }).env;
  const url = env?.VITE_MANAGED_POLICY_URL;
  if (!url || isArtifact || typeof fetch === 'undefined') return null;
  try {
    const r = await fetch(/^https?:\/\//.test(url) ? url : `${env?.BASE_URL ?? '/'}${url.replace(/^\//, '')}`, { cache: 'no-cache' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    const { policy, errors } = parsePolicy(await r.text());
    if (errors.length) console.warn('Managed AI policy has problems:', errors);
    return policy;
  } catch {
    return null;
  }
}

/** Re-reads `ai/policy.json` (after sync pulled a change, or on start). */
export async function reloadPolicy(): Promise<void> {
  if (!vaultRef) return;
  const raw = await vaultRef.fs.readText(POLICY_PATH).catch(() => null);
  const { policy: user, errors } = parsePolicy(raw ?? '');
  const managed = useTrust.getState().managed;
  useTrust.setState({ userPolicy: user, errors, policy: managed ? mergeManagedPolicy(managed, user) : user });
}

/** Opens the trust services over the vault. Idempotent. */
export function initTrust(vault: AppVault): Promise<void> {
  if (vaultRef === vault && starting) return starting;
  vaultRef = vault;
  starting = (async () => {
    const managed = await fetchManagedPolicy();
    useTrust.setState({ managed });
    await reloadPolicy();
    let signer = null;
    let device = 'local';
    try {
      const k = await deviceKey();
      device = shortDeviceId(k.fingerprint);
      signer = webCryptoSigner(k.privateKey, k.publicJwk);
    } catch (e) {
      console.warn('Audit trail: no device key; events are hash-chained but unsigned', e);
    }
    const bump = () => useTrust.setState((s) => ({ version: s.version + 1 }));
    const audit = new AuditLog(vault.fs, device, signer);
    const usage = new UsageStore(vault.fs, device, currentPolicy);
    const proposals = new ProposalStore(vault.fs);
    audit.onChange(bump);
    usage.onChange(bump);
    proposals.onChange(bump);
    services = { policy: currentPolicy, originals: new IdbContentStore(), audit, usage, proposals };
    vault.vault.onChange((c) => { if (c.type === 'reloaded') void reloadPolicy().then(bump); });
    useTrust.setState({ ready: true, device });
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { void audit.flush(); void usage.flush(); });
    // Retention for the audit trail (activity and history read the policy where they prune).
    const p = currentPolicy();
    void pruneAudit(vault.fs, audit, p.retention.auditDays, Date.now(), p.retention.legalHold).catch(() => {});
    void proposals.prune().catch(() => {});
  })();
  return starting;
}

/** Writes the user's policy file and records the change in the audit trail. */
export async function savePolicy(next: AIPolicy, summary = 'AI policy changed'): Promise<void> {
  if (!vaultRef) throw new Error('Your notes are still opening.');
  await vaultRef.fs.writeText(POLICY_PATH, serializePolicy(next));
  await reloadPolicy();
  services?.audit.record({ kind: 'policy', actor: { source: 'user' }, summary });
}

// ---- Notes as the policy sees them ------------------------------------------------------------------

/**
 * A note's labels (notebook chain and tags). Fields the caller doesn't have are taken from the
 * library, so `{ id }` alone works for any note in it.
 */
export function labelForMeta(n: { id: string; title?: string; notebookId?: string; tags?: readonly string[] }): NoteLabel {
  const { notes, notebooks } = useApp.getState();
  const known: Partial<NoteMeta> = n.notebookId !== undefined && n.tags !== undefined ? {} : (notes.find((x) => x.id === n.id) ?? {});
  const notebookId = n.notebookId ?? known.notebookId;
  const title = n.title ?? known.title;
  return { id: n.id, ...(title ? { title } : {}), notebookIds: notebookChain(notebookId, (id) => notebooks.find((b) => b.id === id)?.parentId), tags: n.tags ?? known.tags ?? [] };
}

export function noteLabelOf(noteId: string): NoteLabel | null {
  const n = useApp.getState().notes.find((x) => x.id === noteId);
  return n ? labelForMeta(n) : null;
}

/** Whether AI may see a note at all (its notebook or tags aren't set to "none"). */
export function aiCanSee(noteId: string): boolean {
  const label = noteLabelOf(noteId);
  return !label || accessFor(currentPolicy(), label) !== 'none';
}

/** Whether a note's content may go to a cloud service (not hidden from AI, not local-only). */
export function aiMaySend(noteId: string): boolean {
  const label = noteLabelOf(noteId);
  if (!label) return true;
  const p = currentPolicy();
  return accessFor(p, label) !== 'none' && !isLocalOnly(p, label);
}
