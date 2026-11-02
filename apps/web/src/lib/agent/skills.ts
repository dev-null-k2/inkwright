/**
 * Importing and exporting Agent Skills in the app: a picked folder, a `.zip`/`.skill` archive, or a
 * link to a SKILL.md. The parsing and validation live in @inkstone/ai; this file only gets bytes
 * in and out of the browser.
 */
import { SkillFormatError, skillFromFiles, skillFromMarkdown, skillMdUrl, type SkillBundle } from '@inkstone/ai';
import { readZip, writeZip } from '@inkstone/sync';
import { saveFile } from '../../platform/files.ts';
import { requireHub } from './hub.ts';

/** Opens the system folder picker (Chromium, Safari, Firefox desktop). */
export function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

const isArchive = (f: File) => /\.(zip|skill)$/i.test(f.name) || f.type === 'application/zip';

/** Builds a skill from picked files: one archive, or a folder (files carry webkitRelativePath). */
export async function skillFromPicked(files: File[]): Promise<SkillBundle> {
  if (!files.length) throw new SkillFormatError('No files were chosen.');
  if (files.length === 1 && isArchive(files[0]!)) {
    let entries;
    try {
      entries = await readZip(new Uint8Array(await files[0]!.arrayBuffer()));
    } catch {
      throw new SkillFormatError(`${files[0]!.name} is not a readable .zip archive.`);
    }
    return skillFromFiles(entries.filter((e) => !e.path.endsWith('/')));
  }
  const entries = await Promise.all(files.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  return skillFromFiles(entries);
}

/** Downloads a SKILL.md from a link (GitHub page links work too). Bundled files are not fetched. */
export async function skillFromUrl(url: string): Promise<SkillBundle> {
  const raw = skillMdUrl(url);
  let res: Response;
  try {
    res = await fetch(raw, { credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new SkillFormatError('Couldn’t download that link. The site may not allow web apps to read it — download the skill and import the file instead.');
  }
  if (!res.ok) throw new SkillFormatError(`The link returned ${res.status}. Use a direct link to the SKILL.md file.`);
  const text = await res.text();
  if (text.length > 512 * 1024) throw new SkillFormatError('That file is too large to be a SKILL.md.');
  return skillFromMarkdown(text);
}

export async function installSkill(b: SkillBundle, replace = false): Promise<void> {
  await requireHub().skills.install(b, { replace });
}

/** Saves a skill as a .zip (the folder with SKILL.md and its files), ready to share or re-import. */
export async function exportSkill(name: string): Promise<void> {
  const entries = await requireHub().skills.exportEntries(name);
  if (!entries.length) throw new Error('That skill is gone.');
  await saveFile(`${name}.zip`, await writeZip(entries), 'application/zip');
}
