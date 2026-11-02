/**
 * Getting a plugin package from where people have it: a URL (of its manifest.json, its folder,
 * or a .zip), a .zip file, a folder on this device, or the curated list. Every source ends in
 * `packageFromFiles`, which finds and validates the manifest, checks the app version, keeps only
 * file types a plugin may ship and enforces size limits — before anything is written or run.
 */
import { compareVersions, validateManifest, type PluginManifest } from '@inkwright/plugin-api';
import type { PluginSource } from '@inkwright/core';
import type { PluginPackage } from './store.ts';

export const MAX_PLUGIN_BYTES = 5 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 200;
/** What a plugin folder may contain: code, data, styles, docs and images. */
const ALLOWED = /\.(m?js|json|css|md|txt|svg|png|jpe?g|webp)$/i;

export class PluginInstallError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Builds a package from loose files. The manifest may be at the root or inside a single top
 * folder (zips usually have one); its entry file must be present.
 */
export function packageFromFiles(input: Map<string, Uint8Array>, source: PluginSource, appVersion: string): PluginPackage {
  const paths = [...input.keys()].map((p) => p.replace(/\\/g, '/').replace(/^\.?\//, ''));
  const manifestPath = paths.filter((p) => /(^|\/)manifest\.json$/.test(p)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!manifestPath) throw new PluginInstallError('There is no manifest.json in it, so it is not an Inkwright plugin.');
  const prefix = manifestPath.slice(0, -'manifest.json'.length);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [raw, bytes] of input) {
    const p = raw.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (!rel || rel.split('/').some((s) => s === '..' || s.startsWith('.')) || !ALLOWED.test(rel)) continue;
    if (rel === 'data.json') continue; // a plugin's storage belongs to the user, never to its package
    total += bytes.length;
    files.set(rel, bytes);
  }
  if (files.size > MAX_PLUGIN_FILES) throw new PluginInstallError(`It has ${files.size} files; plugins may have at most ${MAX_PLUGIN_FILES}.`);
  if (total > MAX_PLUGIN_BYTES) throw new PluginInstallError(`It is ${(total / 1048576).toFixed(1)} MB; plugins may be at most ${MAX_PLUGIN_BYTES / 1048576} MB.`);
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(files.get('manifest.json')!));
  } catch (e) {
    throw new PluginInstallError(`Its manifest.json is not valid JSON: ${(e as Error).message}`);
  }
  const r = validateManifest(json);
  if (!r.ok) throw new PluginInstallError(`Its manifest has problems: ${r.errors.join(' ')}`);
  if (!files.has(r.manifest.entry)) throw new PluginInstallError(`Its code (${r.manifest.entry}) is missing.`);
  if (compareVersions(appVersion, r.manifest.minAppVersion) < 0) throw new PluginInstallError(`${r.manifest.name} needs Inkwright ${r.manifest.minAppVersion} or later; this is ${appVersion}.`);
  // Keep the normalized manifest so what we store is what we validated.
  files.set('manifest.json', enc.encode(`${JSON.stringify(json, null, 2)}\n`));
  return { manifest: r.manifest, files, source };
}

/** Reads a .zip into files (deflate via the platform's DecompressionStream). */
export async function packageFromZip(bytes: Uint8Array, name: string, appVersion: string): Promise<PluginPackage> {
  const { readZip } = await import('@inkwright/sync');
  let entries;
  try {
    entries = await readZip(bytes);
  } catch (e) {
    throw new PluginInstallError(`That is not a readable .zip file: ${(e as Error).message}`);
  }
  return packageFromFiles(new Map(entries.map((e) => [e.path, e.bytes])), { kind: 'zip', name }, appVersion);
}

/** Files picked with a folder picker (`webkitRelativePath` keeps their place in the folder). */
export async function packageFromFolder(files: File[], appVersion: string): Promise<PluginPackage> {
  const map = new Map<string, Uint8Array>();
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (f.size > MAX_PLUGIN_BYTES) throw new PluginInstallError(`${f.name} is too large for a plugin.`);
    map.set(rel, new Uint8Array(await f.arrayBuffer()));
  }
  const top = [...map.keys()][0]?.split('/')[0] ?? 'folder';
  return packageFromFiles(map, { kind: 'folder', name: top }, appVersion);
}

/**
 * From a URL: a .zip, a manifest.json, or a folder (then `<url>/manifest.json`). The entry is
 * fetched relative to the manifest; plugins are single ES modules, so nothing else is needed.
 */
export async function packageFromUrl(url: string, appVersion: string, fetchFn: typeof fetch = fetch): Promise<PluginPackage> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new PluginInstallError('That is not a web address.');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new PluginInstallError('Plugins are installed over https (http only from this computer).');
  const get = async (target: URL): Promise<Uint8Array> => {
    let res: Response;
    try {
      res = await fetchFn(target.href, { credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      throw new PluginInstallError(`Could not download ${target.href}: ${(e as Error).message}. The site must allow downloads from other apps (CORS).`);
    }
    if (!res.ok) throw new PluginInstallError(`Downloading ${target.href} failed (HTTP ${res.status}).`);
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > MAX_PLUGIN_BYTES) throw new PluginInstallError('The download is too large for a plugin.');
    return b;
  };
  if (/\.zip$/i.test(u.pathname)) return { ...(await packageFromZip(await get(u), u.pathname.split('/').pop()!, appVersion)), source: { kind: 'url', url: u.href } };
  const manifestUrl = /\.json$/i.test(u.pathname) ? u : new URL(`${u.pathname.replace(/\/?$/, '/')}manifest.json${u.search}`, u);
  const manifestBytes = await get(manifestUrl);
  let manifest: PluginManifest;
  try {
    const r = validateManifest(JSON.parse(dec.decode(manifestBytes)));
    if (!r.ok) throw new PluginInstallError(`Its manifest has problems: ${r.errors.join(' ')}`);
    manifest = r.manifest;
  } catch (e) {
    if (e instanceof PluginInstallError) throw e;
    throw new PluginInstallError(`${manifestUrl.href} is not a plugin manifest: ${(e as Error).message}`);
  }
  const files = new Map<string, Uint8Array>([['manifest.json', manifestBytes], [manifest.entry, await get(new URL(manifest.entry, manifestUrl))]]);
  for (const extra of ['README.md']) {
    try {
      files.set(extra, await get(new URL(extra, manifestUrl)));
    } catch {
      /* optional */
    }
  }
  return packageFromFiles(files, { kind: 'url', url: manifestUrl.href }, appVersion);
}

/** Where to look for a newer version: the manifest's updateUrl, else the URL it came from. */
export function updateSourceOf(manifest: PluginManifest, source: PluginSource): string | null {
  if (manifest.updateUrl) return manifest.updateUrl;
  return source.kind === 'url' ? source.url : null;
}
