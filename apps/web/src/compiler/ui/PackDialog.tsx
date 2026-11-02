/**
 * Context pack: pick notes, build a compressed, cited bundle, and take it to any agent — as
 * Markdown, JSON, an Agent Skill folder, or saved for the MCP server (`inkwright://packs/{id}`).
 * AGENTS.md for coding agents is one button away.
 */
import { useMemo, useState } from 'react';
import { Download, FileCode2, Package, Save } from 'lucide-react';
import type { ContextPack } from '@inkwright/core';
import { useApp } from '../../state/app.ts';
import { Dialog, Switch } from '../../ui/primitives.tsx';
import { buildPack, downloadAgentsMd, downloadPack, savePack } from '../packs.ts';

export function PackDialogBody({ init, onClose }: { init: { noteIds: string[]; title: string }; onClose: () => void }) {
  const notes = useApp((s) => s.notes);
  const toast = useApp((s) => s.toast);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(init.noteIds));
  const [title, setTitle] = useState(init.title);
  const [purpose, setPurpose] = useState('');
  const [wiki, setWiki] = useState(true);
  const [ink, setInk] = useState(true);
  const [mem, setMem] = useState(true);
  const [filter, setFilter] = useState('');
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => notes.filter((n) => !n.lock && (!filter || n.title.toLowerCase().includes(filter.toLowerCase()))).slice(0, 60), [notes, filter]);
  const build = async () => {
    setBusy(true);
    try {
      setPack(await buildPack({ noteIds: [...picked], title: title.trim() || 'Context pack', purpose, includeWiki: wiki, includeInk: ink, includeMemory: mem }));
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally { setBusy(false); }
  };
  const run = (f: () => Promise<unknown>, done: string) => async () => {
    try { await f(); toast({ text: done, tone: 'success' }); } catch (e) { toast({ text: (e as Error).message, tone: 'error' }); }
  };
  return (
    <Dialog open wide title="Context pack" onClose={onClose} actions={<>
      <button type="button" className="btn" onClick={run(downloadAgentsMd, 'AGENTS.md downloaded')}><FileCode2 size={15} /> AGENTS.md</button>
      <button type="button" className="btn btn-primary" disabled={busy || !picked.size} onClick={() => void build()}><Package size={15} /> {pack ? 'Build again' : 'Build pack'}</button>
    </>}>
      <div className="cp-pack">
        <p className="ag-lead">A compact, cited bundle of what you know, for any AI agent. Compiled pages go first (every line cites its source), then the notes, then handwriting no one has transcribed, as pictures.</p>
        <label className="field"><span className="field-label">Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} /></label>
        <label className="field"><span className="field-label">What it’s for (optional)</span><input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} placeholder="Working on the Atlas sync service" /></label>
        <div className="cp-pack-switches">
          <Switch label="Compiled wiki pages about these notes" checked={wiki} onChange={setWiki} />
          <Switch label="Handwriting as pictures" hint="Pages with ink that has not been recognized" checked={ink} onChange={setInk} />
          <Switch label="Standing preferences" hint="Instructions and facts from assistant memory" checked={mem} onChange={setMem} />
        </div>
        <div className="cp-pick">
          <input type="search" placeholder="Find notes" aria-label="Find notes" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="cp-pick-list">
            {shown.map((n) => (
              <li key={n.id}><label className="check-row"><input type="checkbox" checked={picked.has(n.id)} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(n.id); else s.delete(n.id); setPicked(s); }} /> {n.title || 'Untitled'}</label></li>
            ))}
          </ul>
          <span className="muted small">{picked.size} {picked.size === 1 ? 'note' : 'notes'} picked</span>
        </div>
        {pack && (
          <section className="cp-pack-result" aria-label="Pack">
            <p className="ag-note">About {pack.tokens.toLocaleString()} tokens{pack.truncated.length ? ` · left out to stay small: ${pack.truncated.join(', ')}` : ''}.</p>
            <pre className="cp-preview">{pack.markdown.split('\n').slice(0, 40).join('\n')}{pack.markdown.split('\n').length > 40 ? '\n…' : ''}</pre>
            <div className="ag-row-acts">
              <button type="button" className="btn btn-sm" onClick={run(() => downloadPack(pack, 'md'), 'Markdown downloaded')}><Download size={14} /> Markdown</button>
              <button type="button" className="btn btn-sm" onClick={run(() => downloadPack(pack, 'json'), 'JSON downloaded')}><Download size={14} /> JSON</button>
              <button type="button" className="btn btn-sm" onClick={run(() => downloadPack(pack, 'skill'), 'Agent Skill downloaded')}><Download size={14} /> Agent Skill (.zip)</button>
              <button type="button" className="btn btn-sm" onClick={run(() => savePack(pack), 'Saved: agents connected over MCP can read it as a resource')}><Save size={14} /> Save for agents (MCP)</button>
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}
