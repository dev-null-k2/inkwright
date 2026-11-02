import { useEffect, useRef, useState } from 'react';
import { Download, FolderInput, FolderOutput, LayoutTemplate, Pencil, Trash2, Upload } from 'lucide-react';
import { PAGE_SIZE_PRESETS, type NoteTemplate } from '@inkwright/core';
import { listTemplates, templateStore } from '../../lib/knowledge.ts';
import { canExportToFolder, exportObsidianToFolder, exportObsidianZip, importMarkdownVault, pickFolder } from '../../lib/obsidian.ts';
import { useApp } from '../../state/app.ts';
import { useKnowledge } from '../../state/knowledge.ts';
import { PaperPicker } from '../NewNoteSheet.tsx';
import { IconButton } from '../primitives.tsx';
import { askConfirm, askText } from '../prompts.tsx';
import { TODAY_KEYS } from './shortcuts.ts';

function Group({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

/** Settings → Notes, links & Obsidian: daily notes, templates, Obsidian export and import. */
export function KnowledgeSettings() {
  const k = useKnowledge();
  const toast = useApp((s) => s.toast);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const reload = () => void listTemplates().then(setTemplates);
  useEffect(reload, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast({ text: (e as Error).message, tone: 'error' }); } finally { setBusy(false); }
  };

  return (
    <>
      <Group title="Daily notes" note={`“Today” in the library (or ${TODAY_KEYS}) opens the note for today in your Journal notebook, titled like 2026-11-01 so [[links]] to days work here and in Obsidian.`}>
        <div className="field">
          <span className="field-label">Start from</span>
          <select value={k.journalTemplateId ?? ''} aria-label="Daily note template" onChange={(e) => k.update(() => ({ journalTemplateId: e.target.value || null }))}>
            <option value="">A blank page with this paper</option>
            {templates.map((t) => <option key={t.id} value={t.id}>Template: {t.name}</option>)}
          </select>
        </div>
        {!k.journalTemplateId && (
          <>
            <PaperPicker paper={k.journalPaper} size={k.journalPageSize} kind="paged" onChange={(p) => k.update(() => ({ journalPaper: p }))} />
            <label className="field-row">
              <span className="field-label">Page size</span>
              <select value={k.journalPageSize.name} onChange={(e) => { const s = PAGE_SIZE_PRESETS.find((x) => x.name === e.target.value); if (s) k.update(() => ({ journalPageSize: s })); }}>
                {PAGE_SIZE_PRESETS.map((p) => <option key={p.name}>{p.name}</option>)}
              </select>
            </label>
          </>
        )}
      </Group>

      <Group title="Templates" note="Save any note as a template from its ••• menu. Typed text can use {{date}}, {{time}}, {{title}} and {{weekday}}; they are filled in when a note starts from it.">
        {!templates.length && <p className="muted small">No templates yet.</p>}
        <ul className="template-list">
          {templates.map((t) => (
            <li key={t.id}>
              <LayoutTemplate size={16} aria-hidden />
              <span className="template-name">{t.name}</span>
              <span className="muted small">{t.pages.length === 1 ? '1 page' : `${t.pages.length} pages`}</span>
              <IconButton label={`Rename ${t.name}`} onClick={async () => { const n = await askText('Rename template', 'Name', t.name, 'Rename'); if (n) { await templateStore()?.rename(t.id, n); reload(); } }}><Pencil size={15} /></IconButton>
              <IconButton label={`Delete ${t.name}`} onClick={async () => {
                if (!(await askConfirm(`Delete “${t.name}”?`, 'Notes made from it are kept.', 'Delete template', true))) return;
                await templateStore()?.delete(t.id);
                if (k.journalTemplateId === t.id) k.update(() => ({ journalTemplateId: null }));
                reload();
              }}><Trash2 size={15} /></IconButton>
            </li>
          ))}
        </ul>
      </Group>

      <Group title="Obsidian" note="Export makes one Markdown file per note with its tags and dates, [[links]] kept, typed and recognized text, and every page as a picture in attachments. Import turns a vault’s Markdown files into notes: folders become notebooks, and links, tags and images come along.">
        <div className="row-buttons">
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
            const n = await exportObsidianZip();
            toast({ text: `Exported ${n} files`, tone: 'success' });
          })}><Download size={16} /> Export as .zip</button>
          {canExportToFolder() && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
              const r = await exportObsidianToFolder();
              if (r) toast({ text: `Wrote ${r.files} files to “${r.folder}/Inkwright”`, tone: 'success' });
            })}><FolderOutput size={16} /> Export into a folder</button>
          )}
        </div>
        <div className="row-buttons">
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const f = await pickFolder(); if (f.length) await importMarkdownVault(f); })}><FolderInput size={16} /> Import a vault folder</button>
          <button type="button" className="btn" disabled={busy} onClick={() => zipInput.current?.click()}><Upload size={16} /> Import a .zip</button>
          <input ref={zipInput} type="file" hidden accept=".zip,application/zip" aria-label="Obsidian vault zip" onChange={(e) => {
            const f = [...(e.target.files ?? [])];
            e.target.value = '';
            if (f.length) void run(async () => { await importMarkdownVault(f); });
          }} />
        </div>
      </Group>
    </>
  );
}
