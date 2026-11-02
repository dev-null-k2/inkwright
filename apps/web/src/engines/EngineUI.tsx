import { useEffect, useState } from 'react';
import { Check, Download, Trash2 } from 'lucide-react';
import { formatBytes } from '@inkwright/ai';
import { IconButton } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { ENGINES, ENGINE_COPY, engine, engineSize, type Engine, type EngineId } from './catalog.ts';
import { deleteEngine, downloadEngine, refreshEngineStatus, useEngines, watchEngines } from './progress.ts';

/**
 * The UI side of engines that download on first use: the one-time-download notices next to the
 * features that need them, and the list in Settings › About where they can be fetched ahead of
 * going offline, or removed.
 */

/** Loads the stored state of the given engines (all by default) and keeps it current. */
function useEngineStatus(ids?: EngineId[]) {
  const key = ids?.join(',') ?? '';
  useEffect(() => {
    watchEngines();
    if (ids) for (const id of ids) void refreshEngineStatus(id);
    else void refreshEngineStatus();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useEngines();
}

const percent = (loaded: number, total: number) => `${Math.min(100, (loaded / Math.max(1, total)) * 100).toFixed(1)}%`;

/** A progress line while any of `ids` is downloading ("Downloading DuckDB · one time"), else nothing. */
export function EngineProgressNotice({ ids }: { ids: EngineId[] }) {
  const downloads = useEngines((s) => s.downloads);
  const id = ids.find((i) => downloads[i] && !downloads[i]!.error);
  if (!id) return null;
  const d = downloads[id]!;
  return (
    <div className="lai-progress eng-progress" role="status" aria-live="polite">
      <span className="lai-progress-text">Downloading {ENGINE_COPY[id].name} · one time, then it works offline</span>
      <div className="lai-bar"><span style={{ width: percent(d.loaded, d.total) }} /></div>
      <span className="lai-progress-text">{formatBytes(d.loaded)} of {formatBytes(d.total)}</span>
    </div>
  );
}

/**
 * "Also downloads the AI runtime (one time, about 6 MB)" — only while that engine is not stored, so
 * the size people are shown is the size they will actually download.
 */
export function EngineOneTimeNote({ id, lead = 'Also downloads' }: { id: EngineId; lead?: string }) {
  const s = useEngineStatus([id]);
  const e = engine(id);
  const st = s.status[id];
  if (!e || !st || st.state === 'ready') return null;
  return <span className="eng-note">{lead} the {ENGINE_COPY[id].name.toLowerCase()} once, about {formatBytes(engineSize(e).transfer)}.</span>;
}

/** WebAssembly exception handling, the feature that decides between DuckDB's two builds. */
function wasmExceptions(): boolean {
  try {
    // The probe module DuckDB-WASM itself uses (a function with a try/catch block).
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]));
  } catch {
    return false;
  }
}

/** Settings › About: every engine this build can download, with its size and state. */
export function EngineDownloads() {
  const s = useEngineStatus();
  const preferred: EngineId = wasmExceptions() ? 'duckdb-eh' : 'duckdb-mvp';
  // Of DuckDB's two builds, list the one this browser uses, and the other only if it is stored.
  const shown = ENGINES.filter((e) => !e.id.startsWith('duckdb-') || e.id === preferred || s.status[e.id]?.state === 'ready' || s.status[e.id]?.state === 'partial');
  if (!shown.length) return null;
  const where = shown[0]!.source === 'cdn' ? 'from jsDelivr, a public mirror of npm' : 'from where you opened Inkwright';
  return (
    <section className="set-group">
      <h2>Downloaded when first used</h2>
      <div className="set-card">
        {shown.map((e) => <EngineRow key={e.id} e={e} />)}
      </div>
      <p className="set-note">These parts of Inkwright are large and only some people need them, so they are not part of the install. Each downloads once {where}, is checked against the checksum published with this version, and then works offline.</p>
    </section>
  );
}

function EngineRow({ e }: { e: Engine }) {
  const st = useEngines((x) => x.status[e.id]);
  const dl = useEngines((x) => x.downloads[e.id]);
  const [busy, setBusy] = useState(false);
  const size = engineSize(e);
  const copy = ENGINE_COPY[e.id];
  const stored = st?.state === 'ready';
  return (
    <div className="lai-row" data-engine={e.id}>
      <div className="lai-row-main">
        <span className="prov-name">{copy.name}</span>
        <span className="muted">{copy.purpose} {e.packages.join(', ')}.</span>
        {dl && !dl.error && (
          <div className="lai-progress" role="status">
            <div className="lai-bar"><span style={{ width: percent(dl.loaded, dl.total) }} /></div>
            <span className="lai-progress-text">{formatBytes(dl.loaded)} of {formatBytes(dl.total)}</span>
          </div>
        )}
        {dl?.error && <p className="lai-error" role="alert">{dl.error}</p>}
      </div>
      <div className="prov-acts">
        {stored ? (
          <>
            <span className="lai-ok"><Check size={14} /> On this device · {formatBytes(size.bytes)}</span>
            <IconButton label={`Remove ${copy.name}`} onClick={async () => {
              if (await askConfirm(`Remove ${copy.name}?`, `Frees ${formatBytes(size.bytes)}. It downloads again the next time it is needed.`, 'Remove', true)) await deleteEngine(e.id);
            }}><Trash2 size={16} /></IconButton>
          </>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy || (!!dl && !dl.error)} onClick={async () => {
            setBusy(true);
            try { await downloadEngine(e.id); } catch { /* shown in the row */ } finally { setBusy(false); }
          }}>
            <Download size={14} /> {st?.state === 'partial' ? 'Finish download' : `Download · ${formatBytes(size.transfer)}`}
          </button>
        )}
      </div>
    </div>
  );
}
