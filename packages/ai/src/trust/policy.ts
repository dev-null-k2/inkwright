/**
 * The AI policy: one readable JSON file in the vault (`ai/policy.json`) that says where each kind
 * of AI work may run, what the assistant may see and change, how much each provider may cost, and
 * what leaves the device. The app, the MCP server, the A2A agent and the always-on runner all read
 * the same file and enforce it at their single AI choke point (`createGuardedProvider`) and note
 * access layer (`AccessControlledNoteToolHost` / the server's policy vault).
 *
 * Why a file and not app settings: it syncs with the notes it governs, so a rule like "the
 * Clients notebook never leaves the device" holds on every device and for every agent, it can be
 * reviewed in a text editor or a pull request, and an administrator can ship a managed copy that
 * users cannot loosen (`mergeManagedPolicy`). The schema is documented in docs/TRUST.md.
 *
 * Everything here is pure: parsing never throws (a broken file is reported and falls back to
 * safe defaults), and routing is a function of the policy and the call's context.
 */

/** What kind of AI work a call is. Callers say; `inferTask` guesses for those that don't. */
export type TaskKind = 'background' | 'chat' | 'heavy' | 'vision';

export const TASK_KINDS: readonly TaskKind[] = ['background', 'chat', 'heavy', 'vision'];

export const TASK_LABELS: Record<TaskKind, { label: string; hint: string }> = {
  background: { label: 'Background work', hint: 'Tagging, titles, page summaries, routines' },
  chat: { label: 'Chat', hint: 'The assistant panel and Ask' },
  heavy: { label: 'Heavy synthesis', hint: 'Whole-notebook and lecture summaries' },
  vision: { label: 'Reading handwriting', hint: 'Page images: maths, tables, transcription' },
};

/**
 * Where a task may run:
 * - `auto`: whatever Settings › AI › "Who answers" picks (the app's normal behaviour);
 * - `device`: only on this device (an on-device model, Chrome's built-in AI, or a local server
 *   such as Ollama on this computer);
 * - `provider:<id>`: one configured provider (its Settings id in the app; on the server, the
 *   server's own AI);
 * - `off`: no AI for this kind of work.
 */
export type RouteTarget = 'auto' | 'device' | 'off' | `provider:${string}`;

export type NotebookAccess = 'none' | 'read' | 'read-write';

/** Rules for one notebook or tag. */
export interface ScopeRule {
  /** What agents may do with these notes (default read-write). */
  access?: NotebookAccess;
  /** Content from these notes never goes to a cloud provider. */
  localOnly?: boolean;
}

export type PiiKind =
  | 'email'
  | 'phone'
  | 'card'
  | 'iban'
  | 'gov_id'
  | 'secret'
  | 'address'
  | 'name'
  | 'ip';

export const PII_KINDS: readonly PiiKind[] = ['email', 'phone', 'card', 'iban', 'gov_id', 'secret', 'address', 'name', 'ip'];

export const PII_LABELS: Record<PiiKind, string> = {
  email: 'Email addresses',
  phone: 'Phone numbers',
  card: 'Payment card numbers',
  iban: 'Bank account numbers (IBAN)',
  gov_id: 'Government ID numbers',
  secret: 'API keys, passwords and private keys',
  address: 'Street addresses',
  name: 'People’s names',
  ip: 'IP addresses',
};

/** What happens to personal data before a cloud call. */
export type PrivacyAction = 'redact' | 'block' | 'allow';

export interface PrivacyPolicy {
  /** Master switch: `redact` replaces findings with placeholders; `off` sends text as written. */
  mode: 'redact' | 'off';
  /** Per kind: redact (default), block the call, or allow. */
  kinds: Partial<Record<PiiKind, PrivacyAction>>;
  /** Words never treated as personal data (your company name, a public email). */
  allowList?: string[];
}

export interface Budget {
  /** Hard monthly limit in US dollars for this provider (all devices together). */
  monthlyUsd: number;
  /** What to do once it is reached: run on the device instead, or stop. */
  onExceed: 'device' | 'block';
}

export interface Price {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cached input tokens (providers with prompt caching). */
  cachedInput?: number;
}

export type WriteMode = 'apply' | 'propose';

export interface AIPolicy {
  version: 1;
  /** Where each kind of task runs. */
  routes: Record<TaskKind, RouteTarget>;
  /** Per notebook id. A note's notebook and all its parent notebooks apply (the strictest wins). */
  notebooks: Record<string, ScopeRule>;
  /** Per tag (without `#`, case-insensitive). */
  tags: Record<string, ScopeRule>;
  /** Monthly spend limits per provider (key: provider config id, or provider id such as `anthropic`). */
  budgets: Record<string, Budget>;
  privacy: PrivacyPolicy;
  compression: {
    enabled: boolean;
    /** Tool results and passages shorter than this (estimated tokens) are left alone. */
    minTokens: number;
    /** Let a model on this device summarize long prose that the rules can't shrink. */
    deviceSummaries: boolean;
  };
  injection: {
    /** Wrap note, web and connected-app content in marked "untrusted data" blocks. */
    spotlight: boolean;
    /** After untrusted content that looks like instructions, ask before any write. */
    confirmWritesAfterSuspicious: boolean;
    /**
     * Strict: after the assistant reads any note, page or app result, every change asks first —
     * independent of detection (which is a heuristic; docs/TRUST.md publishes its misses).
     */
    confirmWritesAfterAnyRead?: boolean;
  };
  /** Tool names agents may never call (e.g. `notion__delete_page`), and an optional allowlist. */
  tools: { deny: string[]; allowOnly?: string[] };
  /** Whether agents change notes directly or propose changes for you to approve (dry run). */
  agentWrites: { assistant: WriteMode; routine: WriteMode; external: WriteMode };
  retention: {
    /** Days to keep AI activity runs (0 = keep the newest 300, the default). */
    activityDays: number;
    /** Days to keep the audit trail (0 = forever). */
    auditDays: number;
    /** Days to keep version history snapshots (0 = the app's default thinning). */
    historyDays: number;
    /** While on, nothing is deleted by retention, whatever the numbers say. */
    legalHold: boolean;
  };
  /** Price overrides per model (glob such as `claude-sonnet-*`), USD per million tokens. */
  prices: Record<string, Price>;
}

export const POLICY_PATH = 'ai/policy.json';

export const DEFAULT_POLICY: AIPolicy = Object.freeze({
  version: 1,
  routes: { background: 'auto', chat: 'auto', heavy: 'auto', vision: 'auto' },
  notebooks: {},
  tags: {},
  budgets: {},
  privacy: { mode: 'redact', kinds: { secret: 'redact', card: 'redact', iban: 'redact', gov_id: 'redact', email: 'redact', phone: 'redact', address: 'allow', name: 'allow', ip: 'allow' } },
  compression: { enabled: true, minTokens: 600, deviceSummaries: false },
  injection: { spotlight: true, confirmWritesAfterSuspicious: true },
  tools: { deny: [] },
  agentWrites: { assistant: 'apply', routine: 'apply', external: 'apply' },
  retention: { activityDays: 0, auditDays: 0, historyDays: 0, legalHold: false },
  prices: {},
}) as AIPolicy;

/** A fresh, mutable copy of the defaults. */
export function defaultPolicy(): AIPolicy {
  return structuredClone(DEFAULT_POLICY) as AIPolicy;
}

// ---- Parsing ------------------------------------------------------------------------------------

export interface PolicyParse {
  policy: AIPolicy;
  /** Problems found, each naming the field. Fields with problems keep their default. */
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ROUTE_RE = /^(auto|device|off|provider:[\w.:-]{1,80})$/;
const ACCESS: readonly NotebookAccess[] = ['none', 'read', 'read-write'];
const ACTIONS: readonly PrivacyAction[] = ['redact', 'block', 'allow'];

function num(v: unknown, path: string, errors: string[], min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    errors.push(`${path}: expected a number between ${min} and ${max}`);
    return undefined;
  }
  return v;
}

function bool(v: unknown, path: string, errors: string[]): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    errors.push(`${path}: expected true or false`);
    return undefined;
  }
  return v;
}

function scopeRules(v: unknown, path: string, errors: string[], key: (k: string) => string): Record<string, ScopeRule> {
  const out: Record<string, ScopeRule> = {};
  if (v === undefined) return out;
  if (!isObj(v)) {
    errors.push(`${path}: expected an object`);
    return out;
  }
  for (const [k, r] of Object.entries(v)) {
    if (!isObj(r)) {
      errors.push(`${path}.${k}: expected an object`);
      continue;
    }
    const rule: ScopeRule = {};
    if (r.access !== undefined) {
      if (ACCESS.includes(r.access as NotebookAccess)) rule.access = r.access as NotebookAccess;
      else errors.push(`${path}.${k}.access: expected none, read or read-write`);
    }
    const lo = bool(r.localOnly, `${path}.${k}.localOnly`, errors);
    if (lo !== undefined) rule.localOnly = lo;
    out[key(k)] = rule;
  }
  return out;
}

const tagKey = (t: string) => t.replace(/^#/, '').toLowerCase();

/**
 * Reads a policy from JSON text (or an already-parsed value). Unknown fields are ignored, bad
 * fields are reported and replaced by their defaults — a typo must never switch protection off,
 * so a broken `privacy.mode` stays `redact` rather than becoming `off`.
 */
export function parsePolicy(input: string | unknown): PolicyParse {
  const errors: string[] = [];
  const policy = defaultPolicy();
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (!input.trim()) return { policy, errors };
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return { policy, errors: [`Not valid JSON: ${(e as Error).message}`] };
    }
  }
  if (raw == null) return { policy, errors };
  if (!isObj(raw)) return { policy, errors: ['The policy must be a JSON object'] };
  if (raw.version !== undefined && raw.version !== 1) errors.push(`version: ${String(raw.version)} is not supported (expected 1); reading what is understood`);

  if (raw.routes !== undefined) {
    if (!isObj(raw.routes)) errors.push('routes: expected an object');
    else for (const k of TASK_KINDS) {
      const v = raw.routes[k];
      if (v === undefined) continue;
      if (typeof v === 'string' && ROUTE_RE.test(v)) policy.routes[k] = v as RouteTarget;
      else errors.push(`routes.${k}: expected auto, device, off or provider:<id>`);
    }
  }
  policy.notebooks = scopeRules(raw.notebooks, 'notebooks', errors, (k) => k);
  policy.tags = scopeRules(raw.tags, 'tags', errors, tagKey);

  if (raw.budgets !== undefined) {
    if (!isObj(raw.budgets)) errors.push('budgets: expected an object');
    else for (const [k, b] of Object.entries(raw.budgets)) {
      if (!isObj(b)) { errors.push(`budgets.${k}: expected an object`); continue; }
      const usd = num(b.monthlyUsd, `budgets.${k}.monthlyUsd`, errors, 0, 1e7);
      if (usd === undefined) { if (b.monthlyUsd === undefined) errors.push(`budgets.${k}.monthlyUsd: required`); continue; }
      const onExceed = b.onExceed === 'device' ? 'device' : 'block';
      if (b.onExceed !== undefined && b.onExceed !== 'device' && b.onExceed !== 'block') errors.push(`budgets.${k}.onExceed: expected device or block`);
      policy.budgets[k] = { monthlyUsd: usd, onExceed };
    }
  }

  if (raw.privacy !== undefined) {
    if (!isObj(raw.privacy)) errors.push('privacy: expected an object');
    else {
      const p = raw.privacy;
      if (p.mode !== undefined) {
        if (p.mode === 'redact' || p.mode === 'off') policy.privacy.mode = p.mode;
        else errors.push('privacy.mode: expected redact or off');
      }
      if (p.kinds !== undefined) {
        if (!isObj(p.kinds)) errors.push('privacy.kinds: expected an object');
        else for (const [k, a] of Object.entries(p.kinds)) {
          if (!PII_KINDS.includes(k as PiiKind)) { errors.push(`privacy.kinds.${k}: unknown kind`); continue; }
          if (!ACTIONS.includes(a as PrivacyAction)) { errors.push(`privacy.kinds.${k}: expected redact, block or allow`); continue; }
          policy.privacy.kinds[k as PiiKind] = a as PrivacyAction;
        }
      }
      if (p.allowList !== undefined) {
        if (Array.isArray(p.allowList) && p.allowList.every((x) => typeof x === 'string')) policy.privacy.allowList = (p.allowList as string[]).slice(0, 500);
        else errors.push('privacy.allowList: expected a list of strings');
      }
    }
  }

  if (raw.compression !== undefined) {
    if (!isObj(raw.compression)) errors.push('compression: expected an object');
    else {
      const c = raw.compression;
      const en = bool(c.enabled, 'compression.enabled', errors);
      if (en !== undefined) policy.compression.enabled = en;
      const min = num(c.minTokens, 'compression.minTokens', errors, 50, 1_000_000);
      if (min !== undefined) policy.compression.minTokens = Math.round(min);
      const ds = bool(c.deviceSummaries, 'compression.deviceSummaries', errors);
      if (ds !== undefined) policy.compression.deviceSummaries = ds;
    }
  }

  if (raw.injection !== undefined) {
    if (!isObj(raw.injection)) errors.push('injection: expected an object');
    else {
      const sp = bool(raw.injection.spotlight, 'injection.spotlight', errors);
      if (sp !== undefined) policy.injection.spotlight = sp;
      const cw = bool(raw.injection.confirmWritesAfterSuspicious, 'injection.confirmWritesAfterSuspicious', errors);
      if (cw !== undefined) policy.injection.confirmWritesAfterSuspicious = cw;
      const ca = bool(raw.injection.confirmWritesAfterAnyRead, 'injection.confirmWritesAfterAnyRead', errors);
      if (ca !== undefined) policy.injection.confirmWritesAfterAnyRead = ca;
    }
  }

  if (raw.tools !== undefined) {
    if (!isObj(raw.tools)) errors.push('tools: expected an object');
    else {
      const strings = (v: unknown, path: string) => {
        if (v === undefined) return undefined;
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
        errors.push(`${path}: expected a list of tool names`);
        return undefined;
      };
      policy.tools.deny = strings(raw.tools.deny, 'tools.deny') ?? [];
      const allow = strings(raw.tools.allowOnly, 'tools.allowOnly');
      if (allow) policy.tools.allowOnly = allow;
    }
  }

  if (raw.agentWrites !== undefined) {
    if (!isObj(raw.agentWrites)) errors.push('agentWrites: expected an object');
    else for (const k of ['assistant', 'routine', 'external'] as const) {
      const v = raw.agentWrites[k];
      if (v === undefined) continue;
      if (v === 'apply' || v === 'propose') policy.agentWrites[k] = v;
      else errors.push(`agentWrites.${k}: expected apply or propose`);
    }
  }

  if (raw.retention !== undefined) {
    if (!isObj(raw.retention)) errors.push('retention: expected an object');
    else {
      const r = raw.retention;
      for (const k of ['activityDays', 'auditDays', 'historyDays'] as const) {
        const v = num(r[k], `retention.${k}`, errors, 0, 36500);
        if (v !== undefined) policy.retention[k] = Math.round(v);
      }
      const lh = bool(r.legalHold, 'retention.legalHold', errors);
      if (lh !== undefined) policy.retention.legalHold = lh;
    }
  }

  if (raw.prices !== undefined) {
    if (!isObj(raw.prices)) errors.push('prices: expected an object');
    else for (const [k, p] of Object.entries(raw.prices)) {
      if (!isObj(p)) { errors.push(`prices.${k}: expected an object`); continue; }
      const input = num(p.input, `prices.${k}.input`, errors, 0, 10_000);
      const output = num(p.output, `prices.${k}.output`, errors, 0, 10_000);
      const cached = num(p.cachedInput, `prices.${k}.cachedInput`, errors, 0, 10_000);
      if (input === undefined || output === undefined) { if (p.input === undefined || p.output === undefined) errors.push(`prices.${k}: needs input and output`); continue; }
      policy.prices[k] = { input, output, ...(cached !== undefined ? { cachedInput: cached } : {}) };
    }
  }
  return { policy, errors };
}

/**
 * The policy as it is written to disk: only fields that differ from the defaults, so the file
 * stays short and readable, plus `version`. `parsePolicy(serializePolicy(p))` gives back `p`.
 */
export function serializePolicy(p: AIPolicy): string {
  const d = DEFAULT_POLICY as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { version: 1 };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'version') continue;
    if (JSON.stringify(v) !== JSON.stringify(d[k])) out[k] = v;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

// ---- Managed policy -------------------------------------------------------------------------------

const ACCESS_RANK: Record<NotebookAccess, number> = { none: 0, read: 1, 'read-write': 2 };
const ACTION_RANK: Record<PrivacyAction, number> = { block: 0, redact: 1, allow: 2 };

function stricterRule(a: ScopeRule | undefined, b: ScopeRule | undefined): ScopeRule {
  const access = [a?.access, b?.access].filter(Boolean) as NotebookAccess[];
  const out: ScopeRule = {};
  if (access.length) out.access = access.reduce((x, y) => (ACCESS_RANK[x] <= ACCESS_RANK[y] ? x : y));
  if (a?.localOnly || b?.localOnly) out.localOnly = true;
  return out;
}

function stricterRoute(admin: RouteTarget, user: RouteTarget): RouteTarget {
  if (admin === 'off' || user === 'off') return 'off';
  if (admin === 'device' || user === 'device') return 'device';
  if (admin.startsWith('provider:')) return admin; // the administrator picked the provider
  return user;
}

/**
 * An administrator's managed policy (enterprise deployments: a file the server or the web app is
 * given) combined with the user's: for every rule the stricter one wins, so users can tighten but
 * never loosen what the organisation set. Prices and budgets from the managed policy replace the
 * user's for the same key.
 */
export function mergeManagedPolicy(managed: AIPolicy, user: AIPolicy): AIPolicy {
  const out = structuredClone(user) as AIPolicy;
  for (const k of TASK_KINDS) out.routes[k] = stricterRoute(managed.routes[k], user.routes[k]);
  for (const [id, r] of Object.entries(managed.notebooks)) out.notebooks[id] = stricterRule(r, user.notebooks[id]);
  for (const [t, r] of Object.entries(managed.tags)) out.tags[t] = stricterRule(r, user.tags[t]);
  Object.assign(out.budgets, managed.budgets);
  Object.assign(out.prices, managed.prices);
  if (managed.privacy.mode === 'redact') out.privacy.mode = 'redact';
  for (const k of PII_KINDS) {
    const a = managed.privacy.kinds[k] ?? 'allow';
    const b = user.privacy.kinds[k] ?? 'allow';
    out.privacy.kinds[k] = ACTION_RANK[a] <= ACTION_RANK[b] ? a : b;
  }
  // An allow list loosens redaction, so a managed one replaces the user's rather than adding to it.
  if (managed.privacy.allowList) out.privacy.allowList = [...managed.privacy.allowList];
  out.compression = { ...user.compression };
  out.injection = {
    spotlight: managed.injection.spotlight || user.injection.spotlight,
    confirmWritesAfterSuspicious: managed.injection.confirmWritesAfterSuspicious || user.injection.confirmWritesAfterSuspicious,
    ...(managed.injection.confirmWritesAfterAnyRead || user.injection.confirmWritesAfterAnyRead ? { confirmWritesAfterAnyRead: true } : {}),
  };
  out.tools = {
    deny: [...new Set([...managed.tools.deny, ...user.tools.deny])],
    ...(managed.tools.allowOnly || user.tools.allowOnly
      ? { allowOnly: managed.tools.allowOnly && user.tools.allowOnly ? managed.tools.allowOnly.filter((t) => user.tools.allowOnly!.includes(t)) : (managed.tools.allowOnly ?? user.tools.allowOnly)! }
      : {}),
  };
  for (const k of ['assistant', 'routine', 'external'] as const) if (managed.agentWrites[k] === 'propose') out.agentWrites[k] = 'propose';
  // Retention: the organisation's numbers and legal hold win outright (records rules are not personal taste).
  out.retention = {
    activityDays: managed.retention.activityDays || user.retention.activityDays,
    auditDays: managed.retention.auditDays || user.retention.auditDays,
    historyDays: managed.retention.historyDays || user.retention.historyDays,
    legalHold: managed.retention.legalHold || user.retention.legalHold,
  };
  return out;
}

// ---- Questions the enforcement points ask ------------------------------------------------------------

/** What the policy needs to know about a note. */
export interface NoteLabel {
  id: string;
  title?: string;
  /** The note's notebook and its ancestors, innermost first. */
  notebookIds?: readonly string[];
  tags?: readonly string[];
}

/** The rules that apply to a note: all of its notebooks' and tags' rules combined, strictest first. */
export function rulesFor(policy: AIPolicy, note: NoteLabel): ScopeRule {
  let rule: ScopeRule = {};
  for (const id of note.notebookIds ?? []) if (policy.notebooks[id]) rule = stricterRule(rule, policy.notebooks[id]);
  for (const t of note.tags ?? []) {
    const r = policy.tags[tagKey(t)];
    if (r) rule = stricterRule(rule, r);
  }
  return rule;
}

/** What agents may do with a note. */
export function accessFor(policy: AIPolicy, note: NoteLabel): NotebookAccess {
  return rulesFor(policy, note).access ?? 'read-write';
}

/** Whether a note's content must stay on the device. */
export function isLocalOnly(policy: AIPolicy, note: NoteLabel): boolean {
  return !!rulesFor(policy, note).localOnly;
}

/** True when the policy restricts anything by notebook or tag (callers can skip lookups otherwise). */
export function hasScopeRules(policy: AIPolicy): boolean {
  return Object.keys(policy.notebooks).length > 0 || Object.keys(policy.tags).length > 0;
}

/** Whether an agent may call a tool by name (deny list, then the allowlist if there is one). */
export function toolAllowed(policy: AIPolicy, name: string): boolean {
  const match = (pattern: string) => new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
  if (policy.tools.deny.some(match)) return false;
  if (policy.tools.allowOnly && !policy.tools.allowOnly.some(match)) return false;
  return true;
}

/** Notebook ids from a note's notebook up through its parents (for `NoteLabel.notebookIds`). */
export function notebookChain(notebookId: string | null | undefined, parents: (id: string) => string | null | undefined): string[] {
  const out: string[] = [];
  let cur = notebookId ?? null;
  while (cur && !out.includes(cur) && out.length < 32) {
    out.push(cur);
    cur = parents(cur) ?? null;
  }
  return out;
}

// ---- Routing ------------------------------------------------------------------------------------------

/** Where a call is going and why. */
export interface RouteDecision {
  target: RouteTarget;
  /** One plain sentence for the audit trail and error messages. */
  why: string;
  /** The notes that forced the call onto the device, if any. */
  localOnlyNotes: string[];
}

/** Guesses the task kind from what a request carries, for callers that don't say. */
export function inferTask(opts: { hasImages: boolean; tools: boolean }): TaskKind {
  if (opts.hasImages) return 'vision';
  return opts.tools ? 'chat' : 'background';
}

/**
 * Where a call must run, given the policy, the task and the notes whose content the call carries.
 * Local-only notes beat everything (a task routed to a cloud provider goes to the device instead,
 * or nowhere when the task is off); otherwise the task's route applies.
 */
export function decideRoute(policy: AIPolicy, task: TaskKind, notes: Iterable<NoteLabel> = []): RouteDecision {
  const route = policy.routes[task] ?? 'auto';
  const localOnlyNotes: string[] = [];
  for (const n of notes) if (isLocalOnly(policy, n)) localOnlyNotes.push(n.id);
  if (route === 'off') return { target: 'off', why: `AI is switched off for ${TASK_LABELS[task].label.toLowerCase()} by your AI policy.`, localOnlyNotes };
  if (localOnlyNotes.length) {
    return { target: 'device', why: `${localOnlyNotes.length === 1 ? 'A note' : `${localOnlyNotes.length} notes`} in this request must stay on this device (AI policy).`, localOnlyNotes };
  }
  if (route === 'device') return { target: 'device', why: `${TASK_LABELS[task].label} runs on this device (AI policy).`, localOnlyNotes };
  if (route.startsWith('provider:')) return { target: route, why: `${TASK_LABELS[task].label} goes to the provider your AI policy names.`, localOnlyNotes };
  return { target: 'auto', why: 'Your usual AI answers.', localOnlyNotes };
}

/** Thrown when the policy stops a call. The message is shown to the user as it is. */
export class PolicyBlockedError extends Error {
  readonly code = 'policy_blocked';
  constructor(message: string, readonly reason: 'route' | 'budget' | 'privacy' | 'access' | 'tool' | 'unavailable') {
    super(message);
    this.name = 'PolicyBlockedError';
  }
}

export function isPolicyBlocked(e: unknown): e is PolicyBlockedError {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'policy_blocked';
}

/**
 * Whether an endpoint runs on this machine (Ollama, LM Studio, llama.cpp on localhost): such a
 * provider counts as "this device" for routing and is not redacted. A LAN or company server does
 * not count unless the deployment says so (the server's `--ai-on-premises`).
 */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}
