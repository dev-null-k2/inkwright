/**
 * Runs routines in the app: wires the scheduler to the vault (note saves and finished recordings
 * become triggers; dates are found through the search index) and turns each run into an agent run
 * that is logged in AI activity. Routines run only while Inkstone is open; on open, missed runs
 * catch up once (the scheduler's rule), which the Routines screen says plainly.
 */
import {
  RoutineScheduler,
  RunRecorder,
  findDateMentions,
  routineLeaseHeldByOther,
  routineRunContext,
  runAgent,
  type DatedNote,
  type Routine,
  type TriggerEvent,
} from '@inkstone/ai';
import { pageText } from '@inkstone/core';
import { useApp } from '../../state/app.ts';
import { useSettings } from '../../state/settings.ts';
import { getProviderInfo, guessModelCapabilities } from '@inkstone/ai';
import { getActiveAI, providerFromConfig, type ActiveAI } from '../ai.ts';
import type { AppVault } from '../vault.ts';
import { prepareAgentRun, touchedByAgent } from './assistant.ts';
import { openAgentView, requestApproval, requireHub, useAgent } from './hub.ts';
import { describeMcpToolName, startConnectedApps } from './mcp.ts';
import { recordingRoutineContext, whenListenSettled } from '../listen/session.ts';

let scheduler: RoutineScheduler | null = null;
const aborts = new Map<string, AbortController>();

/** The AI a routine uses: its chosen provider, or whatever Settings › AI has active. */
export async function aiForRoutine(r: Pick<Routine, 'ai'>): Promise<ActiveAI | null> {
  if (r.ai) {
    const cfg = useSettings.getState().ai.providers.find((p) => p.id === r.ai);
    if (cfg) {
      const info = getProviderInfo(cfg.providerId);
      const caps = guessModelCapabilities(cfg.model);
      return { provider: await providerFromConfig(cfg), model: cfg.model, label: `${info?.label ?? cfg.label} · ${cfg.model}`, vision: (info?.capabilities.vision ?? true) && caps.vision, tools: info?.capabilities.tools ?? true };
    }
  }
  return getActiveAI();
}

/** One routine run: an agent run with the routine's tools, logged as a run in AI activity. */
export async function runRoutine(r: Routine, ev: TriggerEvent): Promise<{ status: 'done' | 'error' | 'cancelled'; error?: string }> {
  const hub = requireHub();
  const ai = await aiForRoutine(r).catch(() => null);
  if (!ai) {
    await new RunRecorder(hub.activity, { source: 'routine', label: r.name, routineId: r.id, prompt: ev.reason }).finish('error', { error: 'No AI is connected. Add one in Settings › AI.', alwaysLog: true });
    return { status: 'error', error: 'No AI is connected.' };
  }
  const prep = await prepareAgentRun({
    ai,
    vault: hub.vault,
    source: 'routine',
    label: r.name,
    routineId: r.id,
    prompt: ev.reason,
    notes: r.tools.notes,
    skills: r.tools.skills,
    remember: false,
    mcp: r.tools.mcpServers,
    alwaysAskForWrites: true,
    // A finished recording brings its transcript, summary and to-dos along.
    context: routineRunContext(r, ev, Date.now()) + (ev.kind === 'recording-ended' && ev.noteId ? `\n${await recordingRoutineContext(hub.vault, ev.noteId).catch(() => '')}` : ''),
  });
  const ac = new AbortController();
  aborts.set(r.id, ac);
  try {
    const res = await runAgent({
      provider: ai.provider,
      model: ai.model,
      system: prep.system,
      messages: [{ role: 'user', content: r.prompt }],
      tools: prep.tools,
      maxSteps: 16,
      signal: ac.signal,
      stream: false,
      confirm: (call) => {
        const mcp = describeMcpToolName(call.name);
        const what = mcp ? `use “${mcp.tool}” in ${mcp.server}` : call.name === 'trash_note' ? 'move a note to Trash' : call.name;
        useApp.getState().toast({ text: `“${r.name}” is waiting for your OK`, action: { label: 'Review', run: () => openAgentView('activity') } });
        return requestApproval({ source: r.name, title: `Allow “${r.name}” to ${what}?`, detail: JSON.stringify(call.arguments, null, 1).slice(0, 600) });
      },
    });
    await prep.recorder.finish('done', { reply: res.text, alwaysLog: true });
    if (prep.recorder.run.ops.length) {
      useApp.getState().toast({ text: `${r.name}: ${prep.recorder.run.ops.length} ${prep.recorder.run.ops.length === 1 ? 'change' : 'changes'}`, action: { label: 'Review', run: () => openAgentView('activity') } });
    }
    return { status: 'done' };
  } catch (e) {
    const cancelled = ac.signal.aborted;
    await prep.recorder.finish(cancelled ? 'cancelled' : 'error', { error: cancelled ? undefined : (e as Error).message, alwaysLog: true });
    return cancelled ? { status: 'cancelled' } : { status: 'error', error: (e as Error).message };
  } finally {
    aborts.delete(r.id);
  }
}

export function cancelRoutine(id: string) {
  aborts.get(id)?.abort();
}

export function runRoutineNow(id: string): Promise<void> {
  if (!scheduler) throw new Error('Routines start once your notes are open.');
  return scheduler.runNow(id);
}

/** Notes mentioning `keyword`, with the dates written next to it. */
async function findDatedNotes(vault: AppVault, keyword: string): Promise<DatedNote[]> {
  const now = Date.now();
  const dayFirst = !/^en-(US|PH|CA)$/i.test(navigator.language || 'en-US') && !/^(en)$/i.test(navigator.language || '');
  const out: DatedNote[] = [];
  for (const h of vault.search.search(keyword, { limit: 40 })) {
    const n = await vault.vault.readNote(h.noteId);
    if (!n || n.trashedAt != null) continue;
    const text = [n.title, ...(await vault.vault.readPages(n)).map((p) => pageText(p))].join('\n');
    const mentions = findDateMentions(text, keyword, now, { dayFirst });
    if (mentions.length) out.push({ noteId: n.id, title: n.title, mentions });
  }
  return out;
}

let starting: Promise<void> | null = null;

/**
 * Starts routines and connected apps once the vault is open (once per app run). Note saves by the
 * user (not by an agent) and new recordings are watched through vault change events. Missed runs
 * catch up a moment after opening, once the library is on screen.
 */
export function startAgents(vault: AppVault): Promise<void> {
  starting ??= start(vault);
  return starting;
}

/**
 * Stops automatic routine runs (Settings › Modules turned the assistant off). A routine that is
 * running finishes; nothing new starts until `startAgents` runs again.
 */
export function stopAgents(): void {
  scheduler?.stop();
  scheduler = null;
  starting = null;
  useAgent.setState({ runningRoutine: null, queuedRoutines: [] });
}

async function start(vault: AppVault): Promise<void> {
  const hub = requireHub();
  const recordings = new Map<string, number>();
  for (const n of await vault.listNotes(true)) recordings.set(n.id, n.recordings?.length ?? 0);
  scheduler = new RoutineScheduler({
    store: hub.routines,
    run: runRoutine,
    findDatedNotes: (kw) => findDatedNotes(vault, kw),
    onError: (e) => console.warn('routine check failed', e),
    // An always-on runner (`inkstone-agent run`) holding the routines lease runs the automatic
    // triggers; the app then only runs routines when you press Run.
    deferAutomatic: async () => {
      const lease = await routineLeaseHeldByOther(vault.fs, Date.now());
      useAgent.setState({ routinesRunner: lease ? lease.label : null });
      return !!lease;
    },
  });
  scheduler.onStatus = () => useAgent.setState({ runningRoutine: scheduler!.runningId, queuedRoutines: scheduler!.queued });
  vault.vault.onChange((c) => {
    if (c.type !== 'note' || !scheduler) return;
    void vault.vault.readNote(c.noteId).then((n) => {
      if (!n || n.trashedAt != null || !scheduler) return;
      const count = n.recordings?.length ?? 0;
      const before = recordings.get(n.id) ?? 0;
      recordings.set(n.id, count);
      // Wait for the transcript and summaries so the routine can use them.
      if (count > before) void whenListenSettled(n.id).then(() => scheduler?.recordingEnded({ id: n.id, title: n.title }));
      if (!touchedByAgent(n.id)) scheduler.noteSaved({ id: n.id, title: n.title, tags: n.tags });
    });
  });
  void startConnectedApps().catch((e) => console.warn('connected apps failed to start', e));
  await new Promise((r) => setTimeout(r, 2500));
  await scheduler?.start();
}
