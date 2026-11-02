import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ChevronDown, Download, FolderOpen, Link2, Puzzle, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { PERMISSION_INFO, describeScope, type Permission, type PluginManifest } from '@inkwright/plugin-api';
import { Dialog, Switch, cx } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { useApp } from '../state/app.ts';
import { APP_VERSION } from '../platform/env.ts';
import { pickFiles } from '../platform/files.ts';
import { CATALOG } from './catalog.ts';
import { PluginInstallError, packageFromFolder, packageFromUrl, packageFromZip } from './install.ts';
import type { PluginPackage } from './store.ts';
import {
  applyUpdate,
  checkForUpdate,
  grantedPermissions,
  installPackage,
  pluginSettings,
  reloadPlugins,
  savePluginSettings,
  setPermission,
  setPluginEnabled,
  uninstallPlugin,
  usePlugins,
  type LoadedPlugin,
} from './host.ts';

// ---- Permission prompt -----------------------------------------------------------------------------

interface PromptReq {
  manifest: PluginManifest;
  /** For updates: only these are new; the rest stay as they were. */
  added?: Permission[];
  resolve(granted: Permission[] | null): void;
}

const usePrompt = create<{ req: PromptReq | null }>(() => ({ req: null }));

/**
 * Shows what a plugin may do and adds before it is installed (or what an update adds). Resolves
 * to the permissions the user left ticked, or null when they cancel.
 */
export function askPluginPermissions(manifest: PluginManifest, added?: Permission[]): Promise<Permission[] | null> {
  return new Promise((resolve) => usePrompt.setState({ req: { manifest, ...(added ? { added } : {}), resolve } }));
}

export function contributionSummary(m: PluginManifest): string[] {
  const c = m.contributes;
  const out: string[] = [];
  if (c.commands?.length) out.push(`Commands: ${c.commands.map((x) => x.title).join(', ')}`);
  if (c.panels?.length) out.push(`Panels: ${c.panels.map((x) => x.title).join(', ')}`);
  if (c.aiTools?.length) out.push(`Assistant tools: ${c.aiTools.map((x) => x.name).join(', ')}`);
  if (c.importers?.length) out.push(`Importers: ${c.importers.map((x) => `${x.title} (.${x.extensions.join(', .')})`).join(', ')}`);
  if (c.exporters?.length) out.push(`Exporters: ${c.exporters.map((x) => `${x.title} (.${x.extension})`).join(', ')}`);
  if (c.settings?.length) out.push(`Settings: ${c.settings.map((x) => x.title).join(', ')}`);
  return out;
}

function PermissionList({ manifest, perms, checked, onChange }: { manifest: PluginManifest; perms: Permission[]; checked: Set<Permission>; onChange?: (p: Permission, on: boolean) => void }) {
  if (!perms.length) return <p className="muted small">It asks for no permissions: it can only use its own storage and settings, and run when you choose one of its commands.</p>;
  return (
    <ul className="plg-perms">
      {perms.map((p) => {
        const info = PERMISSION_INFO[p];
        const detail = p === 'network' ? `${info.description} ${manifest.network?.hosts.includes('*') ? 'Any https website.' : (manifest.network?.hosts ?? []).join(', ')}` : p.startsWith('notes:') ? `${info.description} Scope: ${describeScope(manifest.noteScope)}.` : info.description;
        return (
          <li key={p} className={cx('plg-perm', `is-${info.risk}`)}>
            {onChange ? <Switch label={info.label} hint={detail} checked={checked.has(p)} onChange={(v) => onChange(p, v)} /> : <><b>{info.label}</b><span className="muted small">{detail}</span></>}
          </li>
        );
      })}
    </ul>
  );
}

export function PluginPermissionPrompt() {
  const req = usePrompt((s) => s.req);
  const [checked, setChecked] = useState<Set<Permission>>(new Set());
  useEffect(() => { if (req) setChecked(new Set(req.added ?? req.manifest.permissions)); }, [req]);
  if (!req) return null;
  const m = req.manifest;
  const close = (v: Permission[] | null) => { usePrompt.setState({ req: null }); req.resolve(v); };
  const perms = req.added ?? m.permissions;
  const adds = contributionSummary(m);
  return (
    <Dialog open wide title={req.added ? `Update ${m.name}?` : `Install ${m.name}?`} onClose={() => close(null)} actions={<>
      <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
      <button type="button" className="btn btn-primary" autoFocus onClick={() => close([...checked])}><ShieldCheck size={15} /> {req.added ? 'Update' : 'Install'}</button>
    </>}>
      <p className="plg-by">{m.version} · by {m.author}</p>
      <p>{m.description}</p>
      <h3 className="plg-h">{req.added ? 'The new version also asks to' : 'It asks to'}</h3>
      <PermissionList manifest={m} perms={perms} checked={checked} onChange={(p, on) => setChecked((s) => { const n = new Set(s); if (on) n.add(p); else n.delete(p); return n; })} />
      {adds.length > 0 && <><h3 className="plg-h">It adds</h3><ul className="plg-adds">{adds.map((a) => <li key={a}>{a}</li>)}</ul></>}
      <p className="muted small">Plugins run in a sandbox: they can’t see your files, keys or other notes beyond what you allow here, and you can take any permission back later in Settings › Plugins.</p>
    </Dialog>
  );
}

// ---- Settings › Plugins ----------------------------------------------------------------------------

async function installFlow(load: () => Promise<PluginPackage> | PluginPackage, toast: (t: { text: string; tone?: 'error' | 'success' }) => void): Promise<boolean> {
  let pkg: PluginPackage;
  try {
    pkg = await load();
  } catch (e) {
    toast({ text: e instanceof PluginInstallError ? e.message : `Couldn’t read the plugin: ${(e as Error).message}`, tone: 'error' });
    return false;
  }
  const existing = usePlugins.getState().plugins.find((p) => p.record.id === pkg.manifest.id);
  if (existing && !(await askConfirm(`Replace ${pkg.manifest.name}?`, `Version ${existing.record.version} is installed. Its settings and stored data are kept.`, 'Continue'))) return false;
  const granted = await askPluginPermissions(pkg.manifest);
  if (!granted) return false;
  await installPackage(pkg, granted);
  toast({ text: `${pkg.manifest.name} installed`, tone: 'success' });
  return true;
}

export function PluginsSettings() {
  const plugins = usePlugins((s) => s.plugins);
  const logLines = usePlugins((s) => s.log);
  const toast = useApp((a) => a.toast);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const folder = useRef<HTMLInputElement>(null);
  useEffect(() => { void reloadPlugins().catch(() => {}); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <>
      <PluginPermissionPrompt />
      <section className="set-group">
        <h2>Installed</h2>
        <div className="set-card">
          {plugins.length ? plugins.map((p) => <PluginCard key={p.record.id} p={p} />) : <p className="set-empty">No plugins yet. Browse the list below, or install one from a link, a .zip or a folder.</p>}
        </div>
        <p className="set-note">Plugins are kept in your vault, so they sync to your other devices with your notes.</p>
      </section>

      <section className="set-group">
        <h2>Browse</h2>
        <div className="set-card">
          {CATALOG.map((c) => {
            const installed = plugins.find((p) => p.record.id === c.id);
            return (
              <div key={c.id} className="plg-cat">
                <div className="plg-cat-main">
                  <span className="plg-name"><Puzzle size={15} /> {c.name}</span>
                  <span className="muted small">{c.description}</span>
                </div>
                <button type="button" className="btn btn-sm" disabled={busy || !!installed} onClick={() => void run(() => installFlow(() => c.load(APP_VERSION), toast))}>
                  {installed ? 'Installed' : <><Download size={14} /> Install</>}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="set-group">
        <h2>Install from elsewhere</h2>
        <div className="set-card">
          <form className="plg-url" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void run(async () => { if (await installFlow(() => packageFromUrl(url, APP_VERSION), toast)) setUrl(''); }); }}>
            <label className="field">
              <span className="field-label">Link to a plugin (its manifest.json, folder or .zip)</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/my-plugin/manifest.json" inputMode="url" autoComplete="off" />
            </label>
            <button type="submit" className="btn btn-sm" disabled={busy || !url.trim()}><Link2 size={14} /> Install</button>
          </form>
          <div className="row-buttons">
            <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
              const [f] = await pickFiles('.zip,application/zip', false);
              if (f) await installFlow(async () => packageFromZip(new Uint8Array(await f.arrayBuffer()), f.name, APP_VERSION), toast);
            })}><Upload size={16} /> From a .zip</button>
            <button type="button" className="btn" disabled={busy} onClick={() => folder.current?.click()}><FolderOpen size={16} /> From a folder</button>
            <input ref={folder} type="file" hidden multiple {...({ webkitdirectory: '' } as Record<string, string>)} data-testid="plugin-folder-input"
              onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) void run(() => installFlow(() => packageFromFolder(files, APP_VERSION), toast)); }} />
          </div>
        </div>
        <p className="set-note">Only install plugins from people you trust. Writing your own? See docs/PLUGINS.md and the template in examples/create-inkwright-plugin.</p>
      </section>

      {logLines.length > 0 && (
        <section className="set-group">
          <h2>Plugin messages</h2>
          <div className="set-card plg-log">
            {logLines.slice(-30).reverse().map((l, i) => <div key={i} className={cx('plg-log-line', `is-${l.level}`)}><span className="muted small">{new Date(l.at).toLocaleTimeString()} · {plugins.find((p) => p.record.id === l.pluginId)?.manifest?.name ?? l.pluginId}</span> {l.message}</div>)}
          </div>
        </section>
      )}
    </>
  );
}

function PluginCard({ p }: { p: LoadedPlugin }) {
  const [open, setOpen] = useState(false);
  const toast = useApp((a) => a.toast);
  const m = p.manifest;
  const granted = grantedPermissions(p);
  const name = m?.name ?? p.record.id;
  return (
    <div className="plg-card" data-plugin={p.record.id}>
      <div className="plg-head">
        <Switch label={name} hint={p.error ? p.error : `${p.record.version}${m ? ` · ${m.author}` : ''}${m ? ` — ${m.description}` : ''}`} checked={p.record.enabled && !p.error} onChange={(v) => void setPluginEnabled(p.record.id, v)} />
        <button type="button" className="mod-more" aria-expanded={open} onClick={() => setOpen(!open)}>Details <ChevronDown size={14} className={cx('mod-chev', open && 'is-open')} /></button>
      </div>
      {open && m && (
        <div className="plg-details">
          <h3 className="plg-h">Permissions</h3>
          <PermissionList manifest={m} perms={m.permissions} checked={granted} onChange={(perm, on) => void setPermission(p.record.id, perm, on)} />
          {contributionSummary(m).length > 0 && <><h3 className="plg-h">Adds</h3><ul className="plg-adds">{contributionSummary(m).map((a) => <li key={a}>{a}</li>)}</ul></>}
          {(m.contributes.settings?.length ?? 0) > 0 && <PluginSettingsForm id={p.record.id} manifest={m} />}
          <div className="row-buttons">
            <button type="button" className="btn btn-sm" onClick={async () => {
              const u = await checkForUpdate(p.record.id);
              if (u.error) return toast({ text: `Couldn’t check for updates: ${u.error}`, tone: 'error' });
              if (!u.package) return toast({ text: `${name} is up to date (${u.current}).` });
              const extra = u.added.length ? await askPluginPermissions(u.package.manifest, u.added) : [];
              if (extra === null) return;
              await applyUpdate(p.record.id, u.package, extra);
              toast({ text: `${name} updated to ${u.latest}`, tone: 'success' });
            }}><RefreshCw size={14} /> Check for update</button>
            <button type="button" className="btn btn-sm btn-danger-ghost" onClick={async () => {
              if (!(await askConfirm(`Uninstall ${name}?`, 'Its files, settings and stored data are removed from the vault (and your other devices after sync). Notes are not touched.', 'Uninstall', true))) return;
              await uninstallPlugin(p.record.id);
              toast({ text: `${name} uninstalled` });
            }}><Trash2 size={14} /> Uninstall</button>
          </div>
          <p className="muted small">Id {m.id} · plugin API {m.apiVersion} · needs Inkwright {m.minAppVersion}+ · from {p.record.source.kind === 'url' ? p.record.source.url : p.record.source.kind === 'catalog' ? 'the curated list' : p.record.source.name}</p>
        </div>
      )}
      {open && !m && (
        <div className="plg-details">
          <p className="muted small">{p.error}</p>
          <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => void uninstallPlugin(p.record.id)}><Trash2 size={14} /> Remove</button>
        </div>
      )}
    </div>
  );
}

function PluginSettingsForm({ id, manifest }: { id: string; manifest: PluginManifest }) {
  const [values, setValues] = useState<Record<string, string | number | boolean> | null>(null);
  const toast = useApp((a) => a.toast);
  useEffect(() => { void pluginSettings(id).then(setValues); }, [id]);
  if (!values) return null;
  const defs = manifest.contributes.settings ?? [];
  const value = (k: string) => values[k] ?? defs.find((d) => d.key === k)?.default;
  return (
    <form className="plg-settings" onSubmit={(e) => { e.preventDefault(); void savePluginSettings(id, values).then(() => toast({ text: 'Plugin settings saved', tone: 'success' })); }}>
      <h3 className="plg-h">Settings</h3>
      {defs.map((d) => d.type === 'boolean' ? (
        <Switch key={d.key} label={d.title} hint={d.description} checked={value(d.key) === true} onChange={(v) => setValues({ ...values, [d.key]: v })} />
      ) : (
        <label key={d.key} className="field">
          <span className="field-label">{d.title}</span>
          <input type={d.secret ? 'password' : d.type === 'number' ? 'number' : 'text'} autoComplete="off" value={String(value(d.key) ?? '')} name={d.key}
            onChange={(e) => setValues({ ...values, [d.key]: d.type === 'number' ? Number(e.target.value) : e.target.value })} />
          {d.description && <span className="muted small">{d.description}</span>}
        </label>
      ))}
      <div className="row-end"><button type="submit" className="btn btn-sm btn-primary">Save settings</button></div>
    </form>
  );
}
