import { useState, type ReactNode } from 'react';
import { applyPlan, planToggle } from '../modules/registry.ts';
import { Check, FileArchive, FolderOpen, GitCompareArrows, History, RefreshCw, Trash2, Waypoints, X } from 'lucide-react';
import type { CodeSource } from '@inkwright/core';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { Switch, relativeTime } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { DriftDialog } from './dialogs.tsx';
import { newIncidentNote, pickAndImportSessions } from './DevGlobal.tsx';
import { acceptLesson, dismissLesson, useLessons } from './journal.ts';
import { useDevSettings } from './settings.ts';
import { addFolder, canOpenFolder, canScan, importArchive, importGraphFile, removeSource, rescan, useDev } from './store.ts';

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

const KIND: Record<CodeSource['kind'], string> = { folder: 'Folder', zip: 'Zip archive', tarball: 'Tarball', cli: 'Scanned by the inkwright CLI', graphify: 'graphify graph', generic: 'Imported graph' };

/**
 * Settings › Developer: the module's switch, code sources (mount, re-scan, remove), the drift
 * list, agent session journals with lesson proposals, and the incident template.
 */
export function DeveloperSection() {
  const on = useDevSettings((s) => s.devTools);
  const setDev = useDevSettings((s) => s.set);
  const { sources, scanning } = useDev();
  const lessons = useLessons((s) => s.items).filter((x) => x.status === 'proposed');
  const toast = useApp((s) => s.toast);
  const [drift, setDrift] = useState(false);

  const guard = async (fn: () => Promise<CodeSource | null | void>, done?: (s: CodeSource) => string) => {
    try {
      const s = await fn();
      if (s && done) toast({ text: done(s), tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };
  const scanned = (s: CodeSource) => `${s.name}: ${s.stats.symbols} symbols in ${s.stats.files} files`;
  const importZip = () => guard(async () => { const [f] = await pickFiles('.zip,.tar.gz,.tgz,.tar,application/zip,application/gzip', false); return f ? importArchive(f) : null; }, scanned);
  const importGraph = () => guard(async () => { const [f] = await pickFiles('.json,application/json', false); return f ? importGraphFile(f) : null; }, scanned);
  const doRescan = (s: CodeSource) => guard(async () => {
    if (s.kind === 'folder') return rescan(s);
    if (s.kind === 'cli') throw new Error('Re-scan it on the computer with inkwright scan; it syncs here.');
    const [f] = await pickFiles(s.kind === 'graphify' || s.kind === 'generic' ? '.json,application/json' : '.zip,.tar.gz,.tgz,.tar', false);
    return f ? rescan(s, f) : null;
  }, scanned);

  return (
    <>
      <Group title="Code-aware notes" note="Notes that know your code: link notes to functions with [[code:path#Name]], see when the code under a note changed, draw verified diagrams, run runbook blocks and keep lessons from coding-agent sessions. Off, none of it loads.">
        <Switch label="Code-aware notes" checked={on} onChange={(v) => applyPlan(planToggle('code', v))} hint="Code links, drift, diagrams, runbooks and session journals" />
      </Group>
      {on && (
        <>
          <Group title="Code sources" note={<>Scanned in this app with tree-sitter (TypeScript, JavaScript, Python, Go, Rust, Java) — no AI, nothing uploaded. Graphs are saved in your vault under code/sources/, so other devices, the MCP server and the <code>inkwright</code> CLI see them. A GitHub repository: use “Download ZIP” or the tarball link, then import it here.</>}>
            {scanning && <p className="dev-scanning" role="status">Scanning {scanning.label}… {scanning.total ? `${scanning.done} / ${scanning.total} files` : ''}</p>}
            {!sources.length && !scanning && <p className="muted">No code sources yet.</p>}
            <ul className="dev-sources" aria-label="Code sources">
              {sources.map((s) => (
                <li key={s.id} className="dev-source-row">
                  <div className="dev-source-main">
                    <span className="dev-source-name">{s.name}</span>
                    <span className="muted small">{KIND[s.kind]} · {s.stats.symbols} symbols · {s.stats.files} files · scanned {relativeTime(s.scannedAt)}</span>
                  </div>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={!!scanning} onClick={() => void doRescan(s)} aria-label={`Re-scan ${s.name}`}><RefreshCw size={14} /> Re-scan</button>
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${s.name}`} onClick={async () => { if (await askConfirm(`Remove ${s.name}?`, 'Its code graph is deleted from the vault. Code links to it stay in your notes.', 'Remove', true)) void removeSource(s.id); }}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
            <div className="dev-source-actions">
              {canOpenFolder && canScan && <button type="button" className="btn btn-sm" disabled={!!scanning} onClick={() => void guard(addFolder, scanned)}><FolderOpen size={14} /> Add folder</button>}
              {canScan && <button type="button" className="btn btn-sm" disabled={!!scanning} onClick={() => void importZip()}><FileArchive size={14} /> Import .zip or .tar.gz</button>}
              <button type="button" className="btn btn-sm" disabled={!!scanning} onClick={() => void importGraph()}><Waypoints size={14} /> Import graph JSON</button>
              <button type="button" className="btn btn-sm" onClick={() => setDrift(true)}><GitCompareArrows size={14} /> Code drift</button>
            </div>
          </Group>
          <Group title="Agent sessions" note="Claude Code (~/.claude/projects/…/*.jsonl), Codex CLI (~/.codex/sessions/…/rollout-*.jsonl) and Gemini CLI (~/.gemini/tmp/…/chats/*.json) transcripts become readable notes in a Sessions notebook. In a session note, ••• › Developer › Find lessons asks your AI for lessons; you decide which go into the AGENTS.md note.">
            <div className="dev-source-actions">
              <button type="button" className="btn btn-sm" onClick={() => void pickAndImportSessions()}><History size={14} /> Import sessions</button>
              <button type="button" className="btn btn-sm" onClick={() => void newIncidentNote()}>New incident note</button>
            </div>
            {lessons.length > 0 && (
              <ul className="dev-lessons" aria-label="Proposed lessons">
                {lessons.map((l) => (
                  <li key={l.id} className="dev-lesson">
                    <div className="dev-lesson-text">
                      <p>{l.text}</p>
                      {(l.why || l.noteTitle) && <p className="muted small">{l.why}{l.why && l.noteTitle ? ' · ' : ''}{l.noteTitle}</p>}
                    </div>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => void acceptLesson(l.id).then(() => toast({ text: 'Added to AGENTS.md', tone: 'success' }), (e) => toast({ text: (e as Error).message, tone: 'error' }))}><Check size={14} /> Add to AGENTS.md</button>
                    <button type="button" className="btn btn-sm btn-ghost" aria-label="Dismiss lesson" onClick={() => void dismissLesson(l.id)}><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </Group>
        </>
      )}
      <DriftDialog open={drift} onClose={() => setDrift(false)} />
    </>
  );
}
