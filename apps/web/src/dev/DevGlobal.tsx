import { useEffect, useState } from 'react';
import { Code2, FileWarning, GitCompareArrows, History } from 'lucide-react';
import { codeRefStates, isCodeTarget, parseCodeTarget, parseWikiTarget, type CodeRefState } from '@inkwright/core';
import { createFromTemplate, registerLinkHandler } from '../lib/knowledge.ts';
import { usePaletteActions } from '../lib/palette.ts';
import { activeSession } from '../lib/session.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { Dialog } from '../ui/primitives.tsx';
import { markReviewed } from './codeRefs.ts';
import { DriftDialog } from './dialogs.tsx';
import { ensureIncidentTemplate, importSessions, loadLessons } from './journal.ts';
import { useDevSettings } from './settings.ts';
import { loadCode, useDev } from './store.ts';
import { SymbolCard } from './SymbolCard.tsx';

/** Imports transcript files picked by the user; shared by the palette and Settings. */
export async function pickAndImportSessions(): Promise<void> {
  const { toast, navigate } = useApp.getState();
  const files = await pickFiles('.jsonl,.json,application/json', true);
  if (!files.length) return;
  const { ids, errors } = await importSessions(files);
  if (errors.length) toast({ text: errors[0]!, tone: 'error' });
  if (ids.length) {
    toast({ text: `Imported ${ids.length} ${ids.length === 1 ? 'session' : 'sessions'} into Sessions`, tone: 'success' });
    if (ids.length === 1) navigate({ name: 'editor', noteId: ids[0]! });
  }
}

export async function newIncidentNote(): Promise<void> {
  const { toast, navigate } = useApp.getState();
  try {
    const t = await ensureIncidentTemplate();
    const id = await createFromTemplate(t.id, { title: `Incident ${new Date().toISOString().slice(0, 10)}` });
    if (id) navigate({ name: 'editor', noteId: id });
  } catch (e) {
    toast({ text: (e as Error).message, tone: 'error' });
  }
}

/**
 * The developer module's app-wide part (mounted once by App): loads code sources, opens
 * followed `[[code:…]]` links as a read-only symbol card, offers its palette actions and the
 * vault-wide drift list. Renders nothing while the module is off.
 */
export function DevGlobal() {
  const on = useDevSettings((s) => s.devTools);
  const vault = useApp((s) => s.vault);
  const navigate = useApp((s) => s.navigate);
  const indexes = useDev((s) => s.indexes);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [drift, setDrift] = useState(false);

  useEffect(() => {
    if (!on || !vault) return;
    void loadCode(vault);
    void loadLessons();
  }, [on, vault]);

  useEffect(() => {
    if (!on) return;
    // Code links never become notes: following one shows the code.
    return registerLinkHandler((target) => {
      if (!isCodeTarget(target)) return false;
      const w = parseWikiTarget(target);
      const t = parseCodeTarget(w.subpath ? `${w.title}#${w.subpath}` : w.title);
      if (t) setSymbol(t.symbol ? `${t.path}#${t.symbol}` : t.path);
      return true;
    });
  }, [on]);

  usePaletteActions('dev', on ? [
    { id: 'dev-sources', label: 'Code sources', keywords: 'developer repository mount scan code graph', icon: <Code2 size={16} />, run: () => navigate({ name: 'settings', section: 'code' }) },
    { id: 'dev-drift', label: 'Code drift', keywords: 'developer stale docs changed', icon: <GitCompareArrows size={16} />, run: () => setDrift(true) },
    { id: 'dev-sessions', label: 'Import agent sessions', keywords: 'claude code codex gemini transcript jsonl', icon: <History size={16} />, run: () => void pickAndImportSessions() },
    { id: 'dev-incident', label: 'New incident note', keywords: 'rca postmortem runbook outage', icon: <FileWarning size={16} />, run: () => void newIncidentNote() },
  ] : []);

  if (!on) return null;
  // A link followed in the open note shows its drift too.
  const doc = activeSession()?.doc;
  const state: CodeRefState | undefined = symbol && doc ? codeRefStates(doc.meta, doc.pages, indexes).find((s) => s.key === symbol) : undefined;
  const target = symbol ? parseCodeTarget(`code:${symbol}`) : null;
  return (
    <>
      <Dialog open={!!target} title="Code" onClose={() => setSymbol(null)}>
        {target && <SymbolCard target={target} state={state} onReviewed={state && doc ? () => { markReviewed(doc, state); setSymbol(null); } : undefined} />}
      </Dialog>
      <DriftDialog open={drift} onClose={() => setDrift(false)} />
    </>
  );
}

