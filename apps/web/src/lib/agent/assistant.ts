/**
 * Everything an agent run needs, assembled the same way for the assistant panel and for
 * background routines: note tools (recorded in the activity log, so every change can be undone),
 * Agent Skills (progressive disclosure), memory (in the prompt; `remember` only proposes), and
 * the tools of connected apps (MCP) with their ask-before-running rules.
 */
import {
  READ_ONLY_NOTE_TOOLS,
  RecordingNoteToolHost,
  RunRecorder,
  createNoteTools,
  createMemoryTools,
  createRememberTool,
  createSkillTools,
  memoryPromptSection,
  notesAgentSystemPrompt,
  skillsPromptSection,
  type ActivitySource,
  type AgentTool,
  type NoteContent,
  type NoteInfo,
  type NoteListItem,
  type NotePatch,
  type NoteSearchHit,
  type NoteToolHost,
  type NotebookInfo,
} from '@inkstone/ai';
import type { NoteDocument } from '@inkstone/core';
import { AppNoteToolHost, type ActiveAI } from '../ai.ts';
import { activeSession } from '../session.ts';
import type { AppVault } from '../vault.ts';
import { requireHub } from './hub.ts';
import { appMemory } from '../memory.ts';
import { mcpAgentTools, useMcp } from './mcp.ts';

/** Notes an agent changed recently: their saves are not "the user saved a note" (routine triggers). */
const agentTouched = new Map<string, number>();

export function touchedByAgent(noteId: string, withinMs = 30_000): boolean {
  const t = agentTouched.get(noteId);
  return t != null && Date.now() - t < withinMs;
}

/**
 * Resolves the open note at each call, so an agent that runs while the user switches notes still
 * edits the open one through its document (live, undoable) and never races its autosave.
 */
class LiveNoteToolHost implements NoteToolHost {
  getPageImage: NoteToolHost['getPageImage'];
  constructor(private vault: AppVault, private pinned: NoteDocument | null) {
    this.getPageImage = (n, p) => this.host().getPageImage(n, p);
  }
  private host() {
    const open = activeSession()?.doc ?? null;
    return new AppNoteToolHost(this.vault, this.pinned && open === this.pinned ? this.pinned : open);
  }
  private touch(id: string) { agentTouched.set(id, Date.now()); }
  listNotes(o?: Parameters<NoteToolHost['listNotes']>[0]): Promise<NoteListItem[]> { return this.host().listNotes(o); }
  searchNotes(q: string, o?: { limit?: number }): Promise<NoteSearchHit[]> { return this.host().searchNotes(q, o); }
  readNote(id: string): Promise<NoteContent | null> { return this.host().readNote(id); }
  listNotebooks(): Promise<NotebookInfo[]> { return this.host().listNotebooks(); }
  async createNote(a: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo> { const n = await this.host().createNote(a); this.touch(n.id); return n; }
  async appendText(id: string, text: string, pageIndex?: number) { this.touch(id); const r = await this.host().appendText(id, text, pageIndex); this.touch(id); return r; }
  async updateNote(id: string, p: NotePatch) { this.touch(id); const r = await this.host().updateNote(id, p); this.touch(id); return r; }
  createNotebook(name: string, o?: { parentId?: string }) { return this.host().createNotebook(name, o); }
  async trashNote(id: string) { this.touch(id); return this.host().trashNote(id); }
}

export interface PrepareOptions {
  ai: ActiveAI;
  vault: AppVault;
  source: ActivitySource;
  label: string;
  prompt: string;
  routineId?: string;
  /** The note open in the panel (its document is used for edits to it). */
  openDoc?: NoteDocument | null;
  notes: 'read' | 'write';
  skills: boolean;
  /** Offer the `remember` tool (interactive chats only). */
  remember: boolean;
  /** Connected apps to offer: all enabled ones, or these server ids. */
  mcp: 'all' | readonly string[];
  /** Background runs ask before every connected-app tool that may change things. */
  alwaysAskForWrites?: boolean;
  /** Extra system-prompt context (the open note, or why a routine runs). */
  context?: string;
}

export interface PreparedRun {
  tools: AgentTool[];
  system: string;
  recorder: RunRecorder;
}

export async function prepareAgentRun(o: PrepareOptions): Promise<PreparedRun> {
  const hub = requireHub();
  const recorder = new RunRecorder(hub.activity, { source: o.source, label: o.label, prompt: o.prompt, ...(o.routineId ? { routineId: o.routineId } : {}) });
  const host = new RecordingNoteToolHost(new LiveNoteToolHost(o.vault, o.openDoc ?? null), recorder.record);
  const vision = o.ai.vision;
  const noteTools = createNoteTools(host, o.notes === 'read' ? { include: READ_ONLY_NOTE_TOOLS.filter((t) => vision || t !== 'get_page_image') } : vision ? {} : { exclude: ['get_page_image'] });
  const tools: AgentTool[] = [...noteTools];
  const sections: string[] = [];
  // Semantic memory over everything written (search_memory), cited to exact places.
  const searchMemory = appMemory();
  if (searchMemory) tools.push(...createMemoryTools(searchMemory));

  const memory = await hub.memory.load().catch(() => []);
  const mem = memoryPromptSection(memory);
  if (mem) sections.push(mem);

  if (o.skills) {
    const enabled = await hub.skills.enabled().catch(() => []);
    if (enabled.length) {
      tools.push(...createSkillTools(hub.skills));
      sections.push(skillsPromptSection(enabled));
    }
  }

  if (o.remember) {
    tools.push(createRememberTool(hub.memory));
    sections.push('When the user tells you a lasting preference or fact about themselves, you may call remember to propose saving it; they approve it in the app.');
  }

  const servers = useMcp.getState().servers.filter((s) => s.enabled && (o.mcp === 'all' || o.mcp.includes(s.id)));
  if (servers.length) {
    const mcpTools = await mcpAgentTools({
      serverIds: servers.map((s) => s.id),
      vision,
      alwaysAskForWrites: o.alwaysAskForWrites,
      onExternalChange: (x) => recorder.record({ kind: 'external', tool: x.tool, server: x.serverName, summary: x.summary, detail: JSON.stringify(x.args).slice(0, 300) }),
    }).catch((e) => { console.warn('connected apps unavailable', e); return [] as AgentTool[]; });
    if (mcpTools.length) {
      tools.push(...mcpTools);
      const names = [...new Set(servers.map((s) => s.name))];
      sections.push(`Connected apps: ${names.join(', ')}. Their tools are named "<app>__<tool>". Use them only for what the user asked; the user is asked to approve actions that change things in those apps.`);
    }
  }
  // Tools contributed by modules that are on (plugins with the ai:tools permission).
  const { collectModuleAiTools } = await import('../../modules/registry.ts');
  const moduleTools = await collectModuleAiTools();
  if (moduleTools.length) {
    tools.push(...moduleTools);
    sections.push('Tools named "<plugin>__<tool>" come from plugins the user installed; use them when they fit what the user asked.');
  }
  if (o.context) sections.push(o.context);
  return { tools, system: notesAgentSystemPrompt({ appName: 'Inkstone', extra: sections.join('\n\n') }), recorder };
}
