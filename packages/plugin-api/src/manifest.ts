/**
 * Plugin manifests (`manifest.json` next to the plugin's code). The host reads the manifest
 * before running any plugin code: it drives the install prompt (permissions and contributions),
 * lazy activation (a plugin's sandbox only starts when one of its contributions is used), the
 * minimum app version check and update checks.
 */
import { PERMISSIONS, isPermission, type NoteScope, type Permission } from './permissions.ts';

/** A JSON Schema object describing an AI tool's arguments (the subset providers accept). */
export type JsonSchema = { type?: string | string[]; [k: string]: unknown };

export interface CommandContribution {
  /** Unique within the plugin, `[a-z0-9-]`. */
  id: string;
  /** Sentence-case label shown in the search palette and the editor's ••• › Plugins menu. */
  title: string;
  /** Extra words people might type to find it. */
  keywords?: string;
  /** `editor` commands also appear in the editor's ••• menu and only run while a note is open. */
  context?: 'app' | 'editor';
}

export interface PanelContribution {
  id: string;
  title: string;
}

export interface AiToolContribution {
  /** `[a-z0-9_]`, unique within the plugin. The assistant sees it as `<plugin>__<name>`. */
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Ask the user before every call (default true for anything not marked read-only). */
  readOnly?: boolean;
}

export interface ImporterContribution {
  id: string;
  title: string;
  /** File extensions without dots, e.g. ["csv", "opml"]. */
  extensions: string[];
}

export interface ExporterContribution {
  id: string;
  title: string;
  /** File extension without the dot. */
  extension: string;
  mimeType: string;
}

export interface SettingContribution {
  key: string;
  type: 'string' | 'number' | 'boolean';
  title: string;
  description?: string;
  default?: string | number | boolean;
  /** Shown as a password field. Stored like other settings (in the vault); not for long-lived secrets. */
  secret?: boolean;
}

export interface PluginContributes {
  commands?: CommandContribution[];
  panels?: PanelContribution[];
  aiTools?: AiToolContribution[];
  importers?: ImporterContribution[];
  exporters?: ExporterContribution[];
  settings?: SettingContribution[];
}

export interface PluginManifest {
  /** Reverse-DNS-ish id, `[a-z0-9]` with `.`, `-` or `_` between parts, 3–64 characters. */
  id: string;
  name: string;
  /** Semantic version, e.g. 1.2.0. */
  version: string;
  author: string;
  description: string;
  /** The plugin's ES module, relative to the manifest (default `main.js`). */
  entry: string;
  /** Lowest app version the plugin works with. */
  minAppVersion: string;
  /** Plugin API (protocol) version it was written for. Only `1` exists. */
  apiVersion: 1;
  permissions: Permission[];
  /** Narrows `notes:read`/`notes:write` to some notes. */
  noteScope?: NoteScope;
  /** Websites `network` may reach (see `hostAllowed`). Required with `network`. */
  network?: { hosts: string[] };
  /**
   * `startup` runs the plugin when the app opens (needed to hear events); `onUse` (default) waits
   * until one of its commands, panels, tools, importers or exporters is used.
   */
  activation?: 'startup' | 'onUse';
  contributes: PluginContributes;
  homepage?: string;
  /** Where to look for updates: a URL of the newest manifest.json. */
  updateUrl?: string;
}

export type ManifestResult = { ok: true; manifest: PluginManifest; warnings: string[] } | { ok: false; errors: string[] };

export const PLUGIN_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_]{0,47}$/;
const SETTING_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
const EXT_RE = /^[a-z0-9]{1,12}$/;
const ENTRY_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,128}\.m?js$/;
export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Compares two semantic versions (`major.minor.patch[-pre]`): negative when a < b. A
 * pre-release sorts before its release. Invalid versions sort before every valid one.
 */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a.trim());
  const pb = VERSION_RE.exec(b.trim());
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  const xa = pa[4];
  const xb = pb[4];
  if (xa === xb) return 0;
  if (!xa) return 1;
  if (!xb) return -1;
  const sa = xa.split('.');
  const sb = xb.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const str = (v: unknown, max = 500): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Checks a parsed manifest.json and returns a normalized manifest, or every problem found (so a
 * plugin author sees all mistakes at once). Unknown top-level fields are kept out of the result
 * and reported as warnings.
 */
export function validateManifest(input: unknown): ManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['The manifest must be a JSON object.'] };
  const m = input as Record<string, unknown>;
  const known = new Set(['id', 'name', 'version', 'author', 'description', 'entry', 'minAppVersion', 'apiVersion', 'permissions', 'noteScope', 'network', 'activation', 'contributes', 'homepage', 'updateUrl', '$schema']);
  for (const k of Object.keys(m)) if (!known.has(k)) warnings.push(`Unknown field "${k}" is ignored.`);

  if (!(typeof m.id === 'string' && m.id.length >= 3 && m.id.length <= 64 && PLUGIN_ID_RE.test(m.id))) errors.push('"id" must be 3–64 characters of a–z, 0–9 with ".", "-" or "_" between parts (e.g. "com.example.word-count").');
  if (!str(m.name, 80)) errors.push('"name" is required (at most 80 characters).');
  if (!(typeof m.version === 'string' && VERSION_RE.test(m.version))) errors.push('"version" must be a semantic version like 1.0.0.');
  if (!str(m.author, 120)) errors.push('"author" is required.');
  if (!str(m.description, 500)) errors.push('"description" is required (at most 500 characters).');
  const entry = m.entry === undefined ? 'main.js' : m.entry;
  if (!(typeof entry === 'string' && ENTRY_RE.test(entry))) errors.push('"entry" must be a relative path to a .js or .mjs file inside the plugin folder.');
  if (!(typeof m.minAppVersion === 'string' && VERSION_RE.test(m.minAppVersion))) errors.push('"minAppVersion" must be a semantic version like 1.0.0.');
  const apiVersion = m.apiVersion === undefined ? 1 : m.apiVersion;
  if (apiVersion !== 1) errors.push(`"apiVersion" ${JSON.stringify(m.apiVersion)} is not supported; this app speaks plugin API version 1.`);

  const permissions: Permission[] = [];
  if (m.permissions !== undefined && !Array.isArray(m.permissions)) errors.push('"permissions" must be an array.');
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    if (!isPermission(p)) errors.push(`Unknown permission ${JSON.stringify(p)}. Known: ${PERMISSIONS.join(', ')}.`);
    else if (!permissions.includes(p)) permissions.push(p);
  }

  let noteScope: NoteScope | undefined;
  if (m.noteScope !== undefined) {
    const s = m.noteScope as Record<string, unknown>;
    const list = (v: unknown, what: string) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || !v.every((x) => str(x, 100))) {
        errors.push(`"noteScope.${what}" must be an array of names.`);
        return undefined;
      }
      return v as string[];
    };
    if (!s || typeof s !== 'object') errors.push('"noteScope" must be an object.');
    else {
      noteScope = {};
      const tags = list(s.tags, 'tags');
      const notebooks = list(s.notebooks, 'notebooks');
      if (tags) noteScope.tags = tags;
      if (notebooks) noteScope.notebooks = notebooks;
      if (!permissions.some((p) => p === 'notes:read' || p === 'notes:write')) warnings.push('"noteScope" has no effect without notes:read or notes:write.');
    }
  }

  let network: { hosts: string[] } | undefined;
  if (m.network !== undefined) {
    const hosts = (m.network as { hosts?: unknown })?.hosts;
    if (!Array.isArray(hosts) || !hosts.length || !hosts.every((h) => typeof h === 'string' && (h === '*' || /^https?:\/\/(\*\.)?[^/:*]+(:\d+)?\/?$/.test(h)))) {
      errors.push('"network.hosts" must list origins like "https://hooks.example.com", "https://*.example.com" or "*".');
    } else network = { hosts: hosts as string[] };
  }
  if (permissions.includes('network') && !network) errors.push('The "network" permission needs "network": { "hosts": [...] } naming the sites it may reach.');
  if (network && !permissions.includes('network')) warnings.push('"network.hosts" has no effect without the "network" permission.');

  const activation = m.activation ?? 'onUse';
  if (activation !== 'startup' && activation !== 'onUse') errors.push('"activation" must be "startup" or "onUse".');

  const contributes: PluginContributes = {};
  const c = (m.contributes ?? {}) as Record<string, unknown>;
  if (typeof c !== 'object' || Array.isArray(c)) errors.push('"contributes" must be an object.');
  const arr = (key: string): Record<string, unknown>[] => {
    const v = c[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => x && typeof x === 'object')) {
      errors.push(`"contributes.${key}" must be an array of objects.`);
      return [];
    }
    return v as Record<string, unknown>[];
  };
  const unique = (key: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`"contributes.${key}" has "${id}" twice.`);
      seen.add(id);
    }
  };

  const commands = arr('commands').map((x, i) => {
    if (!(typeof x.id === 'string' && LOCAL_ID_RE.test(x.id))) errors.push(`contributes.commands[${i}].id must be a-z, 0-9 and "-".`);
    if (!str(x.title, 80)) errors.push(`contributes.commands[${i}].title is required.`);
    if (x.context !== undefined && x.context !== 'app' && x.context !== 'editor') errors.push(`contributes.commands[${i}].context must be "app" or "editor".`);
    return { id: String(x.id), title: String(x.title ?? ''), ...(typeof x.keywords === 'string' ? { keywords: x.keywords } : {}), context: (x.context as 'app' | 'editor' | undefined) ?? 'app' };
  });
  unique('commands', commands.map((x) => x.id));
  if (commands.length) contributes.commands = commands;

  const panels = arr('panels').map((x, i) => {
    if (!(typeof x.id === 'string' && LOCAL_ID_RE.test(x.id))) errors.push(`contributes.panels[${i}].id must be a-z, 0-9 and "-".`);
    if (!str(x.title, 60)) errors.push(`contributes.panels[${i}].title is required.`);
    return { id: String(x.id), title: String(x.title ?? '') };
  });
  unique('panels', panels.map((x) => x.id));
  if (panels.length) contributes.panels = panels;

  const aiTools = arr('aiTools').map((x, i) => {
    if (!(typeof x.name === 'string' && TOOL_NAME_RE.test(x.name))) errors.push(`contributes.aiTools[${i}].name must be a-z, 0-9 and "_".`);
    if (!str(x.description, 1000)) errors.push(`contributes.aiTools[${i}].description is required.`);
    const params = x.parameters ?? { type: 'object', properties: {} };
    if (!params || typeof params !== 'object' || (params as JsonSchema).type !== 'object') errors.push(`contributes.aiTools[${i}].parameters must be a JSON Schema with "type": "object".`);
    return { name: String(x.name), description: String(x.description ?? ''), parameters: params as JsonSchema, readOnly: x.readOnly === true };
  });
  unique('aiTools', aiTools.map((x) => x.name));
  if (aiTools.length) {
    contributes.aiTools = aiTools;
    if (!permissions.includes('ai:tools')) errors.push('"contributes.aiTools" needs the "ai:tools" permission.');
  }

  const importers = arr('importers').map((x, i) => {
    if (!(typeof x.id === 'string' && LOCAL_ID_RE.test(x.id))) errors.push(`contributes.importers[${i}].id must be a-z, 0-9 and "-".`);
    if (!str(x.title, 80)) errors.push(`contributes.importers[${i}].title is required.`);
    const ext = Array.isArray(x.extensions) ? (x.extensions as unknown[]).map((e) => String(e).replace(/^\./, '').toLowerCase()) : [];
    if (!ext.length || !ext.every((e) => EXT_RE.test(e))) errors.push(`contributes.importers[${i}].extensions must list file extensions like ["csv"].`);
    return { id: String(x.id), title: String(x.title ?? ''), extensions: ext };
  });
  unique('importers', importers.map((x) => x.id));
  if (importers.length) contributes.importers = importers;

  const exporters = arr('exporters').map((x, i) => {
    if (!(typeof x.id === 'string' && LOCAL_ID_RE.test(x.id))) errors.push(`contributes.exporters[${i}].id must be a-z, 0-9 and "-".`);
    if (!str(x.title, 80)) errors.push(`contributes.exporters[${i}].title is required.`);
    const ext = String(x.extension ?? '').replace(/^\./, '').toLowerCase();
    if (!EXT_RE.test(ext)) errors.push(`contributes.exporters[${i}].extension must be a file extension like "csv".`);
    if (!(typeof x.mimeType === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(x.mimeType))) errors.push(`contributes.exporters[${i}].mimeType must be a media type like "text/csv".`);
    return { id: String(x.id), title: String(x.title ?? ''), extension: ext, mimeType: String(x.mimeType ?? '') };
  });
  unique('exporters', exporters.map((x) => x.id));
  if (exporters.length) contributes.exporters = exporters;

  const settings = arr('settings').map((x, i) => {
    if (!(typeof x.key === 'string' && SETTING_KEY_RE.test(x.key))) errors.push(`contributes.settings[${i}].key must be a letter followed by letters, digits or "_".`);
    if (x.type !== 'string' && x.type !== 'number' && x.type !== 'boolean') errors.push(`contributes.settings[${i}].type must be "string", "number" or "boolean".`);
    if (!str(x.title, 80)) errors.push(`contributes.settings[${i}].title is required.`);
    if (x.default !== undefined && typeof x.default !== x.type) errors.push(`contributes.settings[${i}].default must be a ${String(x.type)}.`);
    const out: SettingContribution = { key: String(x.key), type: x.type as SettingContribution['type'], title: String(x.title ?? '') };
    if (typeof x.description === 'string') out.description = x.description;
    if (x.default !== undefined) out.default = x.default as string | number | boolean;
    if (x.secret === true) out.secret = true;
    return out;
  });
  unique('settings', settings.map((x) => x.key));
  if (settings.length) contributes.settings = settings;

  if (m.homepage !== undefined && !(typeof m.homepage === 'string' && /^https:\/\//.test(m.homepage))) errors.push('"homepage" must be an https:// URL.');
  if (m.updateUrl !== undefined && !(typeof m.updateUrl === 'string' && /^https?:\/\//.test(m.updateUrl))) errors.push('"updateUrl" must be a URL.');

  if (errors.length) return { ok: false, errors };
  const manifest: PluginManifest = {
    id: m.id as string,
    name: (m.name as string).trim(),
    version: m.version as string,
    author: (m.author as string).trim(),
    description: (m.description as string).trim(),
    entry: entry as string,
    minAppVersion: m.minAppVersion as string,
    apiVersion: 1,
    permissions,
    activation: activation as 'startup' | 'onUse',
    contributes,
  };
  if (noteScope && (noteScope.tags || noteScope.notebooks)) manifest.noteScope = noteScope;
  if (network) manifest.network = network;
  if (m.homepage) manifest.homepage = m.homepage as string;
  if (m.updateUrl) manifest.updateUrl = m.updateUrl as string;
  return { ok: true, manifest, warnings };
}

/** Permissions a new version asks for that the old one did not (they need a fresh OK). */
export function addedPermissions(previous: PluginManifest, next: PluginManifest): Permission[] {
  const added = next.permissions.filter((p) => !previous.permissions.includes(p));
  const oldHosts = new Set(previous.network?.hosts ?? []);
  if (next.permissions.includes('network') && previous.permissions.includes('network') && (next.network?.hosts ?? []).some((h) => !oldHosts.has(h))) added.push('network');
  return added;
}
