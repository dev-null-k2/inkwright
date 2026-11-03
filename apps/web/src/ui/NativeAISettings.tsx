import { useEffect, useRef, useState } from 'react';
import { Check, Mic, Sparkles, Trash2, X } from 'lucide-react';
import { formatBytes } from '@inkwright/ai';
import type { NativeModelInfo } from '../ai/native/plugin.ts';
import {
  cancelNativeDownload, chosenModel, deleteNativeModel, downloadNative, initNativeAI, nanoState, nativeAIPlugin, refreshNativeAI, taskState, unloadNativeModel, useNativeAI,
  type NativeDownload,
} from '../lib/native-ai.ts';
import { askConfirm } from './prompts.tsx';
import { DownloadButton, DownloadIssueLine } from './assistant/DownloadControls.tsx';
import { IconButton, Segmented } from './primitives.tsx';

/**
 * Settings › AI › On this device, Android part: Gemini Nano (AICore) with its status and system
 * download, the ML Kit writing tools, the open LiteRT-LM model with its size, licence and a
 * resumable download, which engine answers first, and offline voice input. Renders nothing off
 * Android.
 */
export function NativeAISettings() {
  const st = useNativeAI();
  useEffect(() => {
    // Status can change outside the app (AICore finishing a download), so read it on every visit.
    void initNativeAI().then(() => refreshNativeAI()).catch(() => {});
  }, []);
  if (!nativeAIPlugin() || !st.ready || !st.status) return null;
  const nano = nanoState(st);
  const model = chosenModel(st);
  const bothUsable = nano !== 'unavailable' && model?.state === 'available';
  return (
    <div className="nai" data-testid="native-ai">
      <NanoRow />
      {nano !== 'unavailable' && <TasksRow />}
      <ModelRow />
      {bothUsable && (
        <div className="lai-who">
          <span className="field-label">On this phone, answers come from</span>
          <Segmented label="Native engine" value={st.engine === 'litert' ? 'litert' : 'gemini-nano'} onChange={(v) => st.setPrefs({ engine: v })} options={[
            { value: 'gemini-nano', label: 'Gemini Nano' },
            { value: 'litert', label: model!.label },
          ]} />
        </div>
      )}
      <SpeechRow />
    </div>
  );
}

function Progress({ d }: { d: NativeDownload }) {
  if (d.phase === 'retrying' || d.phase === 'failed') return null;
  const verifying = d.phase === 'verify';
  const pct = d.total > 0 ? Math.min(100, (d.loaded / d.total) * 100) : 0;
  return (
    <div className="lai-progress" role="status" aria-live="polite">
      <div className="lai-bar"><span style={{ width: `${pct.toFixed(1)}%` }} /></div>
      <span className="lai-progress-text">
        {verifying ? `Checking the download · ${pct.toFixed(0)}%` : d.total > 0 ? `${formatBytes(d.loaded)} of ${formatBytes(d.total)}` : 'Starting…'}
      </span>
    </div>
  );
}

function NanoRow() {
  const st = useNativeAI();
  const nano = st.status!.engines.find((e) => e.id === 'gemini-nano');
  const state = nanoState(st);
  const dl = st.downloads['gemini-nano'];
  const active = dl && dl.phase !== 'failed';
  if (state === 'unavailable') {
    return (
      <div className="lai-row">
        <div className="lai-row-main">
          <span className="prov-name">Gemini Nano</span>
          <span className="muted">Not offered on this phone. Android provides it on recent Pixel, Galaxy and some other flagship phones; the open model below works instead.</span>
        </div>
      </div>
    );
  }
  return (
    <div className="lai-row">
      <div className="lai-row-main">
        <span className="prov-name">Gemini Nano</span>
        <span className="muted">
          Built into Android and run on the phone’s AI chip. Nothing you write leaves the phone.
          {state === 'available' && nano?.model ? ` · ${nano.model}` : ''}
          {state === 'downloadable' && !active ? ' Android downloads it once and shares it between apps.' : ''}
        </span>
        {active && <Progress d={dl} />}
        {state === 'downloading' && !active && <span className="muted">Android is downloading it. This can take a while on mobile data.</span>}
        {/* While Android downloads it, an error from our request is AICore restarting, not a failure. */}
        {state !== 'downloading' && <DownloadIssueLine what="Gemini Nano" progress={dl} onRetry={() => void downloadNative('gemini-nano')} />}
      </div>
      <div className="prov-acts">
        <DownloadButton what="Gemini Nano" ready={state === 'available'} progress={dl} systemDownloading={state === 'downloading'}
          onStart={() => void downloadNative('gemini-nano')} onCancel={() => cancelNativeDownload('gemini-nano')} />
      </div>
    </div>
  );
}

const TASKS = [
  { task: 'summarize' as const, label: 'summaries' },
  { task: 'proofread' as const, label: 'proofreading of recognized handwriting' },
  { task: 'describe-image' as const, label: 'image descriptions' },
];

function TasksRow() {
  const st = useNativeAI();
  // Downloads still to start (they run one after another): the button stays "Downloading…" between them.
  const [queued, setQueued] = useState<string[]>([]);
  const [batch, setBatch] = useState(0);
  const cancelled = useRef(false);
  const states = TASKS.map((t) => ({ ...t, state: taskState(t.task, st), dl: st.downloads[`task:${t.task}`] }));
  const shown = states.filter((t) => t.state !== 'unavailable');
  if (!shown.length) return null;
  const ready = shown.filter((t) => t.state === 'available');
  const missing = shown.filter((t) => t.state === 'downloadable' && !(t.dl && t.dl.phase !== 'failed'));
  const busy = shown.find((t) => t.dl && t.dl.phase !== 'failed' && t.dl.phase !== 'retrying');
  const issue = shown.find((t) => t.dl?.phase === 'failed' || t.dl?.phase === 'retrying');
  // One button for all of them: overall progress across the batch, while any is still to come.
  const active = shown.filter((t) => t.dl && t.dl.phase !== 'failed');
  const pending = active.length > 0 || queued.length > 0;
  const cur = active.find((t) => t.dl!.phase !== 'retrying')?.dl;
  const done = Math.max(0, batch - queued.length);
  const fraction = cur && cur.total > 0 ? Math.min(1, cur.loaded / cur.total) : 0;
  const loaded = Math.round(((done + fraction) / Math.max(1, batch)) * 1000);
  const total = batch > 0 ? 1000 : 0;
  const phase = active.some((t) => t.dl!.phase === 'retrying') ? 'retrying' : done > 0 || cur?.phase === 'download' ? 'download' : cur?.phase ?? 'started';
  const start = () => void (async () => {
    const list = missing.map((t) => `task:${t.task}`);
    setBatch(list.length);
    setQueued(list);
    for (const target of list) {
      if (cancelled.current) break;
      await downloadNative(target);
      setQueued((q) => q.filter((x) => x !== target));
    }
    cancelled.current = false;
    setQueued([]);
  })();
  const cancel = () => {
    cancelled.current = true;
    setQueued([]);
    for (const t of shown) if (t.dl) cancelNativeDownload(`task:${t.task}`);
  };
  return (
    <div className="lai-row">
      <div className="lai-row-main">
        <span className="prov-name">Writing tools</span>
        <span className="muted">
          Tuned Gemini Nano for {shown.map((t) => t.label).join(', ')}.
          {ready.length ? ` Ready: ${ready.map((t) => t.label).join(', ')}.` : ''}
        </span>
        {busy?.dl && <Progress d={busy.dl} />}
        <DownloadIssueLine what="the writing tools" progress={issue?.dl} onRetry={start} />
      </div>
      <div className="prov-acts">
        <DownloadButton what="the writing tools" ready={ready.length === shown.length}
          progress={pending ? { phase, loaded, total } : null}
          systemDownloading={!pending && shown.some((t) => t.state === 'downloading')}
          onStart={start} onCancel={cancel} />
      </div>
    </div>
  );
}

/** Asks before a large download, with its size; LiteRT models are hundreds of MB to GBs. */
export async function confirmModelDownload(m: NativeModelInfo): Promise<boolean> {
  const left = Math.max(0, m.bytes - m.partialBytes);
  return askConfirm(
    `Download ${m.label}?`,
    `${formatBytes(left)}${m.partialBytes > 0 ? ' left to download' : ''} from Hugging Face, once. ${m.licence} licence. It runs on this phone and works offline afterwards. Use Wi-Fi if your data plan is limited.`,
    'Download',
  );
}

function ModelRow() {
  const st = useNativeAI();
  const model = chosenModel(st);
  const models = st.status!.models;
  if (!model) {
    return (
      <div className="lai-row">
        <div className="lai-row-main">
          <span className="prov-name">Open model</span>
          <span className="muted">This phone can’t run an open model: it needs a 64-bit phone with at least 4 GB of memory.</span>
        </div>
      </div>
    );
  }
  const target = `litert:${model.id}`;
  const dl = st.downloads[target];
  const active = dl && dl.phase !== 'failed';
  const installed = model.state === 'available';
  const choose = async (id: string) => {
    if (id === model.id) return;
    await unloadNativeModel();
    st.setPrefs({ modelId: id === st.status!.recommendedModel ? null : id });
  };
  return (
    <div className="lai-row">
      <div className="lai-row-main">
        <span className="prov-name">Open model</span>
        <select value={model.id} aria-label="Open model" onChange={(e) => void choose(e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id} disabled={m.state === 'unavailable'}>
              {m.label} · {formatBytes(m.bytes)}
              {m.id === st.status!.recommendedModel ? ' · recommended' : ''}
              {m.state === 'available' ? ' · downloaded' : ''}
              {m.state === 'unavailable' ? ` · needs ${Math.ceil(m.minRamGb + 0.6)} GB memory` : ''}
            </option>
          ))}
        </select>
        <span className="muted">
          {model.blurb} {model.params} parameters · {model.licence} · runs with LiteRT-LM
          {model.loaded && model.backend ? ` · running on the ${model.backend === 'gpu' ? 'graphics chip' : 'processor'}` : ''}
        </span>
        {active && <Progress d={dl} />}
        <DownloadIssueLine what={model.label} progress={dl} onRetry={async () => { if (await confirmModelDownload(model)) await downloadNative(target); }} />
      </div>
      <div className="prov-acts">
        {installed ? (
          <>
            <span className="lai-ok" data-state="ready"><Check size={14} /> On this phone</span>
            <IconButton label={`Delete ${model.label}`} onClick={async () => {
              if (await askConfirm(`Delete ${model.label}?`, `Frees ${formatBytes(model.bytes)}. You can download it again later.`, 'Delete', true)) await deleteNativeModel(model.id);
            }}><Trash2 size={16} /></IconButton>
          </>
        ) : (
          <DownloadButton what={model.label} ready={false} progress={dl}
            startLabel={model.partialBytes > 0 ? `Resume · ${formatBytes(Math.max(0, model.bytes - model.partialBytes))}` : `Download · ${formatBytes(model.bytes)}`}
            onStart={async () => { if (await confirmModelDownload(model)) await downloadNative(target); }} onCancel={() => cancelNativeDownload(target)} />
        )}
      </div>
    </div>
  );
}

function SpeechRow() {
  const sp = useNativeAI((s) => s.status?.speech);
  if (!sp?.available) return null;
  return (
    <div className="lai-row">
      <div className="lai-row-main">
        <span className="prov-name"><Mic size={14} aria-hidden /> Voice input</span>
        <span className="muted">
          {sp.onDevice
            ? 'Android’s speech recognition runs on this phone, so the assistant hears you offline and audio never leaves it.'
            : 'Android’s speech recognition works offline when the language is downloaded (Android settings › Speech), otherwise through Google.'}
        </span>
      </div>
    </div>
  );
}

/** What the one-time AI offer should propose on Android, if anything. */
export function useNativeOffer(): 'nano' | 'model' | null {
  const st = useNativeAI();
  useEffect(() => { void initNativeAI(); }, []);
  if (!nativeAIPlugin() || !st.status) return null;
  const nano = nanoState(st);
  if (nano === 'downloadable' || nano === 'downloading') return 'nano';
  const m = chosenModel(st);
  return m && (m.state === 'downloadable' || m.state === 'downloading') ? 'model' : null;
}

/**
 * The Android version of the assistant's one-time offer: Gemini Nano when the phone has it (a
 * system download), otherwise the recommended open model with its size, progress and cancel.
 */
export function NativeAIOffer({ kind, onReady, compact }: { kind: 'nano' | 'model'; onReady?: () => void; compact?: boolean }) {
  const st = useNativeAI();
  const model = chosenModel(st);
  const target = kind === 'nano' ? 'gemini-nano' : `litert:${model?.id}`;
  const dl = st.downloads[target];
  const active = dl && dl.phase !== 'failed';
  const nanoBusy = kind === 'nano' && nanoState(st) === 'downloading';
  const start = async () => {
    if (kind === 'model' && model && !(await confirmModelDownload(model))) return;
    if (await downloadNative(target)) onReady?.();
  };
  return (
    <div className={compact ? 'lai-offer is-compact' : 'lai-offer'}>
      <div className="lai-offer-head">
        <Sparkles size={18} aria-hidden />
        <div>
          <p className="lai-offer-title">Use AI privately on this phone</p>
          <p className="muted">
            {kind === 'nano'
              ? 'Gemini Nano is built into Android on this phone. Android downloads it once; then it runs on the phone’s AI chip, offline, and nothing you write leaves the phone.'
              : `${model?.label} runs on this phone’s graphics chip. Nothing you write leaves the phone, and it works offline once downloaded.`}
          </p>
        </div>
      </div>
      {active && dl.phase !== 'retrying' ? (
        <div className="lai-progress" role="status" aria-live="polite">
          <div className="lai-bar"><span style={{ width: `${dl.total > 0 ? Math.min(100, (dl.loaded / dl.total) * 100).toFixed(1) : 0}%` }} /></div>
          <span className="lai-progress-text">{dl.phase === 'verify' ? 'Checking the download…' : dl.total > 0 ? `${formatBytes(dl.loaded)} of ${formatBytes(dl.total)}` : 'Starting…'}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => cancelNativeDownload(target)} aria-label="Cancel download"><X size={14} /> Cancel</button>
        </div>
      ) : nanoBusy ? (
        <p className="muted small">Android is downloading Gemini Nano. It’s ready when this message goes away.</p>
      ) : (
        <div className="lai-offer-actions">
          <button type="button" className="btn btn-primary" disabled={dl?.phase === 'retrying'} onClick={() => void start()}>
            {dl?.phase === 'retrying' ? 'Retrying…' : kind === 'nano' ? 'Download Gemini Nano' : model && model.partialBytes > 0 ? `Resume download (${formatBytes(Math.max(0, model.bytes - model.partialBytes))} left)` : `Download ${formatBytes(model?.bytes ?? 0)}`}
          </button>
          <DownloadIssueLine what={kind === 'nano' ? 'Gemini Nano' : model?.label ?? 'the model'} progress={dl} onRetry={() => void start()} />
          <p className="muted small">{kind === 'nano' ? 'Managed by Android · shared with other apps.' : `One-time download · ${model?.licence} licence · remove it any time in Settings › AI.`}</p>
        </div>
      )}
    </div>
  );
}
