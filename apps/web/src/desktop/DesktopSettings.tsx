import { useEffect, useState, type ReactNode } from 'react';
import { Copy, Download, FolderOpen, RefreshCw } from 'lucide-react';
import { useApp } from '../state/app.ts';
import { Switch } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { desktopInfo, invoke, isDesktop, mcpConfigure, mcpStatus, type DesktopInfo, type McpInfo } from './bridge.ts';
import { autostartEnabled, setAutostart } from './integration.ts';
import '../recall/recall.css';

/** Settings › Desktop app: the vault folder, launch at login, the tray, agents (MCP) and updates. */

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

const RELEASES = 'https://github.com/dev-null-k2/inkwright/releases/latest';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    useApp.getState().toast({ text: `${what} copied.` });
  } catch {
    useApp.getState().fail('Couldn’t copy; select the text and copy it instead.');
  }
}

export function DesktopSettings() {
  if (!isDesktop) {
    return (
      <Group title="Inkwright for your computer" note="The desktop app is the same Inkwright, with your notes in a folder on disk that other tools can read.">
        <p>The desktop app for macOS, Windows and Linux adds what a browser can’t:</p>
        <ul className="dk-list">
          <li>Keeps running in the tray, so routines, the journal and agents keep working with the window closed.</li>
          <li>The memory timeline: what was on your screen, searchable, redacted and kept only on your devices.</li>
          <li>Open PDFs with Inkwright, inkwright:// links from other apps, and launch at login.</li>
        </ul>
        <div className="row-buttons"><a className="btn btn-sm" href={RELEASES} target="_blank" rel="noreferrer"><Download size={15} aria-hidden /> Download</a></div>
      </Group>
    );
  }
  return <DesktopOnly />;
}

function DesktopOnly() {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [folder, setFolder] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [checking, setChecking] = useState(false);
  const fail = (e: unknown) => useApp.getState().fail((e as Error)?.message ?? String(e));

  useEffect(() => {
    void desktopInfo().then((i) => { setInfo(i); setFolder(i.vaultDir); }).catch(fail);
    void autostartEnabled().then(setAuto).catch(() => setAuto(false));
    const poll = () => void mcpStatus().then(setMcp).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);
  if (!info) return null;

  const moveVault = async () => {
    const ok = await askConfirm('Use another vault folder?', `Inkwright will open the notes in ${folder}. Nothing is moved or deleted: your current notes stay in ${info.vaultDir}. Inkwright reloads.`, 'Use this folder');
    if (!ok) return;
    try {
      await invoke('vault_dir_set', { path: folder });
      location.reload();
    } catch (e) { fail(e); }
  };
  const checkUpdates = async () => {
    setChecking(true);
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const u = await check();
      useApp.getState().toast({ text: u ? `Inkwright ${u.version} is available; it downloads in the background.` : 'Inkwright is up to date.' });
    } catch (e) { fail(e); } finally { setChecking(false); }
  };
  const url = mcp?.url ?? `http://127.0.0.1:${info.mcpPort}/mcp`;
  const token = mcp?.token ?? '';
  const claudeCode = `claude mcp add --transport http inkwright ${url} --header "Authorization: Bearer ${showToken ? token : '<token>'}"`;

  return (
    <>
      <Group title="Your notes" note="A plain folder (docs/VAULT_FORMAT.md): back it up, sync it with any folder sync, or open it in other tools. Choosing another folder opens the notes in it; nothing is copied or deleted.">
        <form className="rc-set-add" onSubmit={(e) => { e.preventDefault(); if (folder.trim() && folder.trim() !== info.vaultDir) void moveVault(); }}>
          <FolderOpen size={16} aria-hidden className="dk-icon" />
          <input value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Vault folder" spellCheck={false} />
          <button type="submit" className="btn btn-sm" disabled={!folder.trim() || folder.trim() === info.vaultDir}>Use</button>
        </form>
      </Group>

      <Group title="On this computer">
        <Switch label="Open at login" hint="Starts quietly in the tray." checked={!!auto} onChange={(v) => void setAutostart(v).then(() => setAuto(v)).catch(fail)} />
        <Switch label="Keep running when the window is closed" hint="Routines, the journal, the memory timeline and agents keep working from the tray. Quit from the tray menu." checked={info.keepInTray} onChange={(v) => void invoke('set_keep_in_tray', { keep: v }).then(() => setInfo({ ...info, keepInTray: v })).catch(fail)} />
      </Group>

      <Group title="Agents (MCP)" note={<>Claude, Cursor and other MCP clients reach your notes at this address while Inkwright runs, only from this computer, and only with the token. Your AI policy applies to them (Settings › AI). See docs/AGENTS.md.</>}>
        <Switch label="Let agents on this computer use my notes" checked={mcp?.enabled ?? info.mcpEnabled} onChange={(v) => void mcpConfigure({ enabled: v }).then(setMcp).catch(fail)} />
        {mcp?.enabled && (
          <>
            <p className="rc-set-status" data-testid="mcp-status">{!info.sidecarBundled ? 'This build has no MCP server bundled (run npm run sidecar in apps/desktop).' : mcp.running ? `Running at ${url}` : mcp.error ?? 'Starting…'}</p>
            <div className="field-row">
              <span className="row-label">Token</span>
              <span className="row-buttons">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</button>
                <button type="button" className="btn btn-sm" onClick={() => void copy(token, 'Token')}><Copy size={14} aria-hidden /> Copy</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void askConfirm('Make a new token?', 'Agents set up with the old token stop working until you give them the new one.', 'New token').then(async (ok) => { if (ok) setMcp(await mcpConfigure({ enabled: true, newToken: true })); }).catch(fail)}>New token</button>
              </span>
            </div>
            {showToken && <p className="rc-set-code">{token}</p>}
            <p className="row-hint">Claude Code:</p>
            <p className="rc-set-code">{claudeCode}</p>
            <div className="row-buttons"><button type="button" className="btn btn-sm" onClick={() => void copy(claudeCode.replace('<token>', token), 'Command')}><Copy size={14} aria-hidden /> Copy command</button></div>
          </>
        )}
      </Group>

      <Group title="Updates" note={info.updatesConfigured ? 'Updates are checked daily, downloaded in the background and installed when you choose to restart. Every update is signed; one that isn’t is refused.' : 'This build has no update key, so it doesn’t update itself. Builds from the project’s releases do.'}>
        <div className="field-row">
          <span className="row-label">Inkwright {info.version} · {info.os} {info.arch}</span>
          {info.updatesConfigured && <button type="button" className="btn btn-sm" disabled={checking} onClick={() => void checkUpdates()}><RefreshCw size={14} aria-hidden /> Check now</button>}
        </div>
      </Group>
    </>
  );
}
