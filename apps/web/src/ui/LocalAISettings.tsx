import { useEffect, useState } from 'react';
import { Check, Cpu, Download, RefreshCw, Server, Trash2, X } from 'lucide-react';
import { EngineOneTimeNote } from '../engines/EngineUI.tsx';
import { formatBytes, getProviderInfo, runnableModels, type DetectedServer, type ModelChoice } from '@inkwright/ai';
import { newId } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { isNative } from '../platform/env.ts';
import {
  cancelDownload, chatChoice, downloadModel, embedChoice, initLocalAI, isInstalled, localAISupported, modelKey, refOf, removeModel, scanLocalServers, useLocalAI,
} from '../lib/localai.ts';
import { appMemory, useMemoryStatus } from '../lib/memory.ts';
import { askConfirm } from './prompts.tsx';
import { DownloadButton } from './assistant/DownloadControls.tsx';
import { IconButton, Segmented, cx } from './primitives.tsx';
import { NativeAISettings } from './NativeAISettings.tsx';

/**
 * Settings › AI, on-device part: what this device can run, the model for each role with its size
 * and licence, downloads (progress, cancel, resume, delete), who answers, semantic search status,
 * and one-tap setup for local model servers on desktops.
 */
export function LocalAISettings() {
  const st = useLocalAI();
  const hasProvider = useSettings((s) => s.ai.providers.length > 0);
  useEffect(() => { void initLocalAI(); }, []);
  if (!st.ready) return null;
  const supported = localAISupported() && !!st.hardware;
  const hw = st.hardware;
  return (
    <>
      <section className="set-group">
        <h2>On this device</h2>
        <div className="set-card">
          <NativeAISettings />
          {!supported ? (
            <p className="set-empty">On-device models aren’t available in this version of Inkwright. Use the installed app or the web app for private, offline AI.</p>
          ) : (
            <>
              <div className="lai-device">
                <Cpu size={18} aria-hidden />
                <div>
                  <p>{hw!.webgpu ? `Graphics chip (WebGPU${hw!.shaderF16 ? ', half precision' : ''})` : 'Processor'}{hw!.memoryGB ? ` · ${hw!.memoryGB}${hw!.memoryGB >= 8 ? '+' : ''} GB memory` : ''}</p>
                  <p className="muted">{st.rec?.why}</p>
                </div>
              </div>
              <ModelPicker role="chat" title="Assistant model" current={chatChoice()} recommendedId={st.rec?.chat?.spec.id} onChange={(id) => st.setPrefs({ chatModel: id })} />
              <ModelPicker role="embed" title="Search model" current={embedChoice()} recommendedId={st.rec?.embed.spec.id} onChange={(id) => st.setPrefs({ embedModel: id })} />
            </>
          )}
          {st.chrome !== 'unavailable' && (
            <div className="lai-row">
              <div className="lai-row-main">
                <span className="prov-name">Chrome built-in AI</span>
                <span className="muted">Gemini Nano, managed by Chrome{st.chrome === 'available' ? ' · ready' : ' · Chrome downloads it on first use'}</span>
              </div>
            </div>
          )}
        </div>
        {(hasProvider || st.chrome !== 'unavailable') && supported && (
          <div className="lai-who">
            <span className="field-label">Who answers</span>
            <Segmented label="Who answers" value={st.assistant} onChange={(v) => st.setPrefs({ assistant: v })} options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'device', label: 'This device' },
              ...(hasProvider ? [{ value: 'provider' as const, label: 'Your provider' }] : []),
              ...(st.chrome !== 'unavailable' ? [{ value: 'chrome' as const, label: 'Chrome' }] : []),
            ]} />
          </div>
        )}
        <p className="set-note">Models are open-licence and download once from Hugging Face. They run inside Inkwright, so your notes never leave this device. <EngineOneTimeNote id="onnx-runtime" lead="The first one also downloads" /> {hasProvider ? 'Automatic uses your provider when one is set up, otherwise this device.' : 'Without an AI provider, the assistant and Ask use this device.'}</p>
      </section>
      <SemanticSearch />
      {!isNative && supported && <LocalServers />}
    </>
  );
}

export function ModelPicker({ role, title, current, recommendedId, onChange }: { role: 'chat' | 'embed' | 'asr'; title: string; current: ModelChoice | null; recommendedId?: string; onChange: (id: string | null) => void }) {
  const st = useLocalAI();
  const hw = st.hardware!;
  const options = runnableModels(hw, role);
  if (!current) return <div className="lai-row"><div className="lai-row-main"><span className="prov-name">{title}</span><span className="muted">Not enough memory on this device</span></div></div>;
  const ref = refOf(current);
  const key = modelKey(ref);
  const dl = st.downloads[key];
  const installed = isInstalled(current);
  const partial = st.onDevice[key] ?? 0;
  return (
    <div className="lai-row">
      <div className="lai-row-main">
        <span className="prov-name">{title}</span>
        <select value={current.spec.id} aria-label={title} onChange={(e) => onChange(e.target.value === recommendedId ? null : e.target.value)}>
          {options.map((o) => (
            <option key={o.spec.id} value={o.spec.id}>
              {o.spec.label} · {formatBytes(o.variant.bytes)}{o.spec.id === recommendedId ? ' · recommended' : ''}{isInstalled(o) ? ' · downloaded' : ''}
            </option>
          ))}
        </select>
        <span className="muted">{current.spec.blurb} {current.spec.params} parameters · {current.spec.licence}{current.spec.languages === 'english' ? ' · English' : ''}</span>
        {dl && !dl.error && (
          <div className="lai-progress" role="status">
            <div className="lai-bar"><span style={{ width: `${Math.min(100, (dl.loaded / Math.max(1, dl.total)) * 100).toFixed(1)}%` }} /></div>
            <span className="lai-progress-text">{formatBytes(dl.loaded)} of {formatBytes(dl.total)}</span>
          </div>
        )}
        {dl?.error && <p className="lai-error" role="alert">{dl.error}</p>}
      </div>
      <div className="prov-acts">
        {installed ? (
          <>
            <span className="lai-ok"><Check size={14} /> On this device</span>
            <IconButton label={`Delete ${current.spec.label}`} onClick={async () => {
              if (await askConfirm(`Delete ${current.spec.label}?`, `Frees ${formatBytes(current.variant.bytes)}. You can download it again later.`, 'Delete', true)) await removeModel(current);
            }}><Trash2 size={16} /></IconButton>
          </>
        ) : (
          <DownloadButton what={current.spec.label} ready={false} progress={dl && !dl.error ? { phase: dl.total > 0 ? 'download' : 'started', loaded: dl.loaded, total: dl.total } : null}
            startLabel={partial > 0 ? `Resume · ${formatBytes(Math.max(0, current.variant.bytes - partial))}` : `Download · ${formatBytes(current.variant.bytes)}`}
            onStart={() => void downloadModel(current)} onCancel={() => cancelDownload(current)} />
        )}
      </div>
    </div>
  );
}

function SemanticSearch() {
  const st = useLocalAI();
  const status = useMemoryStatus();
  const ai = useSettings((s) => s.ai);
  const active = ai.providers.find((p) => p.id === ai.activeId);
  const providerOk = active && getProviderInfo(active.providerId)?.kind === 'openai-compatible';
  return (
    <section className="set-group">
      <h2>Search everything</h2>
      <div className="set-card">
        <div className="lai-row">
          <div className="lai-row-main">
            <span className="prov-name">Search by meaning</span>
            <span className="muted">
              {status.embedder
                ? `${status.embedded} of ${status.passages} passages ready · ${status.embedder}${status.indexing ? ' · indexing in the background' : ''}`
                : `${status.passages} passages searchable by keyword. Download the search model above to also find notes by meaning.`}
            </span>
            {status.error && <p className="lai-error">{status.error}</p>}
          </div>
          <div className="prov-acts">
            <IconButton label="Rebuild search index" onClick={() => void appMemory()?.resetVectors()}><RefreshCw size={16} /></IconButton>
          </div>
        </div>
        <div className="lai-who">
          <span className="field-label">Meaning comes from</span>
          <Segmented label="Embeddings" value={st.embeddings} onChange={(v) => st.setPrefs({ embeddings: v })} options={[
            { value: 'device', label: 'This device' },
            ...(providerOk ? [{ value: 'provider' as const, label: 'Your provider' }] : []),
            { value: 'off', label: 'Keywords only' },
          ]} />
        </div>
        {st.embeddings === 'provider' && providerOk && (
          <label className="field-row">
            <span className="field-label">Embedding model</span>
            <input value={st.embedProviderModel} placeholder={active?.providerId === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'} onChange={(e) => st.setPrefs({ embedProviderModel: e.target.value.trim() })} aria-label="Embedding model at your provider" />
          </label>
        )}
      </div>
      <p className="set-note">Search covers titles, tags, typed text, recognized handwriting and the text of imported PDFs. The index stays on this device and is rebuilt on each device.</p>
    </section>
  );
}

function LocalServers() {
  const st = useLocalAI();
  const s = useSettings();
  const toast = useApp((a) => a.toast);
  const [scanned, setScanned] = useState(false);
  const use = (d: DetectedServer) => {
    const info = getProviderInfo(d.server.providerId);
    const existing = s.ai.providers.find((p) => p.providerId === d.server.providerId && (p.baseUrl ?? info?.defaultBaseUrl) === d.baseUrl);
    const id = existing?.id ?? newId();
    s.update((x) => ({
      ai: {
        ...x.ai,
        providers: existing ? x.ai.providers : [...x.ai.providers, { id, providerId: d.server.providerId, label: info?.label ?? d.server.label, model: d.models[0] ?? info?.defaultModel ?? '', baseUrl: d.baseUrl, hasKey: false }],
        activeId: id,
      },
    }));
    toast({ text: `${d.server.label} connected${d.models[0] ? ` · ${d.models[0]}` : ''}`, tone: 'success' });
  };
  return (
    <section className="set-group">
      <h2>Model servers on this computer</h2>
      <div className="set-card">
        <div className="lai-row">
          <div className="lai-row-main">
            <span className="prov-name">Ollama, LM Studio, llama.cpp, Foundry Local</span>
            <span className="muted">Already running models on this computer? Inkwright can use them.</span>
          </div>
          <div className="prov-acts">
            <button type="button" className="btn btn-sm" disabled={st.scanning} onClick={() => void scanLocalServers().then(() => setScanned(true))}><Server size={14} /> {st.scanning ? 'Looking…' : 'Look for servers'}</button>
          </div>
        </div>
        {scanned && st.servers && !st.servers.length && <p className="set-empty">None found. Start one (Ollama: open the app; LM Studio: start the local server), then look again.</p>}
        {st.servers?.map((d) => (
          <div key={d.server.id} className={cx('lai-row', d.status === 'blocked' && 'is-blocked')}>
            <div className="lai-row-main">
              <span className="prov-name">{d.server.label}</span>
              {d.status === 'ready' ? (
                <span className="muted">{d.baseUrl} · {d.models.length ? d.models.slice(0, 4).join(', ') : 'no models loaded yet'}</span>
              ) : (
                <span className="lai-help">Found at {d.baseUrl}, but it doesn’t allow this page to connect yet. {d.server.corsHelp}</span>
              )}
            </div>
            {d.status === 'ready' && <div className="prov-acts"><button type="button" className="btn btn-sm btn-primary" onClick={() => use(d)}>Use</button></div>}
          </div>
        ))}
      </div>
    </section>
  );
}
