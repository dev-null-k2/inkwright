/**
 * Skills: Agent Skills (agentskills.io) the assistant can load when a task matches. Import a
 * folder, a .zip/.skill file or a link to a SKILL.md; view, copy, export, switch off or delete.
 * Scripts inside skills are never run, and the screen says so.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Download, FileArchive, FolderOpen, Link2, Trash2 } from 'lucide-react';
import { SkillFormatError, isScriptPath, type SkillBundle, type SkillInfo } from '@inkwright/ai';
import { requireHub, useAgent } from '../../lib/agent/hub.ts';
import { exportSkill, installSkill, pickFolder, skillFromPicked, skillFromUrl } from '../../lib/agent/skills.ts';
import { pickFiles } from '../../platform/files.ts';
import { useApp } from '../../state/app.ts';
import { IconButton, cx } from '../primitives.tsx';
import { askConfirm } from '../prompts.tsx';
import { Section } from './shared.tsx';

export function SkillsView() {
  const skills = useAgent((s) => s.skills);
  const toast = useApp((s) => s.toast);
  const [url, setUrl] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const install = async (get: () => Promise<SkillBundle | null>) => {
    setError(null);
    setBusy(true);
    try {
      const b = await get();
      if (!b) return;
      const exists = useAgent.getState().skills.some((s) => s.name === b.name);
      if (exists && !(await askConfirm(`Replace “${b.name}”?`, 'A skill with this name is already installed.', 'Replace', true))) return;
      await installSkill(b, exists);
      toast({ text: `Added the skill “${b.name}”${b.warnings.length ? ` (${b.warnings[0]})` : ''}`, tone: 'success' });
      setUrl('');
      setShowUrl(false);
    } catch (e) {
      setError(e instanceof SkillFormatError ? e.message : `Couldn’t import that skill: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const builtins = skills.filter((s) => s.builtin);
  const mine = skills.filter((s) => !s.builtin);
  return (
    <div className="ag-screen">
      <p className="ag-lead">Skills are instructions the assistant follows for specific tasks. It sees only their names and descriptions until a task needs one, then reads the rest. Scripts in skills are never run — Inkwright only reads text.</p>
      <div className="ag-import">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void install(async () => { const f = await pickFolder(); return f.length ? skillFromPicked(f) : null; })}><FolderOpen size={14} /> Import folder</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void install(async () => { const f = await pickFiles('.zip,.skill,application/zip', false); return f.length ? skillFromPicked(f) : null; })}><FileArchive size={14} /> Import .zip or .skill</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setShowUrl(!showUrl)}><Link2 size={14} /> From a link</button>
      </div>
      {showUrl && (
        <form className="ag-url-form" onSubmit={(e) => { e.preventDefault(); void install(() => skillFromUrl(url)); }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/SKILL.md" aria-label="Link to a SKILL.md" inputMode="url" />
          <button type="submit" className="btn btn-sm btn-primary" disabled={!url.trim() || busy}>Add</button>
        </form>
      )}
      {error && <p className="ag-server-error" role="alert">{error}</p>}
      <Section title="Your skills" note={<>Stored with your notes in <code>ai/skills/</code>, so they sync to your other devices.</>}>
        {!mine.length && <p className="ag-empty">None yet. Skills are folders with a SKILL.md file — make your own or import one.</p>}
        <ul className="ag-list">{mine.map((s) => <SkillRow key={s.name} s={s} />)}</ul>
      </Section>
      <Section title="Built in" note="These power the assistant’s one-tap actions. Export one to use it elsewhere or as a starting point for your own.">
        <ul className="ag-list">{builtins.map((s) => <SkillRow key={s.name} s={s} />)}</ul>
      </Section>
    </div>
  );
}

function SkillRow({ s }: { s: SkillInfo }) {
  const toast = useApp((x) => x.toast);
  const [open, setOpen] = useState(false);
  const scripts = s.files.filter((f) => isScriptPath(f.path));
  return (
    <li className={cx('ag-item ag-skill', !s.enabled && 'is-off')}>
      <div className="ag-server-head">
        <button type="button" className="ag-expand" aria-expanded={open} aria-label={`${open ? 'Hide' : 'View'} ${s.name}`} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="ag-item-main">
          <span className="ag-item-title">{s.name}</span>
          <span className="muted small">{s.description}</span>
        </div>
        <label className="ag-switch" title={s.enabled ? 'On' : 'Off'}>
          <input type="checkbox" role="switch" aria-label={`${s.name} on`} checked={s.enabled} onChange={(e) => void requireHub().skills.setEnabled(s.name, e.target.checked)} />
          <span className="switch" aria-hidden />
        </label>
      </div>
      {open && (
        <div className="ag-skill-body">
          {scripts.length > 0 && <p className="ag-note">Includes {scripts.length} {scripts.length === 1 ? 'script' : 'scripts'} ({scripts.map((f) => f.path).join(', ')}). Inkwright never runs them; the assistant can only read them.</p>}
          {s.files.length > 0 && <p className="muted small">Files: {s.files.map((f) => f.path).join(', ')}</p>}
          {(s.license || s.compatibility) && <p className="muted small">{[s.license && `License: ${s.license}`, s.compatibility].filter(Boolean).join(' · ')}</p>}
          <pre className="ag-skill-md">{s.skillMd}</pre>
          <div className="ag-row-acts">
            <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(s.skillMd).then(() => toast({ text: 'Copied SKILL.md' }))}><Copy size={14} /> Copy</button>
            <button type="button" className="btn btn-sm" onClick={() => void exportSkill(s.name).catch((e) => toast({ text: (e as Error).message, tone: 'error' }))}><Download size={14} /> Export</button>
            {!s.builtin && (
              <IconButton label={`Delete ${s.name}`} onClick={async () => { if (await askConfirm(`Delete “${s.name}”?`, 'It is removed from this vault on all your devices.', 'Delete', true)) await requireHub().skills.remove(s.name); }}><Trash2 size={15} /></IconButton>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
