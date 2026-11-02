/**
 * The app's AI gateway: `getActiveAI()` (lib/ai.ts) hands every caller an AI whose provider is
 * a guarded provider (`createGuardedProvider` in @inkwright/ai). So the assistant panel, routines,
 * Ask, smart ink, handwriting conversion and notes that listen all go through one choke point
 * that routes by the AI policy, redacts before cloud calls, shortens large context, meters cost
 * and writes the audit trail.
 *
 * This module only knows how to turn the policy's route targets into the app's concrete AIs:
 * `auto` is what Settings › AI › "Who answers" picks today; `device` is an on-device model
 * (Android's native engine, Chrome's built-in AI, the downloaded model) or a provider running on
 * localhost; `provider:<id>` is one configured provider.
 */
import {
  MemoryContentStore,
  TASK_LABELS,
  TrustRun,
  createGuardedProvider,
  decideRoute,
  type Route,
  type RouteTarget,
  type TrustServices,
} from '@inkwright/ai';
import { useSettings } from '../../state/settings.ts';
import { CLAUDE_BUILTIN_ID, activeFromConfig, builtinActiveAI, type AICallOptions, type ActiveAI } from '../ai.ts';
import { readyDeviceAI } from '../localai.ts';
import { currentPolicy, labelForMeta, trustServices } from './state.ts';

/** Before the vault opens (and in tests without one): defaults, nothing persisted. */
let fallback: TrustServices | null = null;
function services(): TrustServices {
  const s = trustServices();
  if (s) return s;
  fallback ??= { policy: currentPolicy, originals: new MemoryContentStore() };
  return fallback;
}

const toRoute = (a: ActiveAI): Route => ({ provider: a.provider, model: a.model, label: a.label, local: !!a.local, budgetKey: a.budgetKey ?? (a.local ? 'device' : a.provider.id), vision: a.vision });

/** An AI that runs on this device, if there is one. */
export async function deviceAI(): Promise<ActiveAI | null> {
  const a = await readyDeviceAI().catch(() => null);
  if (a) return { ...a, local: true, budgetKey: 'device' };
  for (const cfg of useSettings.getState().ai.providers) {
    if (cfg.id === CLAUDE_BUILTIN_ID) continue;
    const a = await activeFromConfig(cfg).catch(() => null);
    if (a?.local) return a;
  }
  return null;
}

async function resolveTarget(target: RouteTarget, base: ActiveAI | null): Promise<ActiveAI | null> {
  if (target === 'off') return null;
  if (target === 'auto') return base;
  if (target === 'device') return base?.local ? base : deviceAI();
  const id = target.slice('provider:'.length);
  if (id === CLAUDE_BUILTIN_ID) return builtinActiveAI();
  const cfg = useSettings.getState().ai.providers.find((p) => p.id === id);
  return cfg ? activeFromConfig(cfg) : null;
}

/**
 * Wraps the user's AI in the guarded provider for one caller. Returns null only when there is no
 * AI at all (so callers keep showing their "add an AI" setup); when the policy forbids or can't
 * serve the call, the returned AI's `chat` throws a `PolicyBlockedError` that explains why.
 */
export async function guardActiveAI(base: ActiveAI | null, opts: AICallOptions = {}): Promise<ActiveAI | null> {
  const policy = currentPolicy();
  const run = new TrustRun((opts.notes ?? []).map(labelForMeta));
  const first = decideRoute(policy, opts.task ?? 'chat', run.notes.values());
  const initial = await resolveTarget(first.target, base).catch(() => null);
  if (!initial && !base && first.target === 'auto') return null;
  const provider = createGuardedProvider({
    services: services(),
    ...(opts.task ? { task: opts.task } : {}),
    actor: { source: opts.source ?? 'app', ...(opts.label ? { label: opts.label } : {}) },
    run,
    resolve: async (target) => {
      const a = await resolveTarget(target, base);
      return a ? toRoute(a) : null;
    },
  });
  const blocked = first.target === 'off' ? 'Off for this kind of work (AI policy)' : `Not available here (${TASK_LABELS[opts.task ?? 'chat'].label.toLowerCase()} must run on this device)`;
  return {
    provider,
    model: initial?.model ?? base?.model ?? 'default',
    label: initial?.label ?? blocked,
    vision: initial?.vision ?? false,
    tools: initial?.tools ?? base?.tools ?? true,
    local: initial?.local ?? false,
    budgetKey: initial?.budgetKey ?? 'device',
    trust: run,
  };
}
