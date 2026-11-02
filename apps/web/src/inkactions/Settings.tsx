import { useEffect, useState, type ReactNode } from 'react';
import { BookMarked } from 'lucide-react';
import { Segmented, Slider, Switch } from '../ui/primitives.tsx';
import { useModules, isModuleOn } from '../modules/registry.ts';
import { useApp } from '../state/app.ts';
import { DEFAULT_READING, useInkPrefs } from './prefs.ts';
import { availableReadingFonts, queryInstalledFonts } from '../a11y/fonts.ts';
import { listVoices, speechSupported } from '../a11y/readaloud.ts';
import { readingStyle } from '../a11y/ReadingView.tsx';
import { PapersDialogHost, openPapers } from '../papers/PapersDialog.tsx';
import { libraryReferences } from '../papers/library.ts';

/** Settings › Ink actions and Settings › Reading (sections added by the ink-actions modules). */

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

export function InkActionsSettings() {
  const p = useInkPrefs();
  const mods = useModules((m) => m.enabled);
  const notes = useApp((s) => s.notes);
  const on = (id: string) => isModuleOn(id, mods);
  const any = ['ink-answers', 'canvas-run', 'data-sandbox', 'photo-ink', 'papers'].some(on);
  return (
    <>
      {!any && <p className="set-note">These features are switched off. Switch them on in Settings › Modules.</p>}
      {on('ink-answers') && (
        <Group title="AI answers" note="Lasso a question and choose Answer, or ••• › Write the answer here. AI handwriting is marked as AI ink: authorship certificates never count it as yours.">
          <label className="field-row">
            <span className="row-label" id="ia-answer-in">Answer on the page in</span>
            <Segmented label="Answer on the page in" value={p.answerIn} onChange={(v) => p.set({ answerIn: v })} options={[{ value: 'text', label: 'Typed text' }, { value: 'ink', label: 'Handwriting' }]} />
          </label>
          {p.answerIn === 'ink' && (
            <label className="field-row">
              <span className="row-label">Handwriting style</span>
              <Segmented label="Handwriting style" value={p.answerStyle} onChange={(v) => p.set({ answerStyle: v })} options={[{ value: 'script', label: 'Joined' }, { value: 'print', label: 'Print' }]} />
            </label>
          )}
        </Group>
      )}
      {on('papers') && (
        <Group title="Papers and citations" note={`${libraryReferences(notes).length} papers in your library. Type [@ in a text box to cite one.`}>
          <label className="field-row">
            <span className="row-label">Citation style</span>
            <Segmented label="Citation style" value={p.citationStyle} onChange={(v) => p.set({ citationStyle: v })} options={[{ value: 'apa', label: 'APA 7' }, { value: 'ieee', label: 'IEEE' }]} />
          </label>
          <div className="field-row">
            <span className="row-label">Library of papers</span>
            <button type="button" className="btn btn-sm" onClick={openPapers}><BookMarked size={15} aria-hidden /> Import and attach PDFs</button>
          </div>
          <PapersDialogHost />
        </Group>
      )}
      {on('data-sandbox') && (
        <Group title="Data" note="Data files stay in the note, in the same format the code module’s SQL blocks read. Queries run on this device (DuckDB, or SQLite when DuckDB can’t start) and can only read. Every query, including the assistant’s attempts, is logged with the note.">
          <p className="ia-pad">Drop CSV, TSV, JSON or spreadsheet files on a page, or ••• › Add data.</p>
        </Group>
      )}
    </>
  );
}

export function ReadingSettings() {
  const p = useInkPrefs();
  const r = p.reading;
  const set = (patch: Partial<typeof r>) => p.set({ reading: { ...r, ...patch } });
  const [fonts, setFonts] = useState<string[]>(() => availableReadingFonts());
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => { void listVoices().then(setVoices); }, []);
  const askFonts = async () => { const all = await queryInstalledFonts(); if (all?.length) setFonts(all); };
  const canList = typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === 'function';
  return (
    <>
      <Group title="Reading view" note="••• › Reading view shows a note’s typed and recognized text in this style. The page itself is not changed.">
        <label className="field-row">
          <span className="row-label">Font</span>
          <select value={r.font} onChange={(e) => set({ font: e.target.value })} aria-label="Reading font">
            <option value="">App font</option>
            {fonts.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        {canList && <div className="field-row"><span className="row-label">More fonts</span><button type="button" className="btn btn-sm" onClick={() => void askFonts()}>List all fonts on this device</button></div>}
        <Slider label="Text size" value={r.size} min={14} max={32} step={1} onChange={(v) => set({ size: v })} format={(v) => `${v} px`} />
        <Slider label="Letter spacing" value={r.letterSpacing} min={0} max={0.3} step={0.01} onChange={(v) => set({ letterSpacing: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Word spacing" value={r.wordSpacing} min={0} max={0.6} step={0.02} onChange={(v) => set({ wordSpacing: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Line spacing" value={r.lineHeight} min={1.3} max={2.6} step={0.05} onChange={(v) => set({ lineHeight: v })} format={(v) => v.toFixed(2)} />
        <Switch label="Line focus" hint="Keep the line you are reading clear and dim the rest" checked={r.lineFocus} onChange={(v) => set({ lineFocus: v })} />
        <label className="field-row">
          <span className="row-label">Background</span>
          <Segmented label="Reading background" value={r.tint} onChange={(v) => set({ tint: v })} options={[{ value: 'paper', label: 'Paper' }, { value: 'cream', label: 'Cream' }, { value: 'blue', label: 'Blue' }, { value: 'grey', label: 'Grey' }]} />
        </label>
        <div className={`ia-reader ia-reader-preview is-${r.tint}`} style={readingStyle(r)} aria-label="Preview">
          <p className="ia-reader-line is-focus">The quick brown fox jumps over the lazy dog.</p>
        </div>
        <div className="field-row"><span className="row-label" /><button type="button" className="btn btn-sm btn-ghost" onClick={() => p.set({ reading: DEFAULT_READING })}>Reset</button></div>
      </Group>
      <Group title="Read aloud" note={speechSupported() ? '••• › Read aloud reads the page, or the lassoed part, and highlights the ink as it goes. Voices come from this device.' : 'This browser has no text-to-speech voices, so Read aloud is unavailable here.'}>
        <label className="field-row">
          <span className="row-label">Voice</span>
          <select value={p.readAloud.voice ?? ''} onChange={(e) => p.set({ readAloud: { ...p.readAloud, voice: e.target.value || null } })} aria-label="Voice" disabled={!voices.length}>
            <option value="">Device default</option>
            {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
          </select>
        </label>
        <Slider label="Speed" value={p.readAloud.rate} min={0.5} max={2} step={0.05} onChange={(v) => p.set({ readAloud: { ...p.readAloud, rate: v } })} format={(v) => `${v.toFixed(2)}×`} />
      </Group>
    </>
  );
}
