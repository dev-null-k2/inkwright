/**
 * The plugin host: loads installed plugins from the vault, starts each one's sandbox when it is
 * first needed (or at startup when its manifest asks), exposes their contributions to the app
 * (palette, ••• › Plugins, side panels, assistant tools, importers, exporters), forwards events,
 * and installs, updates, enables, revokes and uninstalls.
 *
 * State the UI renders lives in the `usePlugins` store; the sandboxes themselves are in
 * `frames`. A plugin that is switched off, uninstalled, or loses a permission is stopped at once.
 */
import { createElement } from 'react';
import { create } from 'zustand';
import { Puzzle } from 'lucide-react';
import { pageText, type InstalledPlugin, type NoteMeta, type NotebookMeta } from '@inkwright/core';
import { RecordingNoteToolHost, RunRecorder, type AgentTool } from '@inkwright/ai';
import { addedPermissions, compareVersions, validateManifest, type ExportOutput, type ImportedNote, type Permission, type PluginManifest } from '@inkwright/plugin-api';
import { useApp } from '../state/app.ts';
import { APP_VERSION, isNative, nativePlatform } from '../platform/env.ts';
import { registerPaletteActions } from '../lib/palette.ts';
import { AppNoteToolHost } from '../lib/ai.ts';
import { agentHub } from '../lib/agent/hub.ts';
import { dispatch, type BackendNote, type Caller, type HostEnv, type NotesBackend } from './dispatcher.ts';
import { editorState, insertTextInEditor, onNoteOpened, onSelectionChanged, openDocument, selectionText } from './editorBridge.ts';
import { PluginFrame } from './sandbox.ts';
import { PluginStore, type PluginData, type PluginPackage } from './store.ts';
import { packageFromUrl, updateSourceOf } from './install.ts';
import { NEEDS_REVIEW, consentCovers, consentFor, forgetConsent, pluginFingerprint, recordConsent } from './consent.ts';
import { CATALOG } from './catalog.ts';

export interface LoadedPlugin {
  record: InstalledPlugin;
  manifest: PluginManifest | null;
  /** Why it can't run (missing files, invalid manifest, needs a newer app, needs a review). */
  error: string | null;
  /** Waits for the person on this device to approve its code and permissions (consent.ts). */
  needsReview?: boolean;
  /** Fingerprint of its manifest and entry script, as loaded (what a review approves). */
  fingerprint?: string;
}

export interface PluginLogLine {
  pluginId: string;
  level: string;
  message: string;
  at: number;
}

interface PluginsState {
  plugins: LoadedPlugin[];
  running: string[];
  log: PluginLogLine[];
  /** The plugin panel open in the editor, if any. */
  openPanel: { pluginId: string; panelId: string } | null;
}

export const usePlugins = create<PluginsState>(() => ({ plugins: [], running: [], log: [], openPanel: null }));

type VersionedFrame = PluginFrame & { version: string };
const frames = new Map<string, VersionedFrame>();
const panelFrames = new Set<{ pluginId: string; frame: PluginFrame }>();
/** Who hears which events: plugins that subscribed, and the automation API. */
export interface EventSink {
  events: Set<string>;
  /** Checked per event, so a revoked permission or a note outside the scope is respected. */
  allowed(note?: BackendNote): boolean;
  deliver(name: string, data: unknown): void;
}
const sinks = new Map<string, EventSink>();

export function setEventSink(id: string, sink: EventSink | null): void {
  if (sink) sinks.set(id, sink);
  else sinks.delete(id);
}
const dataCache = new Map<string, PluginData>();
let started = false;

const store = (): PluginStore => {
  const v = useApp.getState().vault;
  if (!v) throw new Error('The vault is not open yet.');
  return new PluginStore(v.fs);
};

const log = (pluginId: string, level: string, message: string) =>
  usePlugins.setState((s) => ({ log: [...s.log.slice(-199), { pluginId, level, message, at: Date.now() }] }));

/** Permissions a plugin holds now: what it asked for and the user has not revoked. */
export function grantedPermissions(p: LoadedPlugin): Set<Permission> {
  return new Set((p.manifest?.permissions ?? []).filter((x) => p.record.granted.includes(x)));
}

export const findPlugin = (id: string) => usePlugins.getState().plugins.find((p) => p.record.id === id);
export const isRunnable = (p: LoadedPlugin | undefined): p is LoadedPlugin & { manifest: PluginManifest } => !!p && !!p.manifest && !p.error && p.record.enabled;

// ---- Loading -------------------------------------------------------------------------------------

/** Reads plugins.json and every manifest (after a sync or a change from Settings). */
export async function reloadPlugins(): Promise<void> {
  const s = store();
  const cfg = await s.config();
  const out: LoadedPlugin[] = [];
  for (const record of cfg.plugins) {
    const m = await s.manifest(record.id);
    if ('error' in m) out.push({ record, manifest: null, error: m.error });
    else if (compareVersions(APP_VERSION, m.manifest.minAppVersion) < 0) out.push({ record, manifest: m.manifest, error: `Needs Inkwright ${m.manifest.minAppVersion} or later.` });
    else {
      // Only code and permissions approved on this device run (consent.ts, security review SR-01).
      const fingerprint = await pluginFingerprint((await s.readText(record.id, 'manifest.json')) ?? '', (await s.code(record.id, m.manifest.entry)) ?? '');
      const ok = consentCovers(consentFor(record.id), fingerprint, record.granted);
      out.push({ record, manifest: m.manifest, error: ok ? null : NEEDS_REVIEW, fingerprint, ...(ok ? {} : { needsReview: true }) });
    }
  }
  usePlugins.setState({ plugins: out });
  // Stop what may no longer run, or was updated (it restarts on next use).
  for (const [id, frame] of frames) {
    const p = out.find((x) => x.record.id === id);
    if (!isRunnable(p) || p.manifest.version !== frame.version) stopPlugin(id);
  }
  for (const p of out) if (isRunnable(p) && p.manifest.activation === 'startup') void ensureRunning(p.record.id).catch(() => {});
}

// ---- Running -------------------------------------------------------------------------------------

function callerFor(id: string, extra: { setHeight?: (px: number) => void } = {}): Caller {
  const live = () => findPlugin(id);
  const label = `${live()?.manifest?.name ?? id} (plugin)`;
  const data = async (): Promise<PluginData> => {
    let d = dataCache.get(id);
    if (!d) dataCache.set(id, (d = await store().data(id)));
    return d;
  };
  const save = async (d: PluginData) => {
    dataCache.set(id, d);
    await store().saveData(id, d);
  };
  return {
    id,
    label,
    permissions: () => {
      const p = live();
      return isRunnable(p) ? grantedPermissions(p) : new Set();
    },
    noteScope: live()?.manifest?.noteScope,
    networkHosts: live()?.manifest?.network?.hosts,
    storage: {
      get: async (k) => (await data()).storage[k],
      set: async (k, v) => { const d = await data(); await save({ ...d, storage: { ...d.storage, [k]: v } }); },
      delete: async (k) => { const d = await data(); const { [k]: _gone, ...rest } = d.storage; await save({ ...d, storage: rest }); },
      keys: async () => Object.keys((await data()).storage),
    },
    settings: async () => {
      const defaults = Object.fromEntries((live()?.manifest?.contributes.settings ?? []).filter((s) => s.default !== undefined).map((s) => [s.key, s.default!]));
      return { ...defaults, ...(await data()).settings };
    },
    subscribe: (event) => {
      let sink = sinks.get(id);
      if (!sink) {
        sink = {
          events: new Set(),
          allowed: (note) => {
            const p = live();
            if (!isRunnable(p) || !grantedPermissions(p).has('events')) return false;
            // An event about no particular note is fine; one about a note nobody could look up
            // is not delivered to a scoped plugin (it can't be shown to be inside the scope).
            if (!note) return !p.manifest.noteScope;
            return !note.locked && (!p.manifest.noteScope || scopeAllows(p, note));
          },
          deliver: (name, data) => {
            frames.get(id)?.event(name, data);
            for (const pf of panelFrames) if (pf.pluginId === id) pf.frame.event(name, data);
          },
        };
        sinks.set(id, sink);
      }
      sink.events.add(event);
    },
    // Main frame ↔ panel frames of the same plugin.
    postMessage: (msg) => {
      frames.get(id)?.event('message', msg);
      for (const pf of panelFrames) if (pf.pluginId === id) pf.frame.event('message', msg);
    },
    ...(extra.setHeight ? { setHeight: extra.setHeight } : {}),
  };
}

/** Starts the plugin's main sandbox if it is not running (lazy activation). */
export async function ensureRunning(id: string): Promise<PluginFrame> {
  const existing = frames.get(id);
  if (existing) {
    await existing.ready;
    return existing;
  }
  const p = findPlugin(id);
  if (!isRunnable(p)) throw new Error(p?.error ?? 'This plugin is switched off.');
  const code = await store().code(id, p.manifest.entry);
  if (code == null) throw new Error('Its code is missing (still syncing?).');
  const caller = callerFor(id);
  const frame = new PluginFrame({
    manifest: p.manifest,
    code,
    role: 'main',
    onCall: (method, params) => dispatch(hostEnv(), caller, method, params),
    onLog: (level, message) => log(id, level, message),
  }) as VersionedFrame;
  frame.version = p.manifest.version;
  frames.set(id, frame);
  usePlugins.setState((s) => ({ running: [...new Set([...s.running, id])] }));
  try {
    await frame.ready;
  } catch (e) {
    stopPlugin(id);
    throw e;
  }
  return frame;
}

export function stopPlugin(id: string): void {
  frames.get(id)?.destroy();
  frames.delete(id);
  sinks.delete(id);
  for (const pf of [...panelFrames]) if (pf.pluginId === id) { pf.frame.destroy(); panelFrames.delete(pf); }
  usePlugins.setState((s) => ({ running: s.running.filter((x) => x !== id), openPanel: s.openPanel?.pluginId === id ? null : s.openPanel }));
}

/** A panel frame inside `container` (the editor's side panel). */
export async function mountPanel(pluginId: string, panelId: string, container: HTMLElement, onHeight: (px: number) => void): Promise<() => void> {
  const p = findPlugin(pluginId);
  if (!isRunnable(p)) throw new Error(p?.error ?? 'This plugin is switched off.');
  const code = await store().code(pluginId, p.manifest.entry);
  if (code == null) throw new Error('Its code is missing.');
  // Panels talk to the main code through messages, so make sure it runs too.
  void ensureRunning(pluginId).catch((e) => log(pluginId, 'error', (e as Error).message));
  const caller = callerFor(pluginId, { setHeight: onHeight });
  const frame = new PluginFrame({ manifest: p.manifest, code, role: 'panel', panelId, container, onCall: (m, params) => dispatch(hostEnv(), caller, m, params), onLog: (level, message) => log(pluginId, level, message) });
  const entry = { pluginId, frame };
  panelFrames.add(entry);
  return () => { frame.destroy(); panelFrames.delete(entry); };
}

export async function runCommand(pluginId: string, commandId: string): Promise<void> {
  try {
    const frame = await ensureRunning(pluginId);
    await frame.invoke('command', commandId, null);
  } catch (e) {
    useApp.getState().toast({ text: `${findPlugin(pluginId)?.manifest?.name ?? 'The plugin'}: ${(e as Error).message}`, tone: 'error' });
  }
}

export function openPluginPanel(pluginId: string, panelId: string): void {
  usePlugins.setState({ openPanel: { pluginId, panelId } });
}

export function closePluginPanel(): void {
  usePlugins.setState({ openPanel: null });
}

/** Commands of running-capable plugins, for menus and the palette. */
export function pluginCommands(context?: 'app' | 'editor'): { pluginId: string; pluginName: string; id: string; title: string; keywords?: string; context: 'app' | 'editor' }[] {
  const out = [];
  for (const p of usePlugins.getState().plugins) {
    if (!isRunnable(p)) continue;
    for (const c of p.manifest.contributes.commands ?? []) {
      const ctx = c.context ?? 'app';
      if (context && ctx !== context && !(context === 'editor' && ctx === 'app')) continue;
      out.push({ pluginId: p.record.id, pluginName: p.manifest.name, id: c.id, title: c.title, ...(c.keywords ? { keywords: c.keywords } : {}), context: ctx });
    }
  }
  return out;
}

export function pluginPanels(): { pluginId: string; pluginName: string; id: string; title: string }[] {
  return usePlugins.getState().plugins.filter(isRunnable).flatMap((p) => (p.manifest.contributes.panels ?? []).map((x) => ({ pluginId: p.record.id, pluginName: p.manifest.name, id: x.id, title: x.title })));
}

export function pluginExporters() {
  return usePlugins.getState().plugins.filter(isRunnable).flatMap((p) => (p.manifest.contributes.exporters ?? []).map((x) => ({ pluginId: p.record.id, pluginName: p.manifest.name, ...x })));
}

export function pluginImporters() {
  return usePlugins.getState().plugins.filter(isRunnable).flatMap((p) => (p.manifest.contributes.importers ?? []).map((x) => ({ pluginId: p.record.id, pluginName: p.manifest.name, ...x })));
}

/** Runs an exporter on a note (the user picked it, so the note is handed over for this call). */
export async function runExporter(pluginId: string, exporterId: string, noteId: string): Promise<ExportOutput & { mimeType: string; extension: string }> {
  const p = findPlugin(pluginId);
  const ex = p?.manifest?.contributes.exporters?.find((x) => x.id === exporterId);
  if (!ex) throw new Error('That exporter is not available.');
  const note = await appNotesBackend().get(noteId);
  if (!note || note.locked) throw new Error('This note cannot be exported by a plugin.');
  const { notebookPath: _p, locked: _l, ...content } = note;
  const out = (await (await ensureRunning(pluginId)).invoke('exporter', exporterId, { note: content })) as ExportOutput;
  if (!out || typeof out.text !== 'string') throw new Error('The exporter returned nothing.');
  return { ...out, mimeType: ex.mimeType, extension: ex.extension };
}

/** Runs an importer on a file and creates the notes it returns (undoable in Activity). */
export async function runImporter(pluginId: string, importerId: string, file: { name: string; text: string }): Promise<string[]> {
  const p = findPlugin(pluginId);
  if (!p?.manifest?.contributes.importers?.some((x) => x.id === importerId)) throw new Error('That importer is not available.');
  const res = (await (await ensureRunning(pluginId)).invoke('importer', importerId, file, 120_000)) as ImportedNote | ImportedNote[];
  const list = (Array.isArray(res) ? res : [res]).filter((n) => n && typeof n.title === 'string').slice(0, 500);
  const ids: string[] = [];
  for (const n of list) ids.push(await appNotesBackend().create({ title: n.title.slice(0, 300) || file.name, text: String(n.text ?? '').slice(0, 200_000), tags: Array.isArray(n.tags) ? n.tags.map(String).slice(0, 50) : [] }, `${p.manifest.name} (plugin)`));
  return ids;
}

/** Assistant tools from plugins with `ai:tools` (named `<plugin>__<tool>`). */
export async function pluginAgentTools(): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const p of usePlugins.getState().plugins) {
    if (!isRunnable(p) || !grantedPermissions(p).has('ai:tools')) continue;
    const prefix = p.record.id.split('.').pop()!.replace(/[^a-z0-9_]/g, '_');
    for (const t of p.manifest.contributes.aiTools ?? []) {
      tools.push({
        name: `${prefix}__${t.name}`,
        description: `${t.description} (from the ${p.manifest.name} plugin)`,
        parameters: t.parameters as AgentTool['parameters'],
        // Tools that may change things ask the user first, like connected apps' tools.
        destructive: !t.readOnly,
        readOnly: !!t.readOnly,
        async execute(args: Record<string, unknown>) {
          const out = await (await ensureRunning(p.record.id)).invoke('aiTool', t.name, args);
          return typeof out === 'string' ? out : JSON.stringify(out ?? null);
        },
      } satisfies AgentTool);
    }
  }
  return tools;
}

// ---- Events --------------------------------------------------------------------------------------

/** Sends an event to every listener that subscribed to it and may see the note. */
function emit(event: string, data: Record<string, unknown>, note?: BackendNote): void {
  for (const sink of sinks.values()) if (sink.events.has(event) && sink.allowed(note)) sink.deliver(event, data);
}

function scopeAllows(p: LoadedPlugin & { manifest: PluginManifest }, note: BackendNote): boolean {
  const s = p.manifest.noteScope!;
  const tagOk = !s.tags?.length || note.tags.some((t) => s.tags!.some((x) => x.replace(/^#/, '').toLowerCase() === t.replace(/^#/, '').toLowerCase()));
  const nbOk = !s.notebooks?.length || note.notebookPath.some((nb) => s.notebooks!.some((x) => x.toLowerCase() === nb.id.toLowerCase() || x.toLowerCase() === nb.name.toLowerCase()));
  return tagOk && nbOk;
}

// ---- The app behind the API ------------------------------------------------------------------------

function toBackend(n: NoteMeta, notebooks: NotebookMeta[]): BackendNote {
  const path: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let cur = notebooks.find((b) => b.id === n.notebookId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? notebooks.find((b) => b.id === cur!.parentId) : undefined;
  }
  return {
    id: n.id,
    title: n.title,
    tags: n.tags,
    notebook: path.length ? path.map((x) => x.name).join(' / ') : null,
    createdAt: new Date(n.createdAt).toISOString(),
    updatedAt: new Date(n.updatedAt).toISOString(),
    pages: n.pageIds.length,
    notebookPath: path,
    locked: !!n.lock,
  };
}

/** Plugin writes join one Activity run per plugin for a while, like agents' writes do. */
const recorders = new Map<string, { rec: RunRecorder; at: number }>();
function recorderFor(label: string): RunRecorder {
  const now = Date.now();
  const hit = recorders.get(label);
  if (hit && now - hit.at < 15 * 60_000) { hit.at = now; return hit.rec; }
  const rec = new RunRecorder(agentHub()?.activity ?? null, { source: 'external', label });
  recorders.set(label, { rec, at: now });
  return rec;
}

function writer(label: string): RecordingNoteToolHost {
  const v = useApp.getState().vault!;
  return new RecordingNoteToolHost(new AppNoteToolHost(v, openDocument(), 'import'), recorderFor(label).record);
}

export function appNotesBackend(): NotesBackend {
  const vault = () => {
    const v = useApp.getState().vault;
    if (!v) throw new Error('The vault is not open yet.');
    return v;
  };
  return {
    async list() {
      const v = vault();
      const nbs = await v.listNotebooks();
      return (await v.listNotes()).map((n) => toBackend(n, nbs));
    },
    async get(id) {
      const v = vault();
      const open = openDocument();
      const n = open?.meta.id === id ? open.meta : await v.vault.readNote(id);
      if (!n || n.trashedAt != null) return null;
      const base = toBackend(n, await v.listNotebooks());
      if (n.lock) return { ...base, markdown: '' };
      const pages = open?.meta.id === id ? [...open.pages] : await v.vault.readPages(n);
      return { ...base, markdown: pages.map((p) => pageText(p)).filter((t) => t.trim()).join('\n\n') };
    },
    async search(query, limit) {
      return vault().search.search(query, { limit }).map((h) => ({ id: h.noteId, page: h.pageIndex + 1, snippet: h.snippet.replace(/[«»]/g, '') }));
    },
    async create(note, by) {
      const w = writer(by);
      w.currentTool = 'create_note';
      return (await w.createNote({ title: note.title, text: note.text, tags: note.tags })).id;
    },
    async append(id, text, by) {
      const w = writer(by);
      w.currentTool = 'append_to_note';
      await w.appendText(id, text);
    },
    async update(id, patch, by) {
      const w = writer(by);
      w.currentTool = 'update_note';
      await w.updateNote(id, patch);
    },
  };
}

export function hostEnv(): HostEnv {
  const app = useApp.getState();
  return {
    notes: appNotesBackend(),
    editor: { state: editorState, selection: selectionText, insertText: (text, label) => insertTextInEditor(text, label) },
    toast: (text, tone) => app.toast({ text, tone }),
    openNote: (id, page) => app.navigate({ name: 'editor', noteId: id, ...(page ? { page: page - 1 } : {}) }),
    clipboard: (text) => navigator.clipboard.writeText(text),
    fetch: (u, i) => globalThis.fetch(u, i),
    appVersion: APP_VERSION,
    platform: isNative ? (nativePlatform === 'ios' ? 'ios' : 'android') : 'web',
  };
}

// ---- Managing plugins ------------------------------------------------------------------------------

/** Records that the person on this device approved the plugin as it is stored now (consent.ts). */
async function consentToStored(id: string, granted: readonly string[]): Promise<void> {
  const s = store();
  const m = await s.manifest(id);
  if ('error' in m) return;
  recordConsent(id, await pluginFingerprint((await s.readText(id, 'manifest.json')) ?? '', (await s.code(id, m.manifest.entry)) ?? ''), granted);
}

export async function installPackage(pkg: PluginPackage, granted: Permission[]): Promise<void> {
  stopPlugin(pkg.manifest.id);
  const rec = await store().install(pkg, granted);
  dataCache.delete(pkg.manifest.id);
  // Installed (or updated) here, with the permissions just approved here.
  await consentToStored(rec.id, rec.granted);
  await reloadPlugins();
}

/**
 * Approves, on this device, a plugin that was installed, updated or granted more elsewhere
 * (`needsReview`): the code as it was loaded and shown, with the permissions the person ticked.
 * If the files changed again in the meantime, the fingerprint no longer matches and it asks again.
 */
export async function approvePlugin(id: string, granted: Permission[]): Promise<void> {
  const p = findPlugin(id);
  if (!p?.manifest || !p.fingerprint) return;
  const allowed = granted.filter((g) => p.manifest!.permissions.includes(g));
  await store().updateRecord(id, (r) => ({ ...r, granted: allowed }));
  recordConsent(id, p.fingerprint, allowed);
  await reloadPlugins();
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await store().updateRecord(id, (r) => ({ ...r, enabled }));
  if (!enabled) stopPlugin(id);
  await reloadPlugins();
}

/** Grants or revokes one permission. Revoking stops the plugin so nothing keeps a stale grant. */
export async function setPermission(id: string, permission: Permission, granted: boolean): Promise<void> {
  await store().updateRecord(id, (r) => ({ ...r, granted: granted ? [...new Set([...r.granted, permission])] : r.granted.filter((g) => g !== permission) }));
  if (!granted) stopPlugin(id);
  // A switch flipped here is consent given (or taken back) here — but it never approves code
  // that is still waiting for a review.
  const c = consentFor(id);
  if (c && (!granted || !findPlugin(id)?.needsReview)) recordConsent(id, c.fp, granted ? [...c.granted, permission] : c.granted.filter((g) => g !== permission));
  await reloadPlugins();
}

export async function uninstallPlugin(id: string): Promise<void> {
  stopPlugin(id);
  forgetConsent(id);
  await store().uninstall(id);
  dataCache.delete(id);
  await reloadPlugins();
}

export async function savePluginSettings(id: string, settings: Record<string, string | number | boolean>): Promise<void> {
  const s = store();
  const d = await s.data(id);
  const next = { ...d, settings };
  dataCache.set(id, next);
  await s.saveData(id, next);
}

export async function pluginSettings(id: string): Promise<Record<string, string | number | boolean>> {
  return (await store().data(id)).settings;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  package: PluginPackage | null;
  /** Permissions the update adds (they need a new OK). */
  added: Permission[];
  error?: string;
}

/** Looks for a newer version (catalog plugins: the copy in this app; URL plugins: their URL). */
export async function checkForUpdate(id: string): Promise<UpdateCheck> {
  const p = findPlugin(id);
  const current = p?.record.version ?? '0.0.0';
  try {
    let pkg: PluginPackage | null = null;
    if (p?.record.source.kind === 'catalog') pkg = CATALOG.find((c) => c.id === id)?.load(APP_VERSION) ?? null;
    else if (p?.manifest) {
      const url = updateSourceOf(p.manifest, p.record.source);
      if (url) pkg = await packageFromUrl(url, APP_VERSION);
    }
    if (!pkg || compareVersions(pkg.manifest.version, current) <= 0) return { current, latest: pkg?.manifest.version ?? null, package: null, added: [] };
    if (pkg.manifest.id !== id) throw new Error(`The update is a different plugin (${pkg.manifest.id}).`);
    return { current, latest: pkg.manifest.version, package: pkg, added: p?.manifest ? addedPermissions(p.manifest, pkg.manifest) : pkg.manifest.permissions };
  } catch (e) {
    return { current, latest: null, package: null, added: [], error: (e as Error).message };
  }
}

/** Applies an update, keeping what was granted and adding what the user approved now. */
export async function applyUpdate(id: string, pkg: PluginPackage, newlyGranted: Permission[]): Promise<void> {
  const p = findPlugin(id);
  // Keep only what this device approved: grants added elsewhere and not yet reviewed don't carry over.
  const approved = p?.needsReview ? consentFor(id)?.granted ?? [] : null;
  const keep = p ? p.record.granted.filter((g) => pkg.manifest.permissions.includes(g as Permission) && (!approved || approved.includes(g))) : [];
  await installPackage(pkg, [...new Set([...(keep as Permission[]), ...newlyGranted])]);
}

/** Validates a manifest object (for the "check my plugin" developer flow). */
export const checkManifest = validateManifest;

// ---- Lifecycle -------------------------------------------------------------------------------------

/** Starts the host (Plugins module on): loads plugins, wires the palette and events. */
export function startPluginHost(): () => void {
  if (started) return () => {};
  started = true;
  const disposers: (() => void)[] = [];
  void reloadPlugins().catch((e) => console.warn('Plugins could not load', e));

  disposers.push(registerPaletteActions('plugins', () => [
    ...pluginCommands().map((c) => ({ id: `plugin:${c.pluginId}:${c.id}`, label: c.title, keywords: `${c.keywords ?? ''} ${c.pluginName} plugin`, hint: c.pluginName, icon: createElement(Puzzle, { size: 16 }), run: () => { void runCommand(c.pluginId, c.id); } })),
    ...pluginPanels().map((x) => ({ id: `plugin-panel:${x.pluginId}:${x.id}`, label: x.title, keywords: `${x.pluginName} plugin panel`, hint: x.pluginName, icon: createElement(Puzzle, { size: 16 }), run: () => openPluginPanel(x.pluginId, x.id) })),
    ...pluginImporters().map((x) => ({
      id: `plugin-import:${x.pluginId}:${x.id}`,
      label: `Import: ${x.title}`,
      keywords: `${x.extensions.join(' ')} import file ${x.pluginName} plugin`,
      hint: x.pluginName,
      icon: createElement(Puzzle, { size: 16 }),
      run: async () => {
        const app = useApp.getState();
        try {
          const { pickFiles } = await import('../platform/files.ts');
          const [file] = await pickFiles(x.extensions.map((e) => `.${e}`).join(','), false);
          if (!file) return;
          const ids = await runImporter(x.pluginId, x.id, { name: file.name, text: await file.text() });
          app.toast({ text: `${x.pluginName}: imported ${ids.length} note${ids.length === 1 ? '' : 's'}`, tone: 'success' });
          await app.refresh();
          if (ids[0]) app.navigate({ name: 'editor', noteId: ids[0] });
        } catch (e) {
          app.toast({ text: `${x.pluginName}: ${(e as Error).message}`, tone: 'error' });
        }
      },
    })),
  ]));

  // Note events from the vault (saves here, sync from other devices).
  const vault = useApp.getState().vault;
  let vaultKnown: Map<string, boolean> | null = null;
  if (vault) {
    const known = new Map<string, boolean>();
    vaultKnown = known;
    void vault.listNotes(true).then((ns) => { for (const n of ns) known.set(n.id, n.trashedAt != null); });
    disposers.push(vault.vault.onChange((c) => {
      // A sync can bring plugins installed, updated or switched off on another device.
      if (c.type === 'reloaded') void reloadPlugins();
      if (c.type !== 'note' || !sinks.size) return;
      void vault.vault.readNote(c.noteId).then(async (n) => {
        if (!n) return;
        const b = toBackend(n, await vault.listNotebooks());
        const was = known.get(n.id);
        known.set(n.id, n.trashedAt != null);
        const data = { id: n.id, title: n.title };
        if (was === undefined) emit('note.created', data, b);
        else if (!was && n.trashedAt != null) emit('note.trashed', data, b);
        else if (n.trashedAt == null) emit('note.updated', data, b);
      });
    }));
  }
  // Editor events carry the note they are about, so scope and lock checks apply to them like to
  // vault events (security review SR-04: they used to reach every subscriber).
  const editorNote = async (noteId: string): Promise<BackendNote | undefined> => {
    const v = useApp.getState().vault;
    if (!v) return undefined;
    const open = openDocument();
    const meta = open?.meta.id === noteId ? open.meta : await v.vault.readNote(noteId);
    return meta ? toBackend(meta, await v.listNotebooks()) : undefined;
  };
  disposers.push(onNoteOpened((noteId, title) => {
    // A note made in the library (no vault event yet) is new to plugins when it is first opened.
    const isNew = !!vaultKnown && !vaultKnown.has(noteId);
    if (isNew) vaultKnown!.set(noteId, false);
    if (!sinks.size) return;
    void editorNote(noteId).then((b) => {
      if (isNew) emit('note.created', { id: noteId, title }, b);
      emit('note.opened', { id: noteId, title }, b);
    });
  }));
  disposers.push(onSelectionChanged((noteId, text) => {
    if (!sinks.size) return;
    void editorNote(noteId).then((b) => emit('selection.changed', { noteId, text }, b));
  }));

  return () => {
    for (const d of disposers) d();
    for (const id of [...frames.keys()]) stopPlugin(id);
    started = false;
  };
}
