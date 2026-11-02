/**
 * The runner's (and the server's) AI and connected apps through the credential executor, so the
 * `inkwright-agent` process never holds a key:
 *
 * - `agentAIViaExecutor` — the server's `AgentAI` with a provider whose requests the executor
 *   makes (`--ai-credential <name>`).
 * - `connectorToolsViaExecutor` — the read-only tools of the connected apps a routine uses, for
 *   routines that run on the computer. A routine names its apps by the app's server id; a
 *   connector credential is matched by its `server` (id or name) or its own name. Tools that
 *   change things are left out: nobody is there to approve them, and an approval saved for later
 *   can only replay note changes (approvals.ts).
 */
import { agentToolName, getProviderInfo, guessModelCapabilities, isLoopbackUrl, mcpResultParts, richResult, type AgentTool } from '@inkwright/ai';
import type { AgentAI, AgentAIConfig } from '../agent/ai.ts';
import { CredentialClient } from './client.ts';
import { defaultCredentialsDir } from './store.ts';

export interface ExecutorAI extends AgentAI {
  /** The executor connection (close it on shutdown). */
  executor: CredentialClient;
}

export async function agentAIViaExecutor(cfg: AgentAIConfig & { credential: string }, o: { dir?: string; endpoint?: string; name?: string } = {}): Promise<ExecutorAI> {
  const client = await CredentialClient.connect({ dir: o.dir ?? defaultCredentialsDir(), ...(o.endpoint ? { endpoint: o.endpoint } : {}), name: o.name ?? 'inkwright-agent', actor: { source: 'runner' } });
  const c = client.find(cfg.credential);
  if (!c) {
    client.close();
    throw new Error(`The credential executor has no credential named ${cfg.credential} (it has: ${client.credentials.map((x) => x.name).join(', ') || 'none'}).`);
  }
  if (c.kind !== 'provider' || !c.provider) {
    client.close();
    throw new Error(`${cfg.credential} is a ${c.kind} credential, not an AI provider key.`);
  }
  const info = getProviderInfo(c.provider)!;
  const model = cfg.model?.trim() || info.defaultModel;
  const vision = cfg.vision ?? (info.capabilities.vision && guessModelCapabilities(model).vision);
  return {
    provider: client.providerFor(cfg.credential),
    model,
    label: `${info.label} · ${model}`,
    vision,
    local: !!cfg.onPremises || isLoopbackUrl(c.url),
    budgetKey: info.id,
    executor: client,
  };
}

/** Agent tools for a routine's connected apps, served by the executor (read-only tools only). */
export async function connectorToolsViaExecutor(client: CredentialClient, serverRefs: readonly string[], actor: { source: string; label?: string }): Promise<{ tools: AgentTool[]; missing: string[] }> {
  const tools: AgentTool[] = [];
  const missing: string[] = [];
  const taken = new Set<string>();
  for (const ref of serverRefs) {
    const c = client.credentials.find((x) => x.kind === 'connector' && (x.server === ref || x.name === ref));
    if (!c) {
      missing.push(ref);
      continue;
    }
    let list;
    try {
      list = await client.listTools(c.name);
    } catch {
      missing.push(ref);
      continue;
    }
    for (const t of list) {
      if (t.annotations?.readOnlyHint !== true) continue;
      const name = agentToolName(c.server ?? c.name, t.name, taken);
      tools.push({
        name,
        description: `[${c.server ?? c.name}] ${t.description}`.slice(0, 1024),
        parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as never,
        readOnly: true,
        async execute(args: Record<string, unknown>) {
          const r = await client.callTool(c.name, t.name, args, { actor });
          if (r.kind !== 'result') return 'The app started a background task; its result is not available to routines running on the computer.';
          const { text, parts } = mcpResultParts(r.result as never, { images: false, maxChars: 40_000 });
          if (r.result.isError) throw new Error(text || `${t.name} failed.`);
          return parts.length ? richResult(parts) : text;
        },
      });
    }
  }
  return { tools, missing };
}
