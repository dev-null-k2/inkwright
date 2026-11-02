/**
 * Approval rules for the server's own agent (routines, A2A, long-running tools) — the same rule
 * the app follows: note writes that can be undone from Activity (create, append, rename, tag,
 * file, summarize, recognize handwriting) just happen and are logged; anything destructive
 * (moving a note to Trash) waits for a person's OK.
 *
 * Who gives the OK depends on where the agent runs:
 * - an MCP client that supports Tasks: the task goes `input_required` with an elicitation form;
 * - an A2A client: the A2A task goes `INPUT_REQUIRED` and the client replies on the same task;
 * - an MCP client over stdio with 2025-style elicitation: an `elicitation/create` request;
 * - nobody (the always-on runner, or a client that can't be asked mid-call): the action is
 *   *deferred* — saved as a pending approval in the vault (`ai/approvals/<id>.json`). The user
 *   approves or denies it later from the approval card (MCP Apps), `inkstone-agent approvals`,
 *   or any MCP client via `decide_approval`; approving runs exactly the recorded call then.
 */
import { isSafeId, newId, type VaultFS } from '@inkstone/core';
import type { AgentTool } from '@inkstone/ai';

export interface ApprovalRequest {
  /** Tool the agent wants to run (a note tool, e.g. `trash_note`). */
  tool: string;
  args: Record<string, unknown>;
  /** Plain-language question: "Move “Old list” to Trash?" */
  title: string;
  detail?: string;
  /** Who asks: the routine's name or "Claude (via A2A)". */
  source: string;
  routineId?: string;
}

export type ApprovalDecision = 'approved' | 'denied' | 'deferred';

/** Asks someone (or records the question) and resolves with the decision. */
export type Approver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export const APPROVALS_DIR = 'ai/approvals';

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied' | 'failed' | 'expired';
  decidedAt?: number;
  /** Who decided: "Claude (via MCP)", "inkstone-agent approvals". */
  decidedBy?: string;
  /** What happened when it ran (or why it failed). */
  outcome?: string;
}

/** Pending approvals expire after a week: an old "trash this?" shouldn't surprise anyone. */
export const APPROVAL_MAX_AGE_MS = 7 * 86_400_000;

/** Deferred approvals stored in the vault, so they sync and any device or client can answer. */
export class ApprovalStore {
  constructor(private fs: VaultFS, private clock: () => number = Date.now) {}

  async get(id: string): Promise<PendingApproval | null> {
    if (!isSafeId(id)) return null;
    const t = await this.fs.readText(`${APPROVALS_DIR}/${id}.json`);
    if (!t) return null;
    try {
      const a = JSON.parse(t) as PendingApproval;
      if (a.id !== id || typeof a.tool !== 'string') return null;
      if (a.status === 'pending' && this.clock() - a.createdAt > APPROVAL_MAX_AGE_MS) a.status = 'expired';
      return a;
    } catch {
      return null;
    }
  }

  /** Approvals, newest first; by default only the ones still waiting. */
  async list(opts: { all?: boolean } = {}): Promise<PendingApproval[]> {
    const out: PendingApproval[] = [];
    for (const e of await this.fs.list(APPROVALS_DIR)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const a = await this.get(e.name.slice(0, -5));
      if (a && (opts.all || a.status === 'pending')) out.push(a);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async add(req: ApprovalRequest): Promise<PendingApproval> {
    const now = this.clock();
    const a: PendingApproval = { ...req, id: newId(now), createdAt: now, status: 'pending' };
    await this.save(a);
    return a;
  }

  async save(a: PendingApproval): Promise<void> {
    await this.fs.writeText(`${APPROVALS_DIR}/${a.id}.json`, JSON.stringify(a, null, 1));
  }

  /**
   * Answers a pending approval. Approving runs `execute` (the recorded call) and stores its
   * outcome; denying just records the decision. Already-decided approvals are left alone.
   */
  async decide(id: string, approve: boolean, by: string, execute: (a: PendingApproval) => Promise<string>): Promise<PendingApproval> {
    const a = await this.get(id);
    if (!a) throw new Error(`No approval with id ${id}. List them with list_pending_approvals.`);
    if (a.status !== 'pending') throw new Error(`That approval is already ${a.status}.`);
    a.decidedAt = this.clock();
    a.decidedBy = by;
    if (!approve) {
      a.status = 'denied';
      a.outcome = 'Not done.';
    } else {
      try {
        a.outcome = await execute(a);
        a.status = 'approved';
      } catch (e) {
        a.status = 'failed';
        a.outcome = (e as Error)?.message ?? String(e);
      }
    }
    await this.save(a);
    return a;
  }
}

/** Approver for unattended runs: records the question as a pending approval and moves on. */
export function deferringApprover(store: ApprovalStore, onDeferred?: (a: PendingApproval) => void): Approver {
  return async (req) => {
    onDeferred?.(await store.add(req));
    return 'deferred';
  };
}

/**
 * Wraps the agent's destructive tools so they ask `approver` first. The wrapped tools are no
 * longer marked destructive (the gate replaces runAgent's confirm step), and a deferred action
 * returns a plain explanation the model can pass on instead of an error.
 */
export function gateDestructive(tools: AgentTool[], approver: Approver, describe: (tool: AgentTool, args: Record<string, unknown>) => Promise<{ title: string; detail?: string }>, base: Pick<ApprovalRequest, 'source' | 'routineId'>): AgentTool[] {
  return tools.map((t) => {
    if (!t.destructive) return t;
    const gated: AgentTool = {
      ...t,
      destructive: false,
      async execute(args: Record<string, unknown>, ctx) {
        const d = await describe(t, args);
        const decision = await approver({ tool: t.name, args, title: d.title, detail: d.detail, ...base });
        if (decision === 'approved') return t.execute(args, ctx);
        if (decision === 'denied') throw new Error('The user declined this action. Don’t retry it.');
        return { waiting_for_approval: true, message: `${d.title} — this waits for the user’s OK. They can approve it later from Inkstone’s pending approvals. Don’t retry it; mention it in your summary.` };
      },
    };
    return gated;
  });
}

/** The elicitation form used to ask for an approval (MCP `elicitation/create`, form mode). */
export function approvalElicitation(req: ApprovalRequest): { method: 'elicitation/create'; params: Record<string, unknown> } {
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: `${req.source} wants to: ${req.title}${req.detail ? `\n${req.detail}` : ''}`,
      requestedSchema: {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Allow it', description: req.title } },
        required: ['approve'],
      },
    },
  };
}

/** Reads an elicitation answer: only an accepted form with approve=true counts as yes. */
export function approvalFromElicitResult(r: unknown): 'approved' | 'denied' {
  const x = r as { action?: string; content?: { approve?: unknown } } | undefined;
  return x?.action === 'accept' && x.content?.approve === true ? 'approved' : 'denied';
}
