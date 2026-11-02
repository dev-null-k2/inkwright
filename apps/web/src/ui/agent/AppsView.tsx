/**
 * Connected apps: remote MCP servers the assistant can use. Add one from the short list of
 * verified servers or by URL; sign in with OAuth or paste a token; turn tools on or off and choose
 * which ones ask before running; follow background tasks.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, LogIn, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { KNOWN_MCP_SERVERS, defaultToolSettings, isTerminal, type McpAuthMethod, type McpServerConfig } from '@inkstone/ai';
import {
  addServer,
  answerTask,
  cancelTask,
  connectServer,
  dismissTask,
  promptText,
  removeServer,
  setServerEnabled,
  setToolSettings,
  signIn,
  signOut,
  useMcp,
  type McpRuntime,
  type TrackedTask,
} from '../../lib/agent/mcp.ts';
import { useApp } from '../../state/app.ts';
import { IconButton, Segmented, cx, relativeTime } from '../primitives.tsx';
import { askConfirm, askText } from '../prompts.tsx';
import { sendToAssistantInput } from '../../lib/agent/hub.ts';
import { Section, StatusDot } from './shared.tsx';

export function AppsView() {
  const servers = useMcp((s) => s.servers);
  const tasks = useMcp((s) => s.tasks);
  const [adding, setAdding] = useState(servers.length === 0);
  return (
    <div className="ag-screen">
      <p className="ag-lead">Let the assistant use other apps through the Model Context Protocol (MCP). It asks before anything that changes things there, unless you turn that off for a tool. Sign-ins stay on this device.</p>
      {servers.length > 0 && (
        <Section title="Connected" action={!adding ? <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}><Plus size={14} /> Add</button> : undefined}>
          <ul className="ag-list">{servers.map((s) => <ServerRow key={s.id} cfg={s} />)}</ul>
        </Section>
      )}
      {tasks.length > 0 && <TasksSection tasks={tasks} />}
      {adding && <AddServer onDone={() => setAdding(false)} />}
    </div>
  );
}

function statusText(rt: McpRuntime | undefined, cfg: McpServerConfig): { text: string; tone: 'ok' | 'busy' | 'warn' | 'off' | 'error' } {
  if (!cfg.enabled) return { text: 'Off', tone: 'off' };
  switch (rt?.status) {
    case 'connected': return { text: `Connected · ${rt.tools.length} ${rt.tools.length === 1 ? 'tool' : 'tools'}`, tone: 'ok' };
    case 'connecting': return { text: 'Connecting…', tone: 'busy' };
    case 'needs-auth': return { text: 'Needs you to sign in', tone: 'warn' };
    case 'error': return { text: 'Can’t connect', tone: 'error' };
    default: return { text: 'Not connected', tone: 'off' };
  }
}

function ServerRow({ cfg }: { cfg: McpServerConfig }) {
  const rt = useMcp((s) => s.runtime[cfg.id]);
  const [open, setOpen] = useState(false);
  const st = statusText(rt, cfg);
  const host = (() => { try { return new URL(cfg.url).host; } catch { return cfg.url; } })();
  return (
    <li className="ag-item ag-server">
      <div className="ag-server-head">
        <button type="button" className="ag-expand" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${cfg.name} tools`} onClick={() => setOpen(!open)} disabled={!rt?.tools.length}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="ag-item-main">
          <span className="ag-item-title">{cfg.name}</span>
          <span className="muted small"><StatusDot tone={st.tone} /> {st.text} · {host}{rt?.info?.protocolVersion ? ` · MCP ${rt.info.protocolVersion}` : ''}</span>
        </div>
        <div className="ag-row-acts">
          {cfg.auth === 'oauth' && rt?.status === 'needs-auth' && <button type="button" className="btn btn-sm btn-primary" onClick={() => void signIn(cfg.id)}><LogIn size={14} /> Sign in</button>}
          {(rt?.status === 'error' || rt?.status === 'idle') && cfg.enabled && <IconButton label={`Reconnect ${cfg.name}`} onClick={() => void connectServer(cfg.id)}><RefreshCw size={15} /></IconButton>}
          <label className="ag-switch" title={cfg.enabled ? 'On' : 'Off'}>
            <input type="checkbox" role="switch" aria-label={`${cfg.name} on`} checked={cfg.enabled} onChange={(e) => setServerEnabled(cfg.id, e.target.checked)} />
            <span className="switch" aria-hidden />
          </label>
        </div>
      </div>
      {rt?.error && rt.status !== 'connected' && <p className={cx('ag-server-error', rt.errorKind === 'cors' && 'is-cors')}>{rt.error}</p>}
      {open && rt?.tools.length ? <ToolList cfg={cfg} rt={rt} /> : null}
      {open && rt?.prompts?.length ? <PromptList cfg={cfg} prompts={rt.prompts} /> : null}
      {open && rt?.resourceCount ? <p className="muted small">Shares {rt.resourceCount} {rt.resourceCount === 1 ? 'resource' : 'resources'} the assistant can read.</p> : null}
      {open && (
        <div className="ag-server-foot">
          {cfg.auth === 'oauth' && rt?.status === 'connected' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => void signOut(cfg.id)}>Sign out</button>}
          <button type="button" className="btn btn-sm btn-danger-ghost" onClick={async () => { if (await askConfirm(`Remove ${cfg.name}?`, 'The assistant can no longer use it, and its sign-in is deleted from this device.', 'Remove', true)) await removeServer(cfg.id); }}><Trash2 size={14} /> Remove</button>
        </div>
      )}
    </li>
  );
}

function ToolList({ cfg, rt }: { cfg: McpServerConfig; rt: McpRuntime }) {
  return (
    <table className="ag-tools">
      <thead><tr><th>Tool</th><th>On</th><th>Ask first</th></tr></thead>
      <tbody>
        {rt.tools.map((t) => {
          const def = defaultToolSettings({ annotations: { readOnlyHint: t.readOnly } });
          const set = cfg.tools[t.name] ?? def;
          return (
            <tr key={t.name} className={cx(!set.enabled && 'is-off')}>
              <td>
                <span className="ag-tool-name">{t.title ?? t.name}</span>
                {t.description && <span className="ag-tool-desc">{t.description.slice(0, 160)}</span>}
                {!t.readOnly && <span className="ag-tool-tag">Can change things</span>}
              </td>
              <td><input type="checkbox" aria-label={`Use ${t.name}`} checked={set.enabled} onChange={(e) => setToolSettings(cfg.id, t.name, { enabled: e.target.checked }, def)} /></td>
              <td><input type="checkbox" aria-label={`Ask before ${t.name}`} checked={set.ask} disabled={!set.enabled} onChange={(e) => setToolSettings(cfg.id, t.name, { ask: e.target.checked }, def)} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Prompts are templates the user picks (not the model): fill in their arguments, then the text
 * goes into the assistant's input to review and send.
 */
function PromptList({ cfg, prompts }: { cfg: McpServerConfig; prompts: NonNullable<McpRuntime['prompts']> }) {
  const toast = useApp((s) => s.toast);
  const use = async (p: (typeof prompts)[number]) => {
    const args: Record<string, string> = {};
    for (const a of p.arguments ?? []) {
      const v = await askText(p.title ?? p.name, `${a.description ?? a.name}${a.required ? '' : ' (optional)'}`, '', 'Next');
      if (v == null && a.required) return;
      if (v) args[a.name] = v;
    }
    try {
      const text = await promptText(cfg.id, p.name, args);
      if (sendToAssistantInput(text)) return;
      await navigator.clipboard?.writeText(text);
      toast({ text: 'Copied. Open the assistant in a note and paste it.' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };
  return (
    <div className="ag-prompts">
      <span className="ag-tool-name">Prompts</span>
      <ul className="ag-list">
        {prompts.map((p) => (
          <li key={p.name} className="ag-prompt">
            <div className="ag-item-main">
              <span>{p.title ?? p.name}</span>
              {p.description && <span className="ag-tool-desc">{p.description.slice(0, 160)}</span>}
            </div>
            <button type="button" className="btn btn-sm" onClick={() => void use(p)}>Use</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TasksSection({ tasks }: { tasks: TrackedTask[] }) {
  const toast = useApp((s) => s.toast);
  return (
    <Section title="Background tasks" note="Long jobs that connected apps run for the assistant. Inkstone checks on them while it’s open.">
      <ul className="ag-list">
        {[...tasks].reverse().map((t) => {
          const done = isTerminal(t.task.status);
          return (
            <li key={t.task.taskId} className="ag-item ag-task">
              <div className="ag-item-main">
                <span className="ag-item-title"><StatusDot tone={t.task.status === 'completed' ? 'ok' : t.task.status === 'failed' ? 'error' : t.task.status === 'input_required' ? 'warn' : t.task.status === 'cancelled' ? 'off' : 'busy'} /> {t.tool} · {t.serverName}</span>
                <span className="muted small">{TASK_STATUS[t.task.status]}{t.task.statusMessage ? ` — ${t.task.statusMessage}` : ''} · {relativeTime(t.startedAt)}</span>
                {t.resultText && <p className="ag-task-result">{t.resultText.slice(0, 600)}</p>}
                {t.task.status === 'failed' && t.task.error?.message && <span className="ag-run-error small">{t.task.error.message}</span>}
                {t.pollError && !done && <span className="muted small">Last check failed: {t.pollError}</span>}
              </div>
              <div className="ag-row-acts">
                {t.task.status === 'input_required' && <button type="button" className="btn btn-sm btn-primary" onClick={() => void answerTask(t.task.taskId).catch((e) => toast({ text: (e as Error).message, tone: 'error' }))}>Answer</button>}
                {!done && <button type="button" className="btn btn-sm" onClick={() => void cancelTask(t.task.taskId).catch((e) => toast({ text: (e as Error).message, tone: 'error' }))}>Cancel</button>}
                {done && <button type="button" className="btn btn-sm btn-ghost" onClick={() => dismissTask(t.task.taskId)}>Dismiss</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

const TASK_STATUS = { working: 'Working', input_required: 'Needs your answer', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' } as const;

function AddServer({ onDone }: { onDone: () => void }) {
  const servers = useMcp((s) => s.servers);
  const toast = useApp((s) => s.toast);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [auth, setAuth] = useState<McpAuthMethod>('oauth');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = KNOWN_MCP_SERVERS.filter((k) => !servers.some((s) => s.url === k.url));
  const pickedKnown = KNOWN_MCP_SERVERS.find((k) => k.url === url.trim());
  const add = async (input: { url: string; name?: string; auth: McpAuthMethod; token?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await addServer(input);
      toast({ text: 'Added. If it needs a sign-in, finish it in the window that opened.' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Add a connected app">
      {known.length > 0 && (
        <ul className="ag-list ag-known">
          {known.map((k) => (
            <li key={k.id} className="ag-item">
              <div className="ag-item-main">
                <span className="ag-item-title">{k.name}</span>
                <span className="muted small">{k.blurb} <a href={k.docs} target="_blank" rel="noreferrer">About <ExternalLink size={11} /></a></span>
              </div>
              {k.auth === 'bearer' ? (
                <button type="button" className="btn btn-sm" onClick={() => { setUrl(k.url); setName(k.name); setAuth('bearer'); }}>Set up</button>
              ) : (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void add({ url: k.url, name: k.name, auth: k.auth })}>{k.auth === 'oauth' ? 'Connect' : 'Add'}</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="ag-add-form" onSubmit={(e) => { e.preventDefault(); void add({ url, name, auth, token }); }}>
        <label className="field">
          <span className="field-label">Server address</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" inputMode="url" autoComplete="off" />
        </label>
        <label className="field">
          <span className="field-label">Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown in the assistant" />
        </label>
        <div className="field">
          <span className="field-label">Sign-in</span>
          <Segmented label="Sign-in" value={auth} onChange={setAuth} options={[{ value: 'oauth', label: 'Sign in with the app' }, { value: 'bearer', label: 'Token' }, { value: 'none', label: 'None' }]} />
        </div>
        {auth === 'bearer' && (
          <label className="field">
            <span className="field-label">Token or API key</span>
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste it here" />
            <span className="muted small">{pickedKnown?.tokenHint ?? 'Sent as “Authorization: Bearer …”. Stored encrypted on this device.'}</span>
          </label>
        )}
        {error && <p className="ag-server-error">{error}</p>}
        <div className="row-end">
          {servers.length > 0 && <button type="button" className="btn" onClick={onDone}>Cancel</button>}
          <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </form>
      <p className="ag-note">The server must allow web apps to connect (CORS). If it doesn’t, Inkstone tells you — that’s a setting only the server’s owner can change.</p>
    </Section>
  );
}
