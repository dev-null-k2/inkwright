/**
 * The trust layer on the server side (MCP, A2A and the always-on runner), sharing the AI policy
 * file (`ai/policy.json`) with the app:
 *
 * - **Policy.** `PolicySource` reads the vault's policy (re-read when the file changes) and an
 *   optional managed policy file given by the deployment (`--policy`, `INKWRIGHT_POLICY_FILE`),
 *   which users can tighten but never loosen (`mergeManagedPolicy`).
 * - **Notebook permissions.** `PolicyVault` is the `Vault` every tool, resource, prompt, task, the
 *   A2A agent and the runner read through. Notes the policy hides (`access: none`) and notes kept
 *   on the device (`localOnly` — an MCP client's model may be in the cloud, so the server never
 *   serves them) do not exist for it; read-only notes cannot be changed, moved or trashed.
 * - **The server's own AI** goes through the same guarded provider as the app's (routing,
 *   privacy firewall, budgeter, meter, audit), with its own usage file and audit chain.
 * - **Dry run** for outside agents (`agentWrites.external: "propose"`): write tools record a
 *   proposal for the user to approve in the app instead of changing notes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Vault, type NoteMeta, type NotebookMeta, type PageInk, type SaveOptions } from '@inkwright/core';
import {
  ActivityStore,
  AuditLog,
  MemoryContentStore,
  POLICY_PATH,
  ProposalStore,
  TrustRun,
  UsageStore,
  accessFor,
  createGuardedProvider,
  ephemeralSigner,
  isLocalOnly,
  mergeManagedPolicy,
  notebookChain,
  parsePolicy,
  pruneAudit,
  webCryptoSigner,
  type AIPolicy,
  type AgentTool,
  type AuditActor,
  type AuditSigner,
  type NoteLabel,
  type ProposedOp,
  type TaskKind,
  type TrustServices,
} from '@inkwright/ai';
import type { NodeFS } from './nodefs.ts';

// ---- Policy ----------------------------------------------------------------------------------------

export class PolicySource {
  private user: AIPolicy = parsePolicy('').policy;
  private managed: AIPolicy | null = null;
  private raw: string | null = null;
  errors: string[] = [];
  /** Problems in the managed file (logged once at start). */
  managedErrors: string[] = [];

  constructor(private fs: NodeFS, managedFile?: string) {
    if (managedFile) {
      const { policy, errors } = parsePolicy(readFileSync(managedFile, 'utf8'));
      this.managed = policy;
      this.managedErrors = errors;
    }
  }

  get current(): AIPolicy {
    return this.managed ? mergeManagedPolicy(this.managed, this.user) : this.user;
  }

  get isManaged(): boolean {
    return !!this.managed;
  }

  /** Re-reads the vault's policy file if it changed. */
  async refresh(): Promise<void> {
    const raw = await this.fs.readText(POLICY_PATH).catch(() => null);
    if (raw === this.raw) return;
    this.raw = raw;
    const { policy, errors } = parsePolicy(raw ?? '');
    this.user = policy;
    this.errors = errors;
  }
}

// ---- Notebook permissions ----------------------------------------------------------------------------

export class PolicyDeniedError extends Error {
  readonly code = 'policy_blocked';
  constructor(message: string) {
    super(message);
    this.name = 'PolicyBlockedError';
  }
}

/**
 * The vault as the AI policy lets agents see it. Hidden and local-only notes read as missing;
 * writes to read-only notes (or into read-only or hidden notebooks) fail with a plain message.
 * Methods not overridden here (sync-level helpers) are not used by the server's tools.
 */
export class PolicyVault extends Vault {
  constructor(fs: NodeFS, clock: () => number, private policy: () => AIPolicy) {
    super(fs, clock);
  }

  private async label(n: Pick<NoteMeta, 'id' | 'title' | 'notebookId' | 'tags'>): Promise<NoteLabel> {
    const notebooks = await super.listNotebooks();
    return { id: n.id, title: n.title, notebookIds: notebookChain(n.notebookId, (id) => notebooks.find((b) => b.id === id)?.parentId), tags: n.tags };
  }

  /** Whether agents may see a note at all. */
  async visible(n: Pick<NoteMeta, 'id' | 'title' | 'notebookId' | 'tags'>): Promise<boolean> {
    const p = this.policy();
    const l = await this.label(n);
    return accessFor(p, l) !== 'none' && !isLocalOnly(p, l);
  }

  private async requireWritable(n: Pick<NoteMeta, 'id' | 'title' | 'notebookId' | 'tags'>, what = 'change'): Promise<void> {
    const l = await this.label(n);
    const p = this.policy();
    const a = accessFor(p, l);
    if (a === 'none' || isLocalOnly(p, l)) throw new PolicyDeniedError(n.id === '(new)' ? 'Agents can’t put notes in that notebook (Inkwright AI policy).' : `No note with id ${n.id}`);
    if (a !== 'read-write') throw new PolicyDeniedError(`${n.id === '(new)' ? 'That notebook' : `“${n.title || 'This note'}”`} is read-only for agents (Inkwright AI policy); agents can’t ${what} it.`);
  }

  override async listNotes(opts: { includeTrashed?: boolean } = {}): Promise<NoteMeta[]> {
    const out: NoteMeta[] = [];
    for (const n of await super.listNotes(opts)) if (await this.visible(n)) out.push(n);
    return out;
  }

  override async readNote(id: string, opts: { unlocked?: boolean } = {}): Promise<NoteMeta | null> {
    const n = await super.readNote(id, opts);
    return n && (await this.visible(n)) ? n : null;
  }

  override async readPage(noteId: string, pageId: string): Promise<PageInk> {
    const n = await super.readNote(noteId);
    if (n && !(await this.visible(n))) throw new PolicyDeniedError(`No note with id ${noteId}`);
    return super.readPage(noteId, pageId);
  }

  override async readPages(note: NoteMeta, opts: { unlocked?: boolean } = {}): Promise<PageInk[]> {
    const cur = (await super.readNote(note.id)) ?? note;
    if (!(await this.visible(cur))) throw new PolicyDeniedError(`No note with id ${note.id}`);
    return super.readPages(note, opts);
  }

  override async saveNote(note: NoteMeta, pages: PageInk[], opts: SaveOptions = {}): Promise<void> {
    const cur = await super.readNote(note.id);
    if (cur) await this.requireWritable(cur);
    await this.requireWritable(cur ? note : { ...note, id: '(new)' }, cur ? 'move' : 'create');
    return super.saveNote(note, pages, opts);
  }

  override async updateNote(id: string, transform: (n: NoteMeta) => NoteMeta, opts: { touch?: boolean } = {}): Promise<NoteMeta | null> {
    const cur = await super.readNote(id);
    if (!cur) return null;
    await this.requireWritable(cur);
    await this.requireWritable(transform(cur), 'move');
    return super.updateNote(id, transform, opts);
  }

  override async deleteNote(id: string): Promise<void> {
    const cur = await super.readNote(id);
    if (cur) await this.requireWritable(cur, 'delete');
    return super.deleteNote(id);
  }

  override async readAsset(noteId: string, name: string): Promise<Uint8Array | null> {
    const n = await super.readNote(noteId);
    if (n && !(await this.visible(n))) return null;
    return super.readAsset(noteId, name);
  }

  override async writeAsset(noteId: string, name: string, bytes: Uint8Array): Promise<string> {
    const n = await super.readNote(noteId);
    if (n) await this.requireWritable(n);
    return super.writeAsset(noteId, name, bytes);
  }

  override async listNotebooks(): Promise<NotebookMeta[]> {
    const all = await super.listNotebooks();
    const p = this.policy();
    return all.filter((b) => {
      const l: NoteLabel = { id: '', notebookIds: notebookChain(b.id, (id) => all.find((x) => x.id === id)?.parentId) };
      return accessFor(p, l) !== 'none' && !isLocalOnly(p, l);
    });
  }

  override async createNotebook(name: string, color?: string, parentId?: string): Promise<NotebookMeta> {
    if (parentId) await this.requireWritable({ id: '(new)', title: name, notebookId: parentId, tags: [] }, 'create');
    return super.createNotebook(name, color, parentId);
  }
}

// ---- Services ------------------------------------------------------------------------------------------

export interface ServerTrust extends TrustServices {
  audit: AuditLog;
  usage: UsageStore;
  proposals: ProposalStore;
  device: string;
}

/**
 * The server's chain id: stable for this computer and vault, so a restarted server continues its
 * chain (each process declares its signing key in it).
 */
export function serverDeviceId(root: string): string {
  return `srv-${createHash('sha256').update(`${hostname()}\n${root}`).digest('hex').slice(0, 8)}`;
}

/**
 * Loads the audit signing key: a P-256 private JWK file (`--audit-key`, `INKWRIGHT_AUDIT_KEY`), so
 * signatures verify against a key the operator controls and can publish; otherwise a fresh key
 * for this process (still a valid, verifiable chain, but not tied to an identity).
 */
export async function loadAuditSigner(file?: string): Promise<AuditSigner> {
  if (!file) return ephemeralSigner();
  const jwk = JSON.parse(readFileSync(file, 'utf8')) as JsonWebKey;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error(`${file} is not a P-256 private key in JWK format.`);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return webCryptoSigner(key, { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
}

export function createServerTrust(fs: NodeFS, root: string, policy: () => AIPolicy, opts: { signer?: AuditSigner | null; clock?: () => number } = {}): ServerTrust {
  const device = serverDeviceId(root);
  return {
    device,
    policy,
    originals: new MemoryContentStore(),
    audit: new AuditLog(fs, device, opts.signer ?? null, opts.clock),
    usage: new UsageStore(fs, device, policy),
    proposals: new ProposalStore(fs, opts.clock),
  };
}

/** What the server's AI needs to know about itself for routing. */
export interface ServerAIInfo {
  provider: import('@inkwright/ai').Provider;
  model: string;
  label: string;
  vision: boolean;
  /** Runs inside the deployment (localhost, or `--ai-on-premises`): counts as "this device". */
  local?: boolean;
  /** Budget key: the provider id (e.g. `anthropic`). */
  budgetKey?: string;
}

/**
 * The server's AI wrapped in the guarded provider. The server has one AI, so `auto`,
 * `provider:*` and `device` (when the AI is on-premises) all resolve to it; `device` with a cloud
 * AI and `off` refuse.
 */
export function guardServerAI<T extends ServerAIInfo>(ai: T, trust: ServerTrust, actor: AuditActor, o: { task?: TaskKind; run?: TrustRun } = {}): T & { trust: TrustRun } {
  const run = o.run ?? new TrustRun();
  const route = { provider: ai.provider, model: ai.model, label: ai.label, local: !!ai.local, budgetKey: ai.budgetKey ?? ai.provider.id, vision: ai.vision };
  const provider = createGuardedProvider({
    services: trust,
    actor,
    run,
    ...(o.task ? { task: o.task } : {}),
    resolve: async (target) => (target === 'off' || (target === 'device' && !ai.local) ? null : route),
  });
  return { ...ai, provider, trust: run };
}

/**
 * For unattended agents: tools that need confirmation once a run read suspicious content go to
 * the approver (like destructive ones), instead of being refused outright.
 */
export function gateSuspicious(tools: AgentTool[], approver: (req: { tool: string; args: Record<string, unknown>; title: string; detail?: string }) => Promise<'approved' | 'denied' | 'deferred'>): AgentTool[] {
  return tools.map((t) => {
    if (!t.needsConfirmation) return t;
    const check = t.needsConfirmation;
    const { needsConfirmation: _n, ...rest } = t;
    return {
      ...rest,
      async execute(args: Record<string, unknown>, c) {
        if (!check(args)) return t.execute(args, c);
        const decision = await approver({ tool: t.name, args, title: `Allow ${t.name} after reading content that looks like planted instructions?`, detail: JSON.stringify(args).slice(0, 300) });
        if (decision === 'approved') return t.execute(args, c);
        if (decision === 'denied') throw new Error('The user declined this action. Don’t retry it.');
        return { waiting_for_approval: true, message: 'This change waits for the user’s OK because something read earlier looked like instructions planted for the AI. Don’t retry it; mention it in your summary.' };
      },
    } as AgentTool;
  });
}

// ---- Outside agents: audit and dry run --------------------------------------------------------------------

/** Note ids a tool call touched, from its arguments and (JSON) result, for the audit trail. */
export function notesTouched(args: Record<string, unknown>, resultText: string | undefined): Array<{ id: string; title?: string }> {
  const out = new Map<string, string | undefined>();
  for (const k of ['id', 'note_id', 'noteId']) if (typeof args[k] === 'string') out.set(args[k] as string, undefined);
  if (resultText) {
    try {
      const j = JSON.parse(resultText) as Record<string, unknown>;
      const list = (j.hits ?? j.notes ?? (j.id ? [j] : [])) as Array<{ id?: string; title?: string }>;
      for (const x of Array.isArray(list) ? list.slice(0, 100) : []) if (typeof x?.id === 'string') out.set(x.id, x.title);
    } catch {
      /* Markdown or text: the arguments say enough */
    }
  }
  return [...out].map(([id, title]) => ({ id, ...(title ? { title } : {}) }));
}

/**
 * The proposal an MCP write tool becomes under dry run, in the app's NoteToolHost terms (so the
 * app can apply it through its recorded, undoable host). Null for tools that can't be proposed.
 */
export async function proposalFor(vault: Vault, tool: string, args: Record<string, any>): Promise<{ op: ProposedOp; summary: string; noteId?: string; noteTitle?: string; before: string; after: string } | null> {
  const q = (s: string | undefined) => `“${(s || 'Untitled').slice(0, 60)}”`;
  const noteOf = async (id: unknown) => (typeof id === 'string' ? vault.readNote(id) : null);
  const textOf = async (n: NoteMeta) => (await vault.readPages(n)).map((p) => [...(p.texts ?? []).map((t) => t.text), p.recognizedText ?? ''].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
  switch (tool) {
    case 'create_note': {
      const notebooks = await vault.listNotebooks();
      const ref = typeof args.notebookId === 'string' ? args.notebookId.toLowerCase() : null;
      const nb = ref ? notebooks.find((b) => b.id === args.notebookId || b.name.toLowerCase() === ref) : undefined;
      if (ref && !nb) return null;
      const text = String(args.text ?? '');
      return { op: { op: 'createNote', args: { title: String(args.title ?? 'Untitled'), text, ...(nb ? { notebookId: nb.id } : {}), ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}) } }, summary: `Create note ${q(args.title)}`, noteTitle: String(args.title ?? ''), before: '', after: `${args.title ?? ''}\n\n${text}` };
    }
    case 'append_to_note': {
      const n = await noteOf(args.id);
      if (!n) return null;
      const before = await textOf(n);
      const text = String(args.text ?? '');
      return { op: { op: 'appendText', noteId: n.id, text, ...(typeof args.page === 'number' ? { pageIndex: args.page - 1 } : {}) }, summary: `Add text to ${q(n.title)}`, noteId: n.id, noteTitle: n.title, before, after: before ? `${before}\n\n${text}` : text };
    }
    case 'update_note': {
      const n = await noteOf(args.id);
      if (!n) return null;
      let notebookId: string | null | undefined;
      if (args.notebookId === null) notebookId = null;
      else if (typeof args.notebookId === 'string') {
        const ref = args.notebookId.toLowerCase();
        notebookId = (await vault.listNotebooks()).find((b) => b.id === args.notebookId || b.name.toLowerCase() === ref)?.id;
        if (!notebookId) return null;
      }
      const patch = { ...(typeof args.title === 'string' ? { title: args.title } : {}), ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}), ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}), ...(typeof args.summary === 'string' ? { summary: args.summary } : {}), ...(notebookId !== undefined ? { notebookId } : {}) };
      const line = (m: Partial<NoteMeta>) => `Title: ${m.title ?? ''}\nTags: ${(m.tags ?? []).map((t) => `#${t}`).join(' ')}\nPinned: ${m.pinned ? 'yes' : 'no'}`;
      return { op: { op: 'updateNote', noteId: n.id, patch }, summary: `Change ${q(n.title)}`, noteId: n.id, noteTitle: n.title, before: line(n), after: line({ ...n, ...patch, notebookId: patch.notebookId ?? undefined }) };
    }
    case 'trash_note': {
      const n = await noteOf(args.id);
      if (!n) return null;
      return { op: { op: 'trashNote', noteId: n.id }, summary: `Move ${q(n.title)} to Trash`, noteId: n.id, noteTitle: n.title, before: await textOf(n), after: '(moved to Trash)' };
    }
    case 'create_notebook':
      return { op: { op: 'createNotebook', name: String(args.name ?? 'Untitled'), ...(typeof args.parentId === 'string' ? { parentId: args.parentId } : {}) }, summary: `Create notebook ${q(args.name)}`, before: '', after: `Notebook: ${args.name ?? ''}` };
    default:
      return null;
  }
}

/**
 * The server's AI behind the trust layer: one guarded instance for one-shot calls (summaries,
 * transcription) and `forRun` for agent runs, each with its own trust run.
 */
export function trustedAI<A extends ServerAIInfo & { forRun?: unknown; trust?: unknown }>(ai: A | null, trust: ServerTrust): A | null {
  if (!ai) return null;
  const base = { ...ai };
  const make = (actor: AuditActor): A => {
    const g = guardServerAI(base, trust, actor) as A;
    return Object.assign(g, { forRun: (a: AuditActor) => make(a) });
  };
  return make({ source: 'server' });
}

/** Startup lines about the policy in force (problems in the files, managed or not). */
export function logPolicy(ctx: { policy: PolicySource; trust: ServerTrust }, log: (m: string) => void): void {
  if (ctx.policy.managedErrors.length) log(`Managed AI policy: ${ctx.policy.managedErrors.join('; ')} (safe defaults used for those fields)`);
  if (ctx.policy.errors.length) log(`ai/policy.json: ${ctx.policy.errors.join('; ')} (safe defaults used for those fields)`);
  log(`AI policy: ${ctx.policy.isManaged ? 'managed policy + ' : ''}ai/policy.json; audit trail ai/audit/${ctx.trust.device}/`);
}

/**
 * Applies the policy's retention on the server (at start): activity runs and audit months past
 * their periods, decided proposals after 30 days. Nothing under legal hold. Version history is
 * pruned where snapshots are taken (the app); the server only adds snapshots before agent writes.
 */
export async function applyServerRetention(ctx: { fs: NodeFS; clock: () => number; policy: PolicySource; trust: ServerTrust }): Promise<{ activity: number; audit: number; proposals: number }> {
  const r = ctx.policy.current.retention;
  if (r.legalHold) return { activity: 0, audit: 0, proposals: 0 };
  const activity = await new ActivityStore(ctx.fs, { maxAgeDays: () => r.activityDays, clock: ctx.clock }).prune();
  const audit = await pruneAudit(ctx.fs, ctx.trust.audit, r.auditDays, ctx.clock(), r.legalHold);
  const proposals = await ctx.trust.proposals.prune();
  return { activity, audit, proposals };
}
