/**
 * Every importer here converts its source into the same intermediate form — a Markdown vault
 * (notes as `.md` files with front matter, folders for notebooks, attachments beside them) — and
 * hands it to the Obsidian importer (`importObsidianVault`), which already lays text, images and
 * PDFs out on pages, turns folders into notebooks and keeps tags and dates. One page-layout path
 * for every source means an Evernote note and a Notion page look the same as a Markdown file.
 */
import { emitYaml, type YamlValue } from '../yaml.ts';
import { obsidianFileName, type VaultFile } from '../obsidian.ts';

export interface ImportedAttachment {
  /** File name as the source called it (made unique per note). */
  name: string;
  bytes: Uint8Array;
}

export interface ImportedNote {
  /** Notebook path, "/"-separated ("" = no notebook). */
  folder: string;
  title: string;
  /** Markdown body; attachments are referenced as `![alt](<name>)` by their final `name`. */
  body: string;
  tags?: string[];
  created?: number;
  updated?: number;
  /** Extra properties kept on the note (source URL, author…). */
  properties?: Record<string, YamlValue>;
  attachments?: ImportedAttachment[];
}

export interface ImportReportBase {
  notes: number;
  attachments: number;
  /** Things that could not be brought in, in plain words. */
  warnings: string[];
}

const enc = new TextEncoder();
const iso = (t: number | undefined) => (t && Number.isFinite(t) ? new Date(t).toISOString() : undefined);

/** A folder path whose every segment is a valid file name. */
export const cleanFolder = (folder: string) => folder.split('/').map((s) => s.trim()).filter(Boolean).map(obsidianFileName).join('/');

/**
 * Assigns each attachment a name unique in its note (`photo.png`, `photo (2).png`) and returns the
 * map from the original name. Use it before writing the body so references match.
 */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const n = obsidianFileName(raw.replace(/\.[^.]+$/, '')) + (/\.[a-z0-9]{1,8}$/i.exec(raw)?.[0]?.toLowerCase() ?? '');
    const k = n.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    return c === 1 ? n : n.replace(/(\.[^.]+)?$/, (ext) => ` (${c})${ext}`);
  });
}

/**
 * Writes notes as Markdown vault files. Titles that collide in a folder get " (2)", " (3)"…;
 * attachments go to `<folder>/_attachments/<note>/` so two notes' `image.png` never clash.
 */
export function notesToVaultFiles(notes: readonly ImportedNote[]): VaultFile[] {
  const out: VaultFile[] = [];
  const used = new Set<string>();
  for (const n of notes) {
    const folder = cleanFolder(n.folder);
    const base = obsidianFileName(n.title || 'Untitled');
    let name = base;
    for (let i = 2; used.has(`${folder}/${name}`.toLowerCase()); i++) name = `${base} (${i})`;
    used.add(`${folder}/${name}`.toLowerCase());
    const dir = folder ? `${folder}/` : '';
    const attDir = `_attachments/${name}`;
    let body = n.body;
    for (const a of n.attachments ?? []) {
      out.push({ path: `${dir}${attDir}/${a.name}`, bytes: a.bytes, ...(n.updated ? { mtime: n.updated } : {}) });
      // References were written against the bare name; point them at the attachment folder.
      body = body.split(`](<${a.name}>)`).join(`](<${attDir}/${a.name}>)`);
    }
    const fm: Record<string, YamlValue> = {};
    if (n.tags?.length) fm.tags = [...new Set(n.tags.map((t) => t.replace(/^#/, '').trim().replace(/\s+/g, '-')).filter(Boolean))];
    if (iso(n.created)) fm.created = iso(n.created)!;
    if (iso(n.updated)) fm.updated = iso(n.updated)!;
    for (const [k, v] of Object.entries(n.properties ?? {})) if (v != null && v !== '') fm[k] = v;
    const text = `${Object.keys(fm).length ? `---\n${emitYaml(fm)}---\n\n` : ''}${body.trim()}\n`;
    out.push({ path: `${dir}${name}.md`, bytes: enc.encode(text), ...(n.updated ? { mtime: n.updated } : {}) });
  }
  return out;
}

/**
 * Wraps converted files in one top folder before `importObsidianVault`, which treats a single top
 * folder as the vault itself (a zipped Obsidian vault) and drops it. Without the wrapper an
 * Evernote notebook exported alone would lose its notebook.
 */
export function forMarkdownImport(files: readonly VaultFile[]): VaultFile[] {
  return files.map((f) => ({ ...f, path: `import/${f.path}` }));
}
