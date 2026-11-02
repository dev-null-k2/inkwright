import { useEffect, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import type { NoteTemplate } from '@inkstone/core';
import { createFromTemplate, listTemplates } from '../../lib/knowledge.ts';
import { useApp } from '../../state/app.ts';

/** "From a template" in the New note sheet: the user's saved templates, one tap to start a note. */
export function TemplateChoices({ open, notebookId, onCreated }: { open: boolean; notebookId?: string; onCreated: (id: string) => void }) {
  const [list, setList] = useState<NoteTemplate[]>([]);
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listTemplates().then((l) => alive && setList(l));
    return () => { alive = false; };
  }, [open]);
  if (!list.length) return null;
  return (
    <div className="template-choices" role="group" aria-label="From a template">
      <span className="field-label">From a template</span>
      <div className="template-row">
        {list.map((t) => (
          <button key={t.id} type="button" className="chip template-chip" onClick={async () => {
            try {
              const id = await createFromTemplate(t.id, { notebookId });
              if (id) onCreated(id);
            } catch (e) {
              toast({ text: `Couldn’t use “${t.name}”: ${(e as Error).message}`, tone: 'error' });
            }
          }}>
            <LayoutTemplate size={14} /> {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}
