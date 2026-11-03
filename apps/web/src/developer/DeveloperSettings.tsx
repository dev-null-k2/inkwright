import { useEffect, useState } from 'react';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { API_KEYS_FILE, API_SCOPES, createApiKey, decodeApiKeys, emptyApiKeys, encodeApiKeys, revokeApiKey, type ApiKeyRecord, type ApiScope } from '@inkwright/core';
import { PERMISSIONS, PERMISSION_INFO, type Permission } from '@inkwright/plugin-api';
import { Switch, cx, relativeTime } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { useApp } from '../state/app.ts';
import { scheduleSync } from '../lib/sync.ts';
import { useAutomation } from './automation.ts';

const SCOPE_TEXT: Record<ApiScope, string> = {
  'notes:read': 'Read notes, pages, search',
  'notes:write': 'Create and change notes',
  'routines:run': 'Run routines',
  webhooks: 'Manage webhooks',
  admin: 'Manage API keys',
  'federation:search': 'Team search only (for a teammate’s server)',
};

const LINKS: [string, string][] = [
  ['inkwright://new?title=Groceries&text=-%20milk%0A-%20eggs&tags=home', 'A new note with typed text and tags'],
  ['inkwright://open?note=<note id>&page=2', 'Open a note at a page (or ?title=…)'],
  ['inkwright://search?q=pricing', 'Search everything'],
  ['inkwright://capture?url=https://example.com&title=Example&text=a%20quote', 'Save a link with a quote'],
  ['inkwright://today', 'Today’s daily note'],
];

function Group({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

/** Settings › Developer: API keys, the automation API and the URL reference. */
export function DeveloperSettings() {
  return (
    <>
      <ApiKeys />
      <AutomationApi />
      <Links />
    </>
  );
}

function ApiKeys() {
  const vault = useApp((a) => a.vault);
  const toast = useApp((a) => a.toast);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(['notes:read']));
  const [shown, setShown] = useState<string | null>(null);

  const read = async () => {
    const text = await vault?.fs.readText(API_KEYS_FILE);
    try { return text ? decodeApiKeys(text) : emptyApiKeys(); } catch { return emptyApiKeys(); }
  };
  const refresh = async () => setKeys((await read()).keys);
  useEffect(() => { void refresh(); }, [vault]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!vault || !name.trim() || !scopes.size) return;
    const file = await read();
    const { key, record } = createApiKey({ name: name.trim(), scopes: [...scopes], now: Date.now(), createdBy: 'app' });
    await vault.fs.writeText(API_KEYS_FILE, encodeApiKeys({ ...file, keys: [...file.keys, record] }));
    scheduleSync();
    setShown(key);
    setName('');
    await refresh();
  };

  return (
    <Group title="API keys" note={<>For the local REST API that <code>inkwright-mcp --http</code> serves next to MCP (docs/API.md). Keys are stored in your vault only as a hash, so they sync to the computer running the server; the key itself is shown once.</>}>
      {shown && (
        <div className="dev-key-shown" role="status">
          <p>Copy this key now; it won’t be shown again.</p>
          <div className="code-block"><pre data-testid="new-api-key">{shown}</pre></div>
          <div className="row-buttons">
            <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(shown).then(() => toast({ text: 'Copied' }))}><Copy size={13} /> Copy</button>
            <button type="button" className="btn btn-sm" onClick={() => setShown(null)}>Done</button>
          </div>
        </div>
      )}
      {keys.map((k) => (
        <div key={k.id} className={cx('dev-key', !!k.revokedAt && 'is-revoked')}>
          <div className="dev-key-main">
            <span className="prov-name">{k.name}</span>
            <span className="muted small"><code>{k.prefix}_…</code> · {k.scopes.join(', ')} · created {relativeTime(k.createdAt)}{k.revokedAt ? ' · revoked' : k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''}</span>
          </div>
          {!k.revokedAt && (
            <button type="button" className="btn btn-sm btn-danger-ghost" onClick={async () => {
              if (!vault || !(await askConfirm(`Revoke “${k.name}”?`, 'Programs using it stop working as soon as the server sees the change.', 'Revoke', true))) return;
              await vault.fs.writeText(API_KEYS_FILE, encodeApiKeys(revokeApiKey(await read(), k.id, Date.now())));
              scheduleSync();
              await refresh();
            }}><Trash2 size={14} /> Revoke</button>
          )}
        </div>
      ))}
      {!keys.length && !shown && <p className="set-empty">No keys yet.</p>}
      <div className="dev-key-new">
        <label className="field">
          <span className="field-label">New key for</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shortcuts on my phone" />
        </label>
        <div className="dev-scopes" role="group" aria-label="Scopes">
          {API_SCOPES.map((s) => (
            <label key={s} className="dev-check">
              <input type="checkbox" checked={scopes.has(s)} onChange={(e) => setScopes((x) => { const n = new Set(x); if (e.target.checked) n.add(s); else n.delete(s); return n; })} />
              <span><code>{s}</code> <span className="muted small">{SCOPE_TEXT[s]}</span></span>
            </label>
          ))}
        </div>
        <div className="row-end"><button type="button" className="btn btn-primary btn-sm" disabled={!name.trim() || !scopes.size} onClick={() => void create()}><KeyRound size={14} /> Create key</button></div>
      </div>
    </Group>
  );
}

function AutomationApi() {
  const a = useAutomation();
  const [hosts, setHosts] = useState(a.hosts.join(', '));
  const set = (p: Partial<typeof a>) => useAutomation.setState(p);
  return (
    <Group title="Automation API" note={<>Scripts on this page — browser extensions, userscripts, the developer console — get <code>window.inkwright</code>, the plugin API with the permissions ticked here. Off by default; only turn it on for code you trust.</>}>
      <Switch label="Turn on window.inkwright" hint="Same calls as plugins: notes, editor, events, commands, storage" checked={a.enabled} onChange={(v) => set({ enabled: v })} />
      {a.enabled && (
        <>
          {PERMISSIONS.map((p: Permission) => (
            <Switch key={p} label={PERMISSION_INFO[p].label} hint={PERMISSION_INFO[p].description} checked={a.permissions.includes(p)}
              onChange={(v) => set({ permissions: v ? [...new Set([...a.permissions, p])] : a.permissions.filter((x) => x !== p) })} />
          ))}
          {a.permissions.includes('network') && (
            <label className="field">
              <span className="field-label">Sites it may reach</span>
              <input value={hosts} onChange={(e) => setHosts(e.target.value)} onBlur={() => set({ hosts: hosts.split(',').map((h) => h.trim()).filter(Boolean) })} placeholder="https://hooks.example.com, https://*.example.org" />
            </label>
          )}
          <div className="code-block"><pre>{`await inkwright.notes.list({ tag: 'work' })\ninkwright.events.on('note.updated', (e) => console.log(e.title))`}</pre></div>
        </>
      )}
    </Group>
  );
}

function Links() {
  const toast = useApp((a) => a.toast);
  const base = `${location.origin}${location.pathname}`;
  return (
    <Group title="Links from other apps" note={<>The Android app opens <code>inkwright://</code> links; the installed web app also handles <code>web+inkwright://</code>, and any link to <code>{base}?action=new&amp;title=…</code> works in a browser. Links can create, open and search notes; they never delete or share anything.</>}>
      <dl className="dev-links">
        {LINKS.map(([url, what]) => (
          <div key={url}>
            <dt><code>{url}</code></dt>
            <dd>{what} <button type="button" className="link-btn" onClick={() => void navigator.clipboard?.writeText(url).then(() => toast({ text: 'Copied' }))}>Copy</button></dd>
          </div>
        ))}
      </dl>
    </Group>
  );
}
