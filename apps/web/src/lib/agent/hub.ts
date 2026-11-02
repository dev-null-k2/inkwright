/**
 * The assistant's state outside any one screen: activity log, memory, skills, routines, pending
 * approvals and questions from connected apps. Everything persistent lives in the vault (see
 * docs/VAULT_FORMAT.md, `ai/…`) so it syncs; this module keeps reactive snapshots for the UI and
 * owns the routine scheduler, which runs while the app is open.
 */
import { create } from 'zustand';
import {
  ActivityStore,
  MemoryStore,
  RoutineStore,
  SkillStore,
  builtinSkills,
  type ActivityRun,
  type MemoryItem,
  type Routine,
  type SkillInfo,
} from '@inkstone/ai';
import { newId } from '@inkstone/core';
import type { AppVault } from '../vault.ts';

export interface Approval {
  id: string;
  /** "Assistant" or the routine's name. */
  source: string;
  title: string;
  detail: string;
  at: number;
  resolve: (ok: boolean) => void;
}

/** A connected app asking the user for input (MCP elicitation, or a task's input request). */
export interface Elicitation {
  id: string;
  server: string;
  message: string;
  schema?: { properties?: Record<string, any>; required?: string[] };
  resolve: (r: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) => void;
}

interface AgentState {
  ready: boolean;
  runs: ActivityRun[];
  memory: MemoryItem[];
  skills: SkillInfo[];
  routines: Routine[];
  /** Routine currently running, and its abort controller. */
  runningRoutine: string | null;
  queuedRoutines: string[];
  approvals: Approval[];
  elicitations: Elicitation[];
}

export const useAgent = create<AgentState>(() => ({
  ready: false,
  runs: [],
  memory: [],
  skills: [],
  routines: [],
  runningRoutine: null,
  queuedRoutines: [],
  approvals: [],
  elicitations: [],
}));

export interface AgentHub {
  vault: AppVault;
  activity: ActivityStore;
  memory: MemoryStore;
  skills: SkillStore;
  routines: RoutineStore;
}

let hub: AgentHub | null = null;

/** The hub, once the vault is open (null before). */
export function agentHub(): AgentHub | null {
  return hub;
}

export function requireHub(): AgentHub {
  if (!hub) throw new Error('Your notes are still opening.');
  return hub;
}

async function refreshRuns() { if (hub) useAgent.setState({ runs: await hub.activity.list() }); }
async function refreshMemory() { if (hub) useAgent.setState({ memory: await hub.memory.load() }); }
async function refreshSkills() { if (hub) useAgent.setState({ skills: await hub.skills.list() }); }
async function refreshRoutines() { if (hub) useAgent.setState({ routines: await hub.routines.list() }); }

/** Re-reads everything (after sync pulled changes from another device). */
export async function refreshAgentState(): Promise<void> {
  await Promise.all([refreshRuns(), refreshMemory(), refreshSkills(), refreshRoutines()]).catch((e) => console.warn('agent state refresh failed', e));
}

/**
 * Creates the stores over the vault and loads their state. Called once the vault is open;
 * the scheduler and connected apps are started separately (`startAgents`).
 */
export async function initAgentHub(vault: AppVault): Promise<AgentHub> {
  if (hub?.vault === vault) return hub;
  const fs = vault.fs;
  hub = { vault, activity: new ActivityStore(fs), memory: new MemoryStore(fs), skills: new SkillStore(fs, builtinSkills()), routines: new RoutineStore(fs) };
  hub.activity.onChange(() => void refreshRuns());
  hub.memory.onChange(() => void refreshMemory());
  hub.skills.onChange(() => void refreshSkills());
  hub.routines.onChange(() => void refreshRoutines());
  vault.vault.onChange((c) => { if (c.type === 'reloaded') void refreshAgentState(); });
  await refreshAgentState();
  useAgent.setState({ ready: true });
  void hub.activity.prune().catch(() => {});
  return hub;
}

// ---- Approvals ---------------------------------------------------------------------------------

/**
 * Queues an approval for a background run (routines) and waits for the user. The request stays
 * until answered; closing the app declines it (the run is abandoned with the app).
 */
export function requestApproval(a: Omit<Approval, 'id' | 'at' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    const id = newId();
    const item: Approval = { ...a, id, at: Date.now(), resolve: (ok) => { useAgent.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== id) })); resolve(ok); } };
    useAgent.setState((s) => ({ approvals: [...s.approvals, item] }));
  });
}

// ---- Opening an assistant screen from anywhere ---------------------------------------------------

const VIEW_EVENT = 'inkstone:open-agent-view';
let viewHosts = 0;
let pendingView: string | null = null;

/**
 * Shows an assistant screen (e.g. Activity from a routine's toast): in the AI panel or Settings
 * if one is open, otherwise by opening Settings › AI, which picks the request up when it mounts.
 */
export function openAgentView(view: string): void {
  if (viewHosts > 0) {
    window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: view }));
    return;
  }
  pendingView = view;
  void import('../../state/app.ts').then(({ useApp }) => useApp.getState().navigate({ name: 'settings', section: 'ai' }));
}

/** Registers a screen that can show assistant views; `show` is called with requested views. */
export function hostAgentViews(show: (view: string) => void): () => void {
  viewHosts++;
  const on = (e: Event) => show((e as CustomEvent<string>).detail);
  window.addEventListener(VIEW_EVENT, on);
  if (pendingView) {
    const v = pendingView;
    pendingView = null;
    queueMicrotask(() => show(v));
  }
  return () => {
    viewHosts--;
    window.removeEventListener(VIEW_EVENT, on);
  };
}

const PROMPT_EVENT = 'inkstone:assistant-prompt';
let promptHosts = 0;

/** Puts text into the assistant's input. Returns false when no assistant panel is open. */
export function sendToAssistantInput(text: string): boolean {
  if (!promptHosts) return false;
  window.dispatchEvent(new CustomEvent(PROMPT_EVENT, { detail: text }));
  return true;
}

export function hostPromptInput(set: (text: string) => void): () => void {
  promptHosts++;
  const on = (e: Event) => set((e as CustomEvent<string>).detail);
  window.addEventListener(PROMPT_EVENT, on);
  return () => {
    promptHosts--;
    window.removeEventListener(PROMPT_EVENT, on);
  };
}

/** Queues a question from a connected app and waits for the answer. */
export function requestElicitation(e: Omit<Elicitation, 'id' | 'resolve'>): Promise<Parameters<Elicitation['resolve']>[0]> {
  return new Promise((resolve) => {
    const id = newId();
    const item: Elicitation = { ...e, id, resolve: (r) => { useAgent.setState((s) => ({ elicitations: s.elicitations.filter((x) => x.id !== id) })); resolve(r); } };
    useAgent.setState((s) => ({ elicitations: [...s.elicitations, item] }));
  });
}
