/**
 * Agent Skills (https://agentskills.io): folders with a `SKILL.md` (YAML frontmatter + Markdown
 * instructions) and optional bundled files. Inkwright imports them from a folder, a `.zip`/`.skill`
 * archive or a URL to a SKILL.md, validates the frontmatter against the spec, and stores them in
 * the vault under `ai/skills/<name>/` so they sync like notes.
 *
 * Progressive disclosure, as the standard intends:
 *   1. only each enabled skill's name + description go into the system prompt,
 *   2. `load_skill` returns the instructions (SKILL.md body) and lists the bundled files,
 *   3. `read_skill_resource` reads one bundled text file when the instructions point to it.
 * Scripts in skills are never executed — Inkwright has no code runner, by design. They can be read
 * as text like any other file.
 */
import { isSafeId, type VaultFS } from '@inkwright/core';
import type { AgentTool } from './agent.ts';

// ---- SKILL.md parsing ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  license?: unknown;
  compatibility?: unknown;
  metadata?: unknown;
  'allowed-tools'?: unknown;
  [key: string]: unknown;
}

export interface ParsedSkillMd {
  frontmatter: SkillFrontmatter;
  body: string;
}

export class SkillFormatError extends Error {
  constructor(message: string, readonly problems: string[] = [message]) {
    super(message);
    this.name = 'SkillFormatError';
  }
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, c: string) =>
      c.startsWith('u') ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? c,
    );
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Drops a trailing ` # comment` from a plain (unquoted) scalar. */
function stripComment(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    // Keep the quoted scalar; drop a comment after its closing quote.
    const q = t[0]!;
    for (let i = 1; i < t.length; i++) {
      if (q === '"' && t[i] === '\\') { i++; continue; }
      if (t[i] === q) {
        if (q === "'" && t[i + 1] === "'") { i++; continue; }
        const rest = t.slice(i + 1).trim();
        return rest === '' || rest.startsWith('#') ? t.slice(0, i + 1) : t;
      }
    }
    return t;
  }
  const i = t.search(/\s#/);
  return i >= 0 ? t.slice(0, i).trim() : t;
}

/**
 * Parses the YAML subset SKILL.md frontmatter uses: `key: value` scalars (plain, single or double
 * quoted), block scalars (`|`, `>`, with `-`/`+` chomping), and one level of nested mapping
 * (`metadata:`). Anything richer is reported, not guessed at.
 */
export function parseFrontmatterYaml(yaml: string): SkillFrontmatter {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n');
  const out: Record<string, unknown> = {};
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) { i++; continue; }
    if (indentOf(line) > 0) throw new SkillFormatError(`Unexpected indentation in frontmatter: "${line.trim()}"`);
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    if (!m) throw new SkillFormatError(`Frontmatter line is not "key: value": "${line.trim()}"`);
    const key = m[1]!;
    const rest = m[2]!.trim();
    i++;
    const block = /^([|>])([+-]?)\s*(#.*)?$/.exec(rest);
    if (block) {
      const collected: string[] = [];
      let indent = -1;
      while (i < lines.length && (!lines[i]!.trim() || indentOf(lines[i]!) > 0)) {
        const l = lines[i]!;
        if (l.trim() && indent < 0) indent = indentOf(l);
        collected.push(indent >= 0 ? l.slice(Math.min(indent, indentOf(l) || indent)) : '');
        i++;
      }
      let text: string;
      if (block[1] === '|') text = collected.join('\n');
      else {
        // Folded: single newlines become spaces, blank lines stay paragraph breaks.
        text = collected.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
      }
      const chomp = block[2];
      text = chomp === '+' ? text : chomp === '-' ? text.replace(/\n+$/, '') : text.replace(/\n+$/, '') + '\n';
      out[key] = chomp === '' ? text.replace(/\n$/, '') : text;
      continue;
    }
    if (rest === '') {
      // Nested mapping (metadata:) — or an empty value.
      const map: Record<string, string> = {};
      let any = false;
      while (i < lines.length && (!lines[i]!.trim() || indentOf(lines[i]!) > 0)) {
        const l = lines[i]!;
        i++;
        if (!l.trim() || l.trim().startsWith('#')) continue;
        if (l.trim().startsWith('- ')) throw new SkillFormatError(`Lists are not supported in SKILL.md frontmatter ("${key}").`);
        const mm = /^\s+([^:#]+?)\s*:\s*(.*)$/.exec(l);
        if (!mm) throw new SkillFormatError(`Could not read "${l.trim()}" under "${key}".`);
        map[unquote(mm[1]!)] = unquote(stripComment(mm[2]!));
        any = true;
      }
      out[key] = any ? map : '';
      continue;
    }
    if (rest.startsWith('[') || rest.startsWith('{')) {
      try {
        out[key] = JSON.parse(rest);
        continue;
      } catch {
        throw new SkillFormatError(`Could not read the value of "${key}".`);
      }
    }
    // Plain scalars may continue on more-indented lines (multi-line plain scalar).
    let value = stripComment(rest);
    while (i < lines.length && lines[i]!.trim() && indentOf(lines[i]!) > 0 && !rest.startsWith('"') && !rest.startsWith("'")) {
      value += ' ' + lines[i]!.trim();
      i++;
    }
    out[key] = unquote(value);
  }
  return out;
}

/** Splits a SKILL.md into frontmatter and body. Throws SkillFormatError when the frontmatter is missing. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) throw new SkillFormatError('SKILL.md must start with YAML frontmatter between "---" lines.');
  return { frontmatter: parseFrontmatterYaml(m[1]!), body: t.slice(m[0].length).replace(/^\n+/, '') };
}

const KNOWN_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

export interface SkillValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Checks frontmatter against the Agent Skills specification. `dirName` must equal `name` when given. */
export function validateSkillFrontmatter(fm: SkillFrontmatter, dirName?: string): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = fm.name;
  if (typeof name !== 'string' || !name) errors.push('"name" is required.');
  else {
    if (name.length > 64) errors.push('"name" must be at most 64 characters.');
    if (!/^[a-z0-9-]+$/.test(name)) errors.push('"name" may only contain lowercase letters, numbers and hyphens.');
    if (name.startsWith('-') || name.endsWith('-')) errors.push('"name" must not start or end with a hyphen.');
    if (name.includes('--')) errors.push('"name" must not contain consecutive hyphens.');
    if (dirName !== undefined && dirName !== name) errors.push(`"name" (${name}) must match the skill's folder name (${dirName}).`);
  }
  const d = fm.description;
  if (typeof d !== 'string' || !d.trim()) errors.push('"description" is required.');
  else if (d.length > 1024) errors.push('"description" must be at most 1024 characters.');
  if (fm.compatibility !== undefined && (typeof fm.compatibility !== 'string' || !fm.compatibility || fm.compatibility.length > 500)) errors.push('"compatibility" must be 1–500 characters.');
  if (fm.license !== undefined && typeof fm.license !== 'string') errors.push('"license" must be text.');
  if (fm.metadata !== undefined && fm.metadata !== '') {
    if (!fm.metadata || typeof fm.metadata !== 'object' || Array.isArray(fm.metadata)) errors.push('"metadata" must be a map of keys to text values.');
    else for (const [k, v] of Object.entries(fm.metadata as Record<string, unknown>)) if (typeof v !== 'string') errors.push(`"metadata.${k}" must be text.`);
  }
  if (fm['allowed-tools'] !== undefined && typeof fm['allowed-tools'] !== 'string') errors.push('"allowed-tools" must be a space-separated string.');
  for (const k of Object.keys(fm)) if (!KNOWN_FIELDS.has(k)) warnings.push(`Unknown frontmatter field "${k}" is ignored.`);
  return { ok: !errors.length, errors, warnings };
}

// ---- Bundles ------------------------------------------------------------------------------------

export interface SkillFile {
  /** Relative to the skill root, POSIX, e.g. `references/FORMS.md`. */
  path: string;
  size: number;
  /** Decoded text for text files. */
  text?: string;
  /** Raw bytes (binary assets are stored but never sent to the model). */
  bytes?: Uint8Array;
}

/** A skill ready to install or already installed. */
export interface SkillBundle {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  /** The SKILL.md instructions (frontmatter removed). */
  body: string;
  /** SKILL.md as written. */
  skillMd: string;
  /** Bundled files other than SKILL.md. */
  files: SkillFile[];
  warnings: string[];
  /** Built-in skills ship with the app (read-only; can be disabled). */
  builtin?: boolean;
}

export const SKILL_LIMITS = { maxFiles: 200, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, maxResourceChars: 60_000 } as const;

const TEXT_EXT = /\.(md|markdown|txt|text|json|jsonc|ya?ml|toml|csv|tsv|xml|html?|css|svg|py|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|rb|pl|ps1|bat|lua|r|sql|ini|cfg|conf|env|tex|rst|org|adoc|log)$/i;
const SCRIPT_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe|lua|r|jar|wasm|bin)$/i;

/** Scripts are stored and readable but never run. */
export function isScriptPath(path: string): boolean {
  return path.startsWith('scripts/') || SCRIPT_EXT.test(path);
}

const dec = new TextDecoder('utf-8', { fatal: true });

function decodeText(path: string, bytes: Uint8Array): string | undefined {
  if (!TEXT_EXT.test(path) && !/^[A-Z_-]+$/.test(path.split('/').pop() ?? '')) return undefined;
  try {
    return dec.decode(bytes);
  } catch {
    return undefined;
  }
}

/** A safe relative path inside a skill, or null. */
export function cleanSkillPath(p: string): string | null {
  const parts = p.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.startsWith('.') || x === '__MACOSX' || /[\0:*?"<>|]/.test(x))) return null;
  return parts.join('/');
}

/** Builds a bundle from SKILL.md text alone (URL import, built-ins). */
export function skillFromMarkdown(skillMd: string, opts: { dirName?: string; files?: SkillFile[]; builtin?: boolean } = {}): SkillBundle {
  const { frontmatter: fm, body } = parseSkillMd(skillMd);
  const v = validateSkillFrontmatter(fm, opts.dirName);
  if (!v.ok) throw new SkillFormatError(`This skill's SKILL.md is not valid: ${v.errors.join(' ')}`, v.errors);
  const b: SkillBundle = { name: fm.name as string, description: (fm.description as string).trim(), body, skillMd, files: opts.files ?? [], warnings: v.warnings };
  if (typeof fm.license === 'string') b.license = fm.license;
  if (typeof fm.compatibility === 'string') b.compatibility = fm.compatibility;
  if (fm.metadata && typeof fm.metadata === 'object') b.metadata = fm.metadata as Record<string, string>;
  if (typeof fm['allowed-tools'] === 'string') b.allowedTools = fm['allowed-tools'];
  if (opts.builtin) b.builtin = true;
  return b;
}

/**
 * Builds a bundle from files picked as a folder or read from a .zip/.skill archive. Accepts the
 * skill at the root or inside one top-level folder (how archives and folder pickers deliver it).
 */
export function skillFromFiles(entries: ReadonlyArray<{ path: string; bytes: Uint8Array }>): SkillBundle {
  const clean = entries.map((e) => ({ path: cleanSkillPath(e.path), bytes: e.bytes })).filter((e): e is { path: string; bytes: Uint8Array } => !!e.path);
  const skillMds = clean.filter((e) => e.path.split('/').pop() === 'SKILL.md').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const top = skillMds[0];
  if (!top) throw new SkillFormatError('No SKILL.md found. A skill is a folder with a SKILL.md file at its top.');
  const depth = top.path.split('/').length;
  if (skillMds.filter((s) => s.path.split('/').length === depth).length > 1) throw new SkillFormatError('Found several skills. Import one skill at a time.');
  if (depth > 2) throw new SkillFormatError('SKILL.md must be at the top of the skill folder.');
  const prefix = depth === 2 ? top.path.split('/')[0]! + '/' : '';
  const dirName = prefix ? prefix.slice(0, -1) : undefined;
  const files: SkillFile[] = [];
  let total = 0;
  for (const e of clean) {
    if (!e.path.startsWith(prefix) || e.path === top.path) continue;
    const rel = e.path.slice(prefix.length);
    if (e.bytes.length > SKILL_LIMITS.maxFileBytes) throw new SkillFormatError(`${rel} is larger than ${SKILL_LIMITS.maxFileBytes / 1048576} MB.`);
    total += e.bytes.length;
    const text = decodeText(rel, e.bytes);
    files.push(text !== undefined ? { path: rel, size: e.bytes.length, text } : { path: rel, size: e.bytes.length, bytes: e.bytes });
  }
  if (files.length > SKILL_LIMITS.maxFiles) throw new SkillFormatError(`A skill can bundle at most ${SKILL_LIMITS.maxFiles} files.`);
  if (total > SKILL_LIMITS.maxTotalBytes) throw new SkillFormatError(`A skill can bundle at most ${SKILL_LIMITS.maxTotalBytes / 1048576} MB of files.`);
  let md: string;
  try {
    md = dec.decode(top.bytes);
  } catch {
    throw new SkillFormatError('SKILL.md is not UTF-8 text.');
  }
  // The folder name must match `name` per the spec, but archives are often renamed when
  // downloaded ("pdf-processing (1).zip"); only a real folder name is held to it.
  const fm = parseSkillMd(md).frontmatter;
  const strictDir = dirName && /^[a-z0-9-]+$/.test(dirName) ? dirName : undefined;
  const bundle = skillFromMarkdown(md, { dirName: strictDir, files: files.sort((a, b) => a.path.localeCompare(b.path)) });
  if (dirName && !strictDir && dirName !== fm.name) bundle.warnings.push(`The folder "${dirName}" was renamed to "${bundle.name}" to match the skill's name.`);
  return bundle;
}

/** Resolves a link to a SKILL.md: GitHub "blob" pages become raw file URLs. */
export function skillMdUrl(input: string): string {
  const u = new URL(input.trim());
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new SkillFormatError('Use an https:// link to a SKILL.md file.');
  const gh = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
  if (u.hostname === 'github.com' && gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
  return u.toString();
}

// ---- Storage ------------------------------------------------------------------------------------

/** Vault folder for user skills (docs/VAULT_FORMAT.md). */
export const SKILLS_DIR = 'ai/skills';
/** Which skills are switched off (built-in and imported), by name. */
export const SKILLS_STATE_PATH = 'ai/skills.json';

export interface SkillInfo extends SkillBundle {
  enabled: boolean;
}

/** Imported skills in the vault plus the app's built-ins, with per-skill on/off state. */
export class SkillStore {
  private listeners = new Set<() => void>();
  constructor(private fs: VaultFS, private builtins: readonly SkillBundle[] = []) {}

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() { for (const l of [...this.listeners]) l(); }

  private async disabled(): Promise<Set<string>> {
    const t = await this.fs.readText(SKILLS_STATE_PATH);
    try {
      const j = t ? (JSON.parse(t) as { disabled?: unknown }) : {};
      return new Set(Array.isArray(j.disabled) ? j.disabled.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const d = await this.disabled();
    if (enabled) d.delete(name);
    else d.add(name);
    await this.fs.writeText(SKILLS_STATE_PATH, JSON.stringify({ disabled: [...d].sort() }, null, 2));
    this.emit();
  }

  /** Every skill (built-ins first), with metadata and body. Broken folders are skipped. */
  async list(): Promise<SkillInfo[]> {
    const d = await this.disabled();
    const out: SkillInfo[] = this.builtins.map((b) => ({ ...b, enabled: !d.has(b.name) }));
    for (const e of await this.fs.list(SKILLS_DIR)) {
      if (e.kind !== 'dir' || out.some((s) => s.name === e.name)) continue;
      const b = await this.get(e.name);
      if (b) out.push({ ...b, enabled: !d.has(b.name) });
    }
    return out;
  }

  async enabled(): Promise<SkillInfo[]> {
    return (await this.list()).filter((s) => s.enabled);
  }

  /** One skill with its file list (text files decoded; binaries listed by size). */
  async get(name: string): Promise<SkillBundle | null> {
    const builtin = this.builtins.find((b) => b.name === name);
    if (builtin) return builtin;
    if (!isSkillName(name)) return null;
    const md = await this.fs.readText(`${SKILLS_DIR}/${name}/SKILL.md`);
    if (md == null) return null;
    try {
      const b = skillFromMarkdown(md, { dirName: name });
      b.files = await this.listFiles(name);
      return b;
    } catch {
      return null;
    }
  }

  private async listFiles(name: string, dir = ''): Promise<SkillFile[]> {
    const out: SkillFile[] = [];
    for (const e of await this.fs.list(`${SKILLS_DIR}/${name}${dir ? '/' + dir : ''}`)) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') out.push(...(await this.listFiles(name, rel)));
      else if (rel !== 'SKILL.md') out.push({ path: rel, size: e.size ?? 0 });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Reads one bundled file as text (null if missing, binary or outside the skill). */
  async readResource(name: string, path: string): Promise<{ text: string; truncated: boolean } | null> {
    const rel = cleanSkillPath(path);
    if (!rel) return null;
    const builtin = this.builtins.find((b) => b.name === name);
    let text: string | undefined;
    if (builtin) text = rel === 'SKILL.md' ? builtin.skillMd : builtin.files.find((f) => f.path === rel)?.text;
    else {
      if (!isSkillName(name)) return null;
      const bytes = await this.fs.readBytes(`${SKILLS_DIR}/${name}/${rel}`);
      if (!bytes) return null;
      text = decodeText(rel, bytes) ?? (rel === 'SKILL.md' ? new TextDecoder().decode(bytes) : undefined);
    }
    if (text == null) return null;
    const max = SKILL_LIMITS.maxResourceChars;
    return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
  }

  /** Raw bytes of every file (for export). */
  async exportEntries(name: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
    const b = await this.get(name);
    if (!b) return [];
    const enc = new TextEncoder();
    const out: Array<{ path: string; bytes: Uint8Array }> = [{ path: `${name}/SKILL.md`, bytes: enc.encode(b.skillMd) }];
    for (const f of b.files) {
      if (b.builtin) out.push({ path: `${name}/${f.path}`, bytes: enc.encode(f.text ?? '') });
      else {
        const bytes = await this.fs.readBytes(`${SKILLS_DIR}/${name}/${f.path}`);
        if (bytes) out.push({ path: `${name}/${f.path}`, bytes });
      }
    }
    return out;
  }

  async exists(name: string): Promise<boolean> {
    return this.builtins.some((b) => b.name === name) || (await this.fs.readText(`${SKILLS_DIR}/${name}/SKILL.md`)) != null;
  }

  /** Writes a skill into the vault. Names of built-ins are reserved. */
  async install(b: SkillBundle, opts: { replace?: boolean } = {}): Promise<void> {
    if (!isSkillName(b.name)) throw new SkillFormatError(`"${b.name}" is not a valid skill name.`);
    if (this.builtins.some((x) => x.name === b.name)) throw new SkillFormatError(`"${b.name}" is the name of a built-in skill. Rename the copy (and its folder) first.`);
    const dir = `${SKILLS_DIR}/${b.name}`;
    if (!opts.replace && (await this.fs.readText(`${dir}/SKILL.md`)) != null) throw new SkillFormatError(`A skill named "${b.name}" is already installed.`);
    await this.fs.deleteDir(dir);
    await this.fs.writeText(`${dir}/SKILL.md`, b.skillMd);
    for (const f of b.files) {
      const rel = cleanSkillPath(f.path);
      if (!rel) continue;
      if (f.bytes) await this.fs.writeBytes(`${dir}/${rel}`, f.bytes);
      else await this.fs.writeText(`${dir}/${rel}`, f.text ?? '');
    }
    this.emit();
  }

  async remove(name: string): Promise<void> {
    if (!isSkillName(name) || this.builtins.some((b) => b.name === name)) return;
    await this.fs.deleteDir(`${SKILLS_DIR}/${name}`);
    const d = await this.disabled();
    if (d.delete(name)) await this.fs.writeText(SKILLS_STATE_PATH, JSON.stringify({ disabled: [...d].sort() }, null, 2));
    this.emit();
  }
}

export function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && isSafeId(name);
}

// ---- Agent integration ---------------------------------------------------------------------------

/** System-prompt section: level 1 of progressive disclosure (names and descriptions only). */
export function skillsPromptSection(skills: ReadonlyArray<Pick<SkillBundle, 'name' | 'description'>>): string {
  if (!skills.length) return '';
  return [
    'Skills: instructions for specific tasks. When a request matches a skill\'s description, call load_skill with its name first and follow what it says; use read_skill_resource for files it points to. Skills cannot run code.',
    ...skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 300)}`),
  ].join('\n');
}

/** `load_skill` and `read_skill_resource` over the enabled skills. */
export function createSkillTools(store: Pick<SkillStore, 'enabled' | 'readResource'>): AgentTool[] {
  const find = async (name: string) => (await store.enabled()).find((s) => s.name === name);
  return [
    {
      name: 'load_skill',
      description: 'Load a skill\'s full instructions by name (from the Skills list in your instructions). Call it before doing a task a skill covers. Returns the instructions and the files bundled with the skill.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The skill name, e.g. "make-flashcards".' } }, required: ['name'], additionalProperties: false },
      readOnly: true,
      async execute(a: { name: string }) {
        const s = await find(a.name.trim());
        if (!s) {
          const names = (await store.enabled()).map((x) => x.name);
          throw new Error(`No enabled skill named "${a.name}". Available: ${names.join(', ') || 'none'}.`);
        }
        return {
          name: s.name,
          instructions: s.body,
          ...(s.files.length ? { files: s.files.map((f) => ({ path: f.path, size: f.size, ...(isScriptPath(f.path) ? { note: 'script — cannot be run here; read it only if needed' } : {}) })) } : {}),
          ...(s.compatibility ? { compatibility: s.compatibility } : {}),
        };
      },
    },
    {
      name: 'read_skill_resource',
      description: 'Read a text file bundled with a skill (paths come from load_skill, e.g. "references/FORMS.md"). Scripts can be read but are never executed.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The skill name.' }, path: { type: 'string', description: 'File path inside the skill.' } }, required: ['name', 'path'], additionalProperties: false },
      readOnly: true,
      async execute(a: { name: string; path: string }) {
        if (!(await find(a.name.trim()))) throw new Error(`No enabled skill named "${a.name}".`);
        const r = await store.readResource(a.name.trim(), a.path);
        if (!r) throw new Error(`"${a.path}" is not a text file in the ${a.name} skill. Use the paths listed by load_skill.`);
        return r.truncated ? `${r.text}\n…[truncated]` : r.text;
      },
    },
  ];
}
