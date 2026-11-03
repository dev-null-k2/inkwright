import { useState } from 'react';
import { FileText, FileUp, Infinity as InfinityIcon, NotebookPen, Signature } from 'lucide-react';
import { PAGE_SIZE_PRESETS, PAPER_STYLES, PAPER_TINTS, PAPER_TEXTURES, type NoteKind, type PageSize, type PaperSpec, type PaperStyle, type PaperTint, type PaperTexture } from '@inkwright/core';
import { Popover, Segmented, cx } from './primitives.tsx';
import { PaperPreview } from './PaperPreview.tsx';
import { useSettings } from '../state/settings.ts';
import { useApp } from '../state/app.ts';
import { createNote } from '../lib/actions.ts';
import { TemplateChoices } from './knowledge/TemplateChoices.tsx';
import { isModuleOn, useModules } from '../modules/registry.ts';

export const STYLE_ORDER: PaperStyle[] = ['blank', 'ruled_narrow', 'ruled_wide', 'dot_grid', 'square_grid', 'graph_mm', 'isometric', 'cornell', 'todo', 'planner_day', 'planner_week', 'music'];

export function PaperPicker({ paper, onChange, size, kind }: { paper: PaperSpec; onChange: (p: PaperSpec) => void; size: PageSize; kind: NoteKind }) {
  return (
    <div className="paper-picker">
      <div className="paper-grid" role="radiogroup" aria-label="Paper">
        {STYLE_ORDER.filter((s) => kind === 'paged' || !s.startsWith('planner') && s !== 'cornell' && s !== 'todo').map((style) => (
          <button key={style} type="button" role="radio" aria-checked={paper.style === style} className={cx('paper-tile', paper.style === style && 'is-on')} onClick={() => onChange({ ...paper, style, spacing: 0 })}>
            <PaperPreview paper={{ ...paper, style, spacing: 0 }} size={size} board={kind === 'board'} width={64} />
            <span>{PAPER_STYLES[style].name}</span>
          </button>
        ))}
      </div>
      <div className="field-row">
        <span className="field-label">Colour</span>
        <div className="swatches" role="radiogroup" aria-label="Paper colour">
          {(Object.keys(PAPER_TINTS) as PaperTint[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={paper.tint === t} aria-label={PAPER_TINTS[t].name} title={PAPER_TINTS[t].name}
              className={cx('swatch', paper.tint === t && 'is-on')} style={{ background: '#' + PAPER_TINTS[t].color.slice(3) }} onClick={() => onChange({ ...paper, tint: t })} />
          ))}
        </div>
      </div>
      <div className="field-row">
        <span className="field-label">Surface</span>
        <Segmented label="Paper surface" value={paper.texture} onChange={(v) => onChange({ ...paper, texture: v as PaperTexture })}
          options={(Object.keys(PAPER_TEXTURES) as PaperTexture[]).map((t) => ({ value: t, label: PAPER_TEXTURES[t].name.split(' ')[0]! }))} />
      </div>
    </div>
  );
}

export function NewNoteSheet({ anchor, open, onClose, notebookId, onImport }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; notebookId?: string; onImport: () => void }) {
  const s = useSettings();
  const navigate = useApp((a) => a.navigate);
  const [kind, setKind] = useState<NoteKind>('paged');
  const [paper, setPaper] = useState<PaperSpec>(s.defaultPaper);
  const [size, setSize] = useState<PageSize>(s.defaultPageSize);
  const [remember, setRemember] = useState(false);
  const mods = useModules((m) => m.enabled);

  const create = async () => {
    if (remember) s.update(() => ({ defaultPaper: paper, defaultPageSize: size }));
    const id = await createNote({ kind, paper, pageSize: size, notebookId });
    onClose();
    if (id) navigate({ name: 'editor', noteId: id });
  };

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} className="new-sheet" placement="below" title="New note">
      <div className="new-sheet-body">
        <Segmented label="Note type" value={kind} onChange={setKind} options={[
          { value: 'paged', label: 'Pages', icon: <NotebookPen size={15} /> },
          { value: 'board', label: 'Infinite canvas', icon: <InfinityIcon size={15} /> },
        ]} />
        <PaperPicker paper={paper} onChange={setPaper} size={size} kind={kind} />
        {kind === 'paged' && (
          <label className="field-row">
            <span className="field-label">Page size</span>
            <select value={size.name} onChange={(e) => setSize(PAGE_SIZE_PRESETS.find((p) => p.name === e.target.value) ?? size)}>
              {PAGE_SIZE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Use this paper for new notes</span>
        </label>
        <TemplateChoices open={open} notebookId={notebookId} onCreated={(id) => { onClose(); navigate({ name: 'editor', noteId: id }); }} />
        {(isModuleOn('documents', mods) || isModuleOn('fill-sign', mods)) && (
          <div className="new-sheet-more" role="group" aria-label="Other ways to start">
            {isModuleOn('documents', mods) && <button type="button" className="btn btn-ghost" onClick={() => { onClose(); void import('../documents/create.ts').then((m) => m.newDocument(notebookId)); }}><FileText size={16} /> New document</button>}
            {isModuleOn('fill-sign', mods) && <button type="button" className="btn btn-ghost" onClick={() => { onClose(); void import('../fill/signFlow.ts').then((m) => m.startSigning(notebookId)); }}><Signature size={16} /> Sign a document</button>}
          </div>
        )}
        <div className="new-sheet-actions">
          <button type="button" className="btn" onClick={onImport}><FileUp size={16} /> Open file</button>
          <button type="button" className="btn btn-primary" onClick={() => void create()}>Create</button>
        </div>
      </div>
    </Popover>
  );
}
