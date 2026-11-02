import { PalettePicker } from '../ui/PalettePicker.tsx';
import { FeelPanel } from '../ui/FeelPanel.tsx';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Bot, Check, Cloud, Copy, Download, ExternalLink, FolderOpen, Hand, Info, KeyRound, Palette, PenLine, Plug, Plus, RefreshCw, Trash2, Upload, Vibrate, ScanText,
} from 'lucide-react';
import { PROVIDERS, getProviderInfo, type ProviderInfo } from '@inkstone/ai';
import { PAGE_SIZE_PRESETS, newId } from '@inkstone/core';
import { useApp } from '../state/app.ts';
import { DEFAULT_SETTINGS, useSettings, type AIProviderConfig } from '../state/settings.ts';
import { IconButton, Segmented, Slider, Switch, cx, relativeTime, useMediaQuery } from '../ui/primitives.tsx';
import { PaperPicker } from '../ui/NewNoteSheet.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { APP_VERSION, isArtifact, isNative, modKey, nativePlatform } from '../platform/env.ts';
import { hasNativePlugin } from '../platform/native.ts';
import { getSecret, setSecret } from '../lib/secrets.ts';
import { CLAUDE_BUILTIN_ID, hasBuiltinClaude, providerFromConfig } from '../lib/ai.ts';
import { signIn, signOut } from '../lib/google.ts';
import { chooseSyncFolder, folderSyncSupported, resetSyncEngines, syncNow, useSync } from '../lib/sync.ts';
import { saveFile, pickFiles } from '../platform/files.ts';
import { importFiles } from '../lib/actions.ts';
import { BrandMark } from '../ui/Brand.tsx';
import { Fingerprint } from 'lucide-react';
import { AuthorshipSection } from '../authorship/AuthorshipSection.tsx';
import { AgentSettings } from '../ui/agent/AgentSettings.tsx';
import { Waypoints } from 'lucide-react';
import { KnowledgeSettings } from '../ui/knowledge/KnowledgeSettings.tsx';
import { LocalAISettings } from '../ui/LocalAISettings.tsx';

const SECTIONS = [
  { id: 'writing', label: 'Writing feel', icon: <Vibrate size={17} /> },
  { id: 'input', label: 'Pen & touch', icon: <Hand size={17} /> },
  { id: 'handwriting', label: 'Handwriting', icon: <ScanText size={17} /> },
  { id: 'ai', label: 'AI', icon: <Bot size={17} /> },
  { id: 'sync', label: 'Account & sync', icon: <Cloud size={17} /> },
  { id: 'agents', label: 'Agents (MCP)', icon: <Plug size={17} /> },
  { id: 'authorship', label: 'Authorship', icon: <Fingerprint size={17} /> },
  { id: 'appearance', label: 'Appearance & paper', icon: <Palette size={17} /> },
  { id: 'knowledge', label: 'Notes, links & Obsidian', icon: <Waypoints size={17} /> },
  { id: 'about', label: 'About', icon: <Info size={17} /> },
] as const;

export function Settings({ section }: { section?: string }) {
  const navigate = useApp((s) => s.navigate);
  const wide = useMediaQuery('(min-width: 900px)');
  const [active, setActive] = useState(section ?? (wide ? 'writing' : ''));
  useEffect(() => { if (section) setActive(section); }, [section]);
  const current = SECTIONS.find((s) => s.id === active);

  const back = () => {
    if (!wide && active) setActive('');
    else navigate({ name: 'library' });
  };

  return (
    <div className={cx('settings', wide && 'is-wide')}>
      <header className="set-top">
        <IconButton label="Back" onClick={back}><ArrowLeft size={20} /></IconButton>
        <h1>{!wide && current ? current.label : 'Settings'}</h1>
      </header>
      <div className="set-body">
        {(wide || !active) && (
          <nav className="set-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" className={cx('nav-item', active === s.id && 'is-on')} onClick={() => setActive(s.id)}>
                <span className="nav-icon">{s.icon}</span><span className="nav-label">{s.label}</span>
              </button>
            ))}
          </nav>
        )}
        {active && (
          <main className="set-main">
            {active === 'writing' && <WritingSection />}
            {active === 'input' && <InputSection />}
            {active === 'handwriting' && <HandwritingSection />}
            {active === 'ai' && <AISection />}
            {active === 'sync' && <SyncSection />}
            {active === 'agents' && <AgentsSection />}
            {active === 'authorship' && <AuthorshipSection />}
            {active === 'appearance' && <AppearanceSection />}
            {active === 'knowledge' && <KnowledgeSettings />}
            {active === 'about' && <AboutSection />}
          </main>
        )}
      </div>
    </div>
  );
}

function Group({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

function WritingSection() {
  const s = useSettings();
  return (
    <>
      <Group title="Paper feel" note={hasNativePlugin
        ? 'Grain is felt through the phone’s haptic motor as fine ticks spaced by distance, so slow strokes feel like individual paper fibres and fast strokes like a soft buzz. Pick “Toothy” paper for the strongest bite.'
        : 'The haptic grain needs the Inkstone Android app (it drives the phone’s motor directly). The writing sound works everywhere. For physical bite, a matte screen protector adds real friction.'}>
        <FeelPanel />
      </Group>
      <Group title="Pressure">
        <Slider label="Pressure response" value={s.input.pressureCurve} min={0.5} max={2} step={0.05} onChange={(v) => s.update((x) => ({ input: { ...x.input, pressureCurve: v } }))} format={(v) => (v < 0.9 ? 'Soft' : v > 1.1 ? 'Firm' : 'Natural')} />
      </Group>
    </>
  );
}

function InputSection() {
  const s = useSettings();
  const setInput = (p: Partial<typeof s.input>) => s.update((x) => ({ input: { ...x.input, ...p } }));
  return (
    <>
      <Group title="Pen button" note={isNative && nativePlatform === 'android'
        ? 'Works with the barrel button of USI pens (Moto Pen Ultra), S Pen and Bluetooth stylus buttons. Press once to switch, press again to switch back; hold it to use the tool only while held.'
        : 'Works with pens whose button the browser reports (barrel button, eraser end). In the Android app, Bluetooth pen buttons like the Moto Pen Ultra’s are supported too.'}>
        <label className="field-row">
          <span className="row-label">Pen button switches to</span>
          <select value={s.input.buttonAction} onChange={(e) => setInput({ buttonAction: e.target.value as any })}>
            <option value="eraser">Eraser (whole strokes)</option>
            <option value="precise">Eraser (precise)</option>
            <option value="lasso">Lasso</option>
            <option value="highlighter">Highlighter</option>
            <option value="none">Nothing</option>
          </select>
        </label>
      </Group>
      <Group title="Fingers">
        <label className="field-row">
          <span className="row-label">One finger</span>
          <Segmented label="One finger" value={s.input.fingerAction} onChange={(v) => setInput({ fingerAction: v })} options={[
            { value: 'scroll', label: 'Scrolls' }, { value: 'draw', label: 'Draws' }, { value: 'erase', label: 'Erases' },
          ]} />
        </label>
        <Switch label="Two-finger tap to undo, three to redo" checked={s.input.tapGestures} onChange={(v) => setInput({ tapGestures: v })} />
      </Group>
      <Group title="Gestures">
        <Switch label="Scribble to erase" hint="Scratch back and forth over ink to delete it" checked={s.input.scratchToErase} onChange={(v) => setInput({ scratchToErase: v })} />
        {isNative && nativePlatform === 'android' && <Switch label="Instant ink" hint="The newest part of each stroke is drawn natively, straight to the screen, so ink keeps up with the nib. Turn off if the tip ever looks offset." checked={s.input.instantInk} onChange={(v) => setInput({ instantInk: v })} />}
        <Switch label="Hold to perfect shapes" hint="Pause at the end of a line, circle, box or triangle to snap it" checked={s.input.holdToShape} onChange={(v) => setInput({ holdToShape: v })} />
        <Switch label="Smart ink suggestions" hint="After a pause, offer to turn a drawn grid into a table, solve “… =”, or add a circled date to your calendar" checked={s.smartInk.suggestions} onChange={(v) => s.update(() => ({ smartInk: { suggestions: v } }))} />
      </Group>
      <Group title="Keyboard shortcuts">
        <dl className="shortcuts">
          {[
            ['P / E / L / T', 'Pen, eraser, lasso, text'], ['1 – 9', 'Pens in the tray'], ['H / K', 'Pan, laser pointer'],
            [`${modKey}Z / ${modKey}⇧Z`, 'Undo / redo'], [`${modKey}C / X / V / D`, 'Copy, cut, paste, duplicate selection'],
            [`${modKey}A`, 'Select everything on the page'], [`${modKey}+ / − / 0`, 'Zoom in, out, fit width'], [`${modKey}F / ${modKey}N`, 'Search, new note'], [`${modKey}P`, 'Export PDF'],
          ].map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
        </dl>
      </Group>
    </>
  );
}

const LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['nl', 'Dutch'], ['hi', 'Hindi'], ['te', 'Telugu'], ['ta', 'Tamil'], ['zh-CN', 'Chinese (Simplified)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ar', 'Arabic'], ['ru', 'Russian']];

function HandwritingSection() {
  const s = useSettings();
  const r = s.recognition;
  const set = (p: Partial<typeof r>) => s.update((x) => ({ recognition: { ...x.recognition, ...p } }));
  return (
    <Group title="Handwriting recognition" note="Recognized text makes handwriting searchable, appears in the note’s Markdown file for other apps and agents, and powers AI features. Your ink is never changed.">
      <label className="field-row">
        <span className="row-label">Engine</span>
        <select value={r.engine} onChange={(e) => set({ engine: e.target.value as any })}>
          <option value="auto">Automatic (on-device when available)</option>
          <option value="native">On-device only</option>
          <option value="ai">My AI provider (vision)</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label className="field-row">
        <span className="row-label">Language</span>
        <select value={r.language} onChange={(e) => set({ language: e.target.value })}>
          {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <Switch label="Use AI automatically when nothing on-device is available" hint="Sends page images to your chosen AI provider after you pause writing" checked={r.autoAI} onChange={(v) => set({ autoAI: v })} />
    </Group>
  );
}

function AISection() {
  const s = useSettings();
  const [adding, setAdding] = useState(false);
  const providers = s.ai.providers;
  const builtin = hasBuiltinClaude();
  return (
    <>
      <LocalAISettings />
      <Group title="Your AI providers" note={isArtifact
        ? 'This live preview runs inside claude.ai, which only lets it talk to Claude. Keys for other providers work in the installed app and on the web version.'
        : 'Keys are encrypted with a key that never leaves this device and are never synced. Requests go straight from this device to the provider you choose.'}>
        {builtin && (
          <div className={cx('prov-row', (s.ai.activeId === CLAUDE_BUILTIN_ID || !s.ai.activeId) && 'is-active')}>
            <div className="prov-main">
              <span className="prov-name">Claude</span>
              <span className="muted">Built into this preview on claude.ai — no key needed</span>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => s.update((x) => ({ ai: { ...x.ai, activeId: CLAUDE_BUILTIN_ID } }))}>{s.ai.activeId === CLAUDE_BUILTIN_ID || !s.ai.activeId ? <><Check size={14} /> In use</> : 'Use'}</button>
          </div>
        )}
        {providers.map((p) => <ProviderRow key={p.id} cfg={p} />)}
        {!providers.length && !builtin && <p className="set-empty">No AI connected yet. Add one below; Google Gemini has a free tier and reads handwriting well.</p>}
        {adding ? <AddProvider onDone={() => setAdding(false)} /> : (
          <button type="button" className="btn add-row" onClick={() => setAdding(true)}><Plus size={16} /> Add an AI provider</button>
        )}
      </Group>
      <Group title="Safety">
        <Switch label="Ask before the assistant deletes or moves notes" checked={s.ai.confirmDestructive} onChange={(v) => s.update((x) => ({ ai: { ...x.ai, confirmDestructive: v } }))} />
      </Group>
      <AgentSettings />
    </>
  );
}

function ProviderRow({ cfg }: { cfg: AIProviderConfig }) {
  const s = useSettings();
  const toast = useApp((a) => a.toast);
  const info = getProviderInfo(cfg.providerId);
  const [testing, setTesting] = useState(false);
  const active = s.ai.activeId === cfg.id;
  const update = (p: Partial<AIProviderConfig>) => s.update((x) => ({ ai: { ...x.ai, providers: x.ai.providers.map((q) => (q.id === cfg.id ? { ...q, ...p } : q)) } }));
  const test = async () => {
    setTesting(true);
    try {
      const prov = await providerFromConfig(cfg);
      const r = await prov.chat({ model: cfg.model, messages: [{ role: 'user', content: 'Reply with just: ok' }], maxTokens: 16 });
      toast({ text: `${info?.label ?? cfg.label} works: “${r.text.trim().slice(0, 40)}”`, tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className={cx('prov-row', active && 'is-active')}>
      <div className="prov-main">
        <span className="prov-name">{info?.label ?? cfg.label}</span>
        <input className="prov-model" list={`models-${cfg.id}`} value={cfg.model} onChange={(e) => update({ model: e.target.value })} aria-label="Model" />
        <datalist id={`models-${cfg.id}`}>{info?.models.map((m) => <option key={m} value={m} />)}</datalist>
        {info?.needsBaseUrl || cfg.baseUrl ? <input className="prov-url" value={cfg.baseUrl ?? ''} placeholder={info?.defaultBaseUrl} onChange={(e) => update({ baseUrl: e.target.value })} aria-label="Base URL" /> : null}
      </div>
      <div className="prov-acts">
        <button type="button" className="btn btn-sm" disabled={testing} onClick={() => void test()}>{testing ? 'Testing…' : 'Test'}</button>
        <button type="button" className={cx('btn btn-sm', active && 'btn-primary')} onClick={() => s.update((x) => ({ ai: { ...x.ai, activeId: cfg.id } }))}>{active ? <><Check size={14} /> In use</> : 'Use'}</button>
        <IconButton label="Remove provider" onClick={async () => {
          if (!(await askConfirm(`Remove ${info?.label ?? cfg.label}?`, 'Its key is deleted from this device.', 'Remove', true))) return;
          await setSecret(`ai-key:${cfg.id}`, null).catch(() => {});
          s.update((x) => ({ ai: { ...x.ai, providers: x.ai.providers.filter((q) => q.id !== cfg.id), activeId: x.ai.activeId === cfg.id ? null : x.ai.activeId } }));
        }}><Trash2 size={16} /></IconButton>
      </div>
    </div>
  );
}

function AddProvider({ onDone }: { onDone: () => void }) {
  const s = useSettings();
  const [pid, setPid] = useState<string>('gemini');
  const info = getProviderInfo(pid) as ProviderInfo;
  const [key, setKey] = useState('');
  const [model, setModel] = useState(info.defaultModel);
  const [baseUrl, setBaseUrl] = useState('');
  useEffect(() => { setModel(info.defaultModel); setBaseUrl(''); }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const toast = useApp((a) => a.toast);
  const save = async () => {
    const id = newId();
    try {
      if (key.trim()) await setSecret(`ai-key:${id}`, key.trim());
    } catch (e) {
      toast({ text: `Couldn't save the key securely on this device: ${(e as Error).message}`, tone: 'error' });
      return;
    }
    const cfg: AIProviderConfig = { id, providerId: pid, label: info.label, model: model.trim() || info.defaultModel, baseUrl: baseUrl.trim() || undefined, hasKey: !!key.trim() };
    s.update((x) => ({ ai: { ...x.ai, providers: [...x.ai.providers, cfg], activeId: x.ai.activeId && x.ai.activeId !== CLAUDE_BUILTIN_ID ? x.ai.activeId : id } }));
    onDone();
  };
  return (
    <div className="add-provider">
      <label className="field">
        <span className="field-label">Provider</span>
        <select value={pid} onChange={(e) => setPid(e.target.value)}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}{p.local ? ' (on your computer)' : ''}</option>)}
        </select>
      </label>
      {info.hint && <p className="muted small">{info.hint}</p>}
      {info.needsKey && (
        <label className="field">
          <span className="field-label">API key {info.keyUrl && <a href={info.keyUrl} target="_blank" rel="noreferrer">Get a key <ExternalLink size={12} /></a>}</span>
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" />
        </label>
      )}
      {(info.needsBaseUrl || info.local || pid === 'custom' || pid === 'azure-openai') && (
        <label className="field">
          <span className="field-label">{pid === 'azure-openai' ? 'Deployment endpoint' : 'Server URL'}</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={info.defaultBaseUrl || 'https://…/v1'} />
        </label>
      )}
      <label className="field">
        <span className="field-label">Model</span>
        <input list="add-models" value={model} onChange={(e) => setModel(e.target.value)} />
        <datalist id="add-models">{info.models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      <div className="row-end">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={info.needsKey && !key.trim()} onClick={() => void save()}><KeyRound size={15} /> Save provider</button>
      </div>
    </div>
  );
}

function SyncSection() {
  const s = useSettings();
  const sync = useSync();
  const toast = useApp((a) => a.toast);
  const vault = useApp((a) => a.vault);
  const sy = s.sync;
  const [davPass, setDavPass] = useState('');
  const set = (p: Partial<typeof sy>) => { s.update((x) => ({ sync: { ...x.sync, ...p } })); resetSyncEngines(); };
  useEffect(() => { void getSecret('webdav.password').then((v) => setDavPass(v ? '••••••••' : '')); }, []);
  const doSignIn = async () => {
    try { const a = await signIn(); toast({ text: `Signed in as ${a.email}`, tone: 'success' }); resetSyncEngines(); void syncNow(); }
    catch (e) { toast({ text: (e as Error).message, tone: 'error' }); }
  };
  return (
    <>
      {isArtifact && (
        <Group title="In this preview">
          <p>Notes in this preview stay in this browser. Google sign-in, Drive, WebDAV and folder sync work in the installed app and the web version, which can reach those services.</p>
        </Group>
      )}
      <Group title="Google account" note={<>Inkstone keeps your notes in a visible <b>{sy.drive.folderName || 'Inkstone'}</b> folder in your Google Drive and can only see files it created there. On a Mac with Google Drive for desktop, that folder appears in Finder, ready for Obsidian, Claude and other agents.</>}>
        {sy.account ? (
          <div className="account-row">
            {sy.account.picture ? <img src={sy.account.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{sy.account.name.slice(0, 1)}</span>}
            <div><div>{sy.account.name}</div><div className="muted">{sy.account.email}</div></div>
            <button type="button" className="btn btn-sm" onClick={() => void signOut()}>Sign out</button>
          </div>
        ) : (
          <button type="button" className="btn btn-google" onClick={() => void doSignIn()} disabled={!sy.googleClientId}>
            <GoogleG /> Sign in with Google
          </button>
        )}
        {!sy.googleClientId && (
          <label className="field">
            <span className="field-label">Google OAuth client ID <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Create one <ExternalLink size={12} /></a></span>
            <input value={sy.googleClientId} placeholder="1234-abc.apps.googleusercontent.com" onChange={(e) => set({ googleClientId: e.target.value.trim() })} />
            <span className="muted small">Google requires each app to register. Create a “Web application” client, add this page’s address as an authorized JavaScript origin, and enable the Google Drive API. See docs/GOOGLE_SETUP.md.</span>
          </label>
        )}
        {sy.account && (
          <>
            <Switch label="Sync with Google Drive" checked={sy.drive.enabled} onChange={(v) => set({ drive: { ...sy.drive, enabled: v } })} />
            <label className="field-row">
              <span className="row-label">Drive folder</span>
              <input value={sy.drive.folderName} onChange={(e) => set({ drive: { ...sy.drive, folderName: e.target.value } })} />
            </label>
          </>
        )}
      </Group>

      <Group title="Sync status">
        <div className="sync-status">
          <span className={cx('sync-dot', `is-${sync.status}`)} />
          <span>{sync.status === 'syncing' ? `Syncing${sync.progress ? ` ${sync.progress.done}/${sync.progress.total}` : '…'}` : sync.status === 'error' ? sync.message : sync.status === 'offline' ? 'Offline' : sync.lastSync ? `Up to date · ${relativeTime(sync.lastSync)}` : 'Not synced yet'}</span>
          <button type="button" className="btn btn-sm" onClick={() => void syncNow()}><RefreshCw size={14} /> Sync now</button>
        </div>
      </Group>

      <Group title="WebDAV (Nextcloud, ownCloud, Synology…)">
        <Switch label="Sync with a WebDAV server" checked={sy.webdav.enabled} onChange={(v) => set({ webdav: { ...sy.webdav, enabled: v } })} />
        <label className="field"><span className="field-label">Folder URL</span><input value={sy.webdav.url} placeholder="https://cloud.example.com/remote.php/dav/files/me/Inkstone/" onChange={(e) => set({ webdav: { ...sy.webdav, url: e.target.value } })} /></label>
        <div className="field-pair">
          <label className="field"><span className="field-label">Username</span><input value={sy.webdav.username} onChange={(e) => set({ webdav: { ...sy.webdav, username: e.target.value } })} /></label>
          <label className="field"><span className="field-label">App password</span><input type="password" value={davPass} onChange={(e) => setDavPass(e.target.value)} onBlur={() => { if (davPass && !davPass.startsWith('•')) setSecret('webdav.password', davPass).then(resetSyncEngines, (e) => toast({ text: `Couldn't save the password: ${(e as Error).message}`, tone: 'error' })); }} /></label>
        </div>
      </Group>

      {folderSyncSupported && (
        <Group title="A folder on this computer" note="Pick your Google Drive, iCloud Drive, Dropbox or Obsidian folder and Inkstone keeps a copy of every note there.">
          <div className="sync-status">
            <FolderOpen size={17} />
            <span>{sy.folder.name ? `Syncing with “${sy.folder.name}”` : 'No folder chosen'}</span>
            <button type="button" className="btn btn-sm" onClick={async () => { try { await chooseSyncFolder(); void syncNow(); } catch (e) { if ((e as Error).name !== 'AbortError') toast({ text: (e as Error).message, tone: 'error' }); } }}>{sy.folder.name ? 'Change' : 'Choose folder'}</button>
            {sy.folder.name && <button type="button" className="btn btn-sm" onClick={() => set({ folder: { enabled: false, name: null, lastSync: null } })}>Stop</button>}
          </div>
        </Group>
      )}

      <Group title="Backup" note="A backup is a zip of your vault: plain JSON, SVG and Markdown files you can open anywhere.">
        <div className="row-buttons">
          <button type="button" className="btn" onClick={async () => {
            if (!vault) return;
            const { exportVaultZip } = await import('@inkstone/sync') as any;
            const bytes = await exportVaultZip(vault.fs);
            await saveFile(`Inkstone backup ${new Date().toISOString().slice(0, 10)}.zip`, bytes, 'application/zip');
          }}><Download size={16} /> Download backup</button>
          <button type="button" className="btn" onClick={async () => { const f = await pickFiles('.zip,application/zip', false); if (f.length) await importFiles(f); }}><Upload size={16} /> Restore from backup</button>
        </div>
      </Group>
    </>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function AgentsSection() {
  const toast = useApp((a) => a.toast);
  const folder = useSettings((s) => s.sync.drive.folderName) || 'Inkstone';
  const email = useSettings((s) => s.sync.account?.email) ?? 'you@gmail.com';
  const vaultPath = `~/Library/CloudStorage/GoogleDrive-${email}/My Drive/${folder}`;
  const config = JSON.stringify({ mcpServers: { inkstone: { command: 'npx', args: ['-y', '@inkstone/mcp-server', '--vault', vaultPath] } } }, null, 2);
  const claudeCode = `claude mcp add inkstone -- npx -y @inkstone/mcp-server --vault "${vaultPath}"`;
  const copy = (t: string) => { void navigator.clipboard?.writeText(t).then(() => toast({ text: 'Copied' })); };
  return (
    <>
      <Group title="Let any AI agent use your notes" note="The Inkstone MCP server reads the synced vault folder on your computer. Agents can search, read (including page images), create notes, append text, tag and organize — the same tools the in-app assistant uses. Add --read-only to only allow reading.">
        <ol className="steps">
          <li>Turn on Google Drive sync (or folder sync) so your notes are on your Mac.</li>
          <li>Add the server to your agent:</li>
        </ol>
        <div className="code-block">
          <div className="code-head"><span>Claude Desktop — claude_desktop_config.json</span><button type="button" className="btn btn-sm" onClick={() => copy(config)}><Copy size={13} /> Copy</button></div>
          <pre>{config}</pre>
        </div>
        <div className="code-block">
          <div className="code-head"><span>Claude Code</span><button type="button" className="btn btn-sm" onClick={() => copy(claudeCode)}><Copy size={13} /> Copy</button></div>
          <pre>{claudeCode}</pre>
        </div>
        <p className="muted small">Cursor, Windsurf, VS Code, ChatGPT desktop and other MCP clients use the same command. For remote agents, run the server with <code>--http 8787 --token &lt;secret&gt;</code>.</p>
      </Group>
    </>
  );
}

function AppearanceSection() {
  const s = useSettings();
  return (
    <>
      <Group title="Theme">
        <PalettePicker value={s.palette ?? 'duan'} onChange={(v) => s.update(() => ({ palette: v }))} />
        <Segmented label="Light or dark" value={s.theme} onChange={(v) => s.update(() => ({ theme: v }))} options={[
          { value: 'system', label: 'Match device' }, { value: 'light', label: 'Day' }, { value: 'dark', label: 'Night' },
        ]} />
      </Group>
      <Group title="Paper for new notes">
        <PaperPicker paper={s.defaultPaper} onChange={(p) => s.update(() => ({ defaultPaper: p }))} size={s.defaultPageSize} kind="paged" />
        <label className="field-row">
          <span className="row-label">Page size</span>
          <select value={s.defaultPageSize.name} onChange={(e) => { const p = PAGE_SIZE_PRESETS.find((x) => x.name === e.target.value); if (p) s.update(() => ({ defaultPageSize: p })); }}>
            {PAGE_SIZE_PRESETS.map((p) => <option key={p.name}>{p.name}</option>)}
          </select>
        </label>
      </Group>
      <Group title="Library">
        <label className="field-row">
          <span className="row-label">Sort notes by</span>
          <Segmented label="Sort" value={s.library.sort} onChange={(v) => s.update((x) => ({ library: { ...x.library, sort: v } }))} options={[
            { value: 'updated', label: 'Last edited' }, { value: 'created', label: 'Created' }, { value: 'title', label: 'Title' },
          ]} />
        </label>
      </Group>
    </>
  );
}

function AboutSection() {
  const s = useSettings();
  const vault = useApp((a) => a.vault);
  const notes = useApp((a) => a.notes);
  const [usage, setUsage] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    void navigator.storage?.estimate?.().then((e) => setUsage(e.usage != null ? `${(e.usage / 1048576).toFixed(1)} MB used on this device` : null)).catch(() => {});
  }, []);
  return (
    <>
      <div className="about-head">
        <BrandMark size={52} />
        <div>
          <h2 className="about-name">Inkstone</h2>
          <p className="muted">Version {APP_VERSION} · {isNative ? `${nativePlatform} app` : isArtifact ? 'live preview' : 'web app'}</p>
        </div>
      </div>
      <Group title="Your data">
        <p>{notes.length} notes · {vault?.persistent ? 'stored on this device' : 'this session only (storage blocked)'}{usage ? ` · ${usage}` : ''}</p>
        <p className="muted small">Everything is plain files in an open format (docs/VAULT_FORMAT.md). No account is required and nothing is sent anywhere unless you turn on sync or use AI.</p>
      </Group>
      <Group title="Reset">
        <button type="button" className="btn btn-danger-ghost" onClick={async () => { if (await askConfirm('Reset settings?', 'Pens, gestures, feel and AI choices go back to defaults. Your notes and saved keys are not touched.', 'Reset', true)) s.update(() => ({ ...DEFAULT_SETTINGS, ai: s.ai, sync: s.sync })); }}>Reset settings to defaults</button>
      </Group>
      <p className="muted small"><PenLine size={13} /> Made for people who think with a pen.</p>
    </>
  );
}
