import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  History,
  Mail,
  NotebookPen,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  SquareCheck,
  Users,
  Video,
  Wand2,
  X,
} from 'lucide-react';
import {
  callService,
  currentMeetingNotes,
  findTemplate,
  formatStamp,
  hasHandEdits,
  meetingHtml,
  meetingMailto,
  meetingMarkdown,
  meetingSlack,
  suggestTemplate,
  type MeetingHeader,
  type MeetingItem,
  type MeetingNotesFile,
  type MeetingNotesVersion,
  type NoteDocument,
  type Recipe,
  type TranscriptFile,
  type TranscriptSegment,
} from '@inkwright/core';
import { parseEnhancedNotes } from '@inkwright/ai';
import { useApp } from '../state/app.ts';
import type { AppVault } from '../lib/vault.ts';
import { ensurePageRecognized } from '../lib/assistant/context.ts';
import { focusSaid, useListen } from '../lib/listen/session.ts';
import { loadNoteTranscripts } from '../lib/listen/transcripts.ts';
import { TranscriptPanel } from '../ui/TranscriptPanel.tsx';
import { CaptionPicker, LiveBar, StatsCard, shareClip, useCaptionLanguage, useTranslations } from './LiveTools.tsx';
import { IconButton, Menu, Popover, cx } from '../ui/primitives.tsx';
import { askConfirm, askText } from '../ui/prompts.tsx';
import { editMeetingNotesByAsking, enhanceMeetingNotes, notesTextOf, runRecipe, saveHandEdit } from './enhance.ts';
import { meetingReplyHtml } from './render.ts';
import { ShareDialog } from './ShareDialog.tsx';
import { allRecipes, allTemplates, loadMeetingsLibrary, onMeetingNotesChanged, readMeetingNotes, showMeetingNotesVersion, useMeetingsLibrary } from './store.ts';
import './meetings.css';

type Tab = 'notes' | 'transcript' | 'recipes';

export interface MeetingPanelProps {
  doc: NoteDocument;
  vault: AppVault;
  recording: boolean;
  playing: { clipId: string; position: number; playing: boolean } | null;
  onClose: () => void;
  /** Writes the enhanced notes onto the page (typed, or in the person's handwriting). */
  onWriteOnPage?: (v: MeetingNotesVersion, style: 'typed' | 'hand') => void;
}

/** Copies rich text (HTML, with plain text for apps that take only that). */
async function copyRich(html: string, text: string): Promise<void> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      return;
    }
  } catch { /* fall back to plain text */ }
  await navigator.clipboard.writeText(text);
}

export function headerOf(doc: NoteDocument): MeetingHeader {
  return { title: doc.meta.title, at: doc.meta.meeting?.event?.start ?? doc.meta.createdAt, attendees: doc.meta.meeting?.attendees ?? [] };
}

export function MeetingPanel({ doc, vault, recording, playing, onClose, onWriteOnPage }: MeetingPanelProps) {
  const live = useListen();
  const isLive = live.noteId === doc.meta.id && (recording || live.status !== 'idle');
  // While recording, the live transcript; a meeting (or a note already enhanced) opens on its notes.
  const isMeeting = !!doc.meta.meeting || doc.meta.tags.includes('meeting');
  const [tab, setTab] = useState<Tab>(isLive || recording || !isMeeting ? 'transcript' : 'notes');
  useEffect(() => {
    if (isMeeting || isLive || recording) return;
    let alive = true;
    void readMeetingNotes(vault, doc.meta.id).then((f) => { if (alive && f) setTab((t) => (t === 'transcript' ? 'notes' : t)); });
    return () => { alive = false; };
  }, [vault, doc.meta.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadMeetingsLibrary(vault); }, [vault]);
  return (
    <aside className="side-panel mtg-panel" aria-label="Meeting">
      <header className="side-head">
        <h2><NotebookPen size={16} /> Meeting</h2>
        {isLive && <span className="mtg-live" aria-label="Recording"><span className="mtg-live-dot" />Live</span>}
        <IconButton label="Close meeting panel" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <MeetingInfoBar doc={doc} />
      <div className="mtg-tabs" role="tablist" aria-label="Meeting views">
        {([['notes', 'Notes'], ['transcript', 'Transcript'], ['recipes', 'Recipes']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={cx('mtg-tab', tab === id && 'is-on')} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'notes' && <NotesTab doc={doc} vault={vault} isLive={isLive} onWriteOnPage={onWriteOnPage} />}
      {tab === 'transcript' && <TranscriptTab doc={doc} vault={vault} recording={recording} playing={playing} onClose={onClose} isLive={isLive} />}
      {tab === 'recipes' && <RecipesTab doc={doc} vault={vault} />}
    </aside>
  );
}

// ---- Transcript, with live tools, captions and clips ----------------------------------------------

function TranscriptTab({ doc, vault, recording, playing, onClose, isLive }: { doc: NoteDocument; vault: AppVault; recording: boolean; playing: MeetingPanelProps['playing']; onClose: () => void; isLive: boolean }) {
  const toast = useApp((s) => s.toast);
  const live = useListen();
  const [lang, setLang] = useCaptionLanguage();
  const [saved, setSaved] = useState<TranscriptSegment[]>([]);
  useEffect(() => {
    if (isLive) return;
    void loadNoteTranscripts(vault, doc.meta).then((rs) => setSaved(rs.at(-1)?.file.segments ?? []));
  }, [vault, doc.meta.id, isLive, live.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const segments = isLive ? live.segments : saved;
  const translations = useTranslations(segments, lang, [doc.meta]);
  return (
    <div className="mtg-body">
      {isLive && <LiveBar doc={doc} />}
      <div className="mtg-tr-tools"><CaptionPicker lang={lang} onChange={setLang} /></div>
      <TranscriptPanel embedded doc={doc} vault={vault} recording={recording} playing={playing} onClose={onClose}
        extras={{ translations, onClip: (clip, segs, ms) => void shareClip(vault, doc, clip, segs, ms).then((r) => toast({ text: r === 'saved' ? 'Clip saved' : 'Clip shared' })).catch((e) => toast({ text: (e as Error).message, tone: 'error' })) }} />
    </div>
  );
}

// ---- Who, when, which template ----------------------------------------------------------------------

function MeetingInfoBar({ doc }: { doc: NoteDocument }) {
  const lib = useMeetingsLibrary((s) => s.library);
  const [, force] = useState(0);
  const tplBtn = useRef<HTMLButtonElement>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const m = doc.meta.meeting;
  const attendees = m?.attendees ?? [];
  const template = m?.template ? findTemplate(m.template, lib.templates) : suggestTemplate(doc.meta.title, lib.templates, attendees.length ? attendees.length + 1 : 0);
  const service = callService(m?.event?.link);
  const update = (patch: Partial<NonNullable<typeof m>>) => {
    doc.updateMeta((meta) => ({ ...meta, meeting: { ...(meta.meeting ?? {}), ...patch } }));
    force((x) => x + 1);
  };
  const addPerson = async () => {
    const v = await askText('Add someone', 'Name, or name and email (Jane Doe jane@acme.com)', '', 'Add');
    if (!v?.trim()) return;
    const email = /[^\s<>]+@[^\s<>]+\.[a-z]{2,}/i.exec(v)?.[0]?.toLowerCase();
    const name = v.replace(email ?? '', '').replace(/[<>]/g, '').trim() || (email ? email.split('@')[0]! : v.trim());
    update({ attendees: [...attendees, { name, ...(email ? { email } : {}) }] });
  };
  return (
    <div className="mtg-info">
      <button ref={tplBtn} type="button" className="mtg-chip" onClick={() => setTplOpen(true)} aria-haspopup="menu" title="Template: the shape of the enhanced notes">
        <Wand2 size={13} aria-hidden /> {template.name} <ChevronDown size={12} aria-hidden />
      </button>
      <Popover anchor={tplBtn.current} open={tplOpen} onClose={() => setTplOpen(false)} title="Template" className="mtg-tpl-pop">
        <ul className="mtg-tpl-list">
          {allTemplates(lib).map((t) => (
            <li key={t.id}>
              <button type="button" className={cx('mtg-tpl', t.id === template.id && 'is-on')} onClick={() => { update({ template: t.id }); setTplOpen(false); }}>
                <span className="mtg-tpl-name">{t.name}{!t.builtIn && <em> · yours</em>}</span>
                <span className="mtg-tpl-desc">{t.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
      {attendees.map((a, i) => (
        <span key={`${a.email ?? a.name}-${i}`} className="mtg-person" title={a.email ?? a.name}>
          {a.name}
          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => update({ attendees: attendees.filter((_, j) => j !== i) })}><X size={11} /></button>
        </span>
      ))}
      <button type="button" className="mtg-chip mtg-add" onClick={() => void addPerson()} aria-label="Add someone to the meeting"><Users size={13} aria-hidden /><Plus size={11} aria-hidden /></button>
      {m?.event?.link && (
        <a className="mtg-chip mtg-join" href={m.event.link} target="_blank" rel="noopener noreferrer"><Video size={13} aria-hidden /> Join{service ? ` ${service}` : ''}</a>
      )}
    </div>
  );
}

// ---- Enhanced notes -----------------------------------------------------------------------------

function NotesTab({ doc, vault, isLive, onWriteOnPage }: { doc: NoteDocument; vault: AppVault; isLive: boolean; onWriteOnPage?: MeetingPanelProps['onWriteOnPage'] }) {
  const toast = useApp((s) => s.toast);
  const [file, setFile] = useState<MeetingNotesFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [partial, setPartial] = useState('');
  const [ask, setAsk] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [menu, setMenu] = useState<null | 'copy' | 'versions' | 'more'>(null);
  const copyBtn = useRef<HTMLButtonElement>(null);
  const verBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [segs, setSegs] = useState<{ clipId: string; durationMs: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => void readMeetingNotes(vault, doc.meta.id).then((f) => { if (alive) { setFile(f); setLoaded(true); } });
    load();
    const off = onMeetingNotesChanged((id) => { if (id === doc.meta.id) load(); });
    return () => { alive = false; off(); };
  }, [vault, doc.meta.id]);
  useEffect(() => {
    void loadNoteTranscripts(vault, doc.meta).then((rs) => {
      const r = [...rs].sort((a, b) => b.clip.durationMs - a.clip.durationMs)[0];
      setSegs(r ? { clipId: r.clip.id, durationMs: r.clip.durationMs } : null);
    });
  }, [vault, doc.meta.id, doc.meta.recordings?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const version = currentMeetingNotes(file);
  const header = headerOf(doc);

  // While the AI writes, show the notes taking shape (parsed as they stream in).
  const streaming = useMemo(() => (partial ? parseEnhancedNotes(partial, { notes: '', ...(segs ? { clipId: segs.clipId, durationMs: segs.durationMs } : {}) }) : null), [partial, segs]);

  const run = async (what: string, fn: (signal: AbortSignal) => Promise<unknown>) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(what);
    setPartial('');
    try {
      await fn(ctrl.signal);
    } catch (e) {
      if (!ctrl.signal.aborted) toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      if (abort.current === ctrl) { setBusy(null); setPartial(''); abort.current = null; }
    }
  };

  const enhance = async (reason: 'enhance' | 'regenerate', templateId?: string) => {
    if (reason === 'regenerate' && hasHandEdits(file)) {
      const yes = await askConfirm('Regenerate the notes?', 'You edited these notes. Regenerating writes new ones; your edited version stays in Versions.', 'Regenerate');
      if (!yes) return;
    }
    await run('Enhancing your notes…', async (signal) => {
      for (let i = 0; i < doc.pageCount; i++) await ensurePageRecognized(doc, i).catch(() => false);
      await enhanceMeetingNotes({ vault, note: doc.meta, pages: doc.pages, reason, ...(templateId ? { templateId } : {}), signal, onText: setPartial });
    });
  };

  const submitAsk = async () => {
    const request = ask.trim();
    if (!request) return;
    setAsk('');
    await run('Changing the notes…', (signal) => editMeetingNotesByAsking({ vault, note: doc.meta, pages: doc.pages, request, signal, onText: setPartial }));
  };

  const toggleDone = async (it: MeetingItem) => {
    if (!version) return;
    const sections = version.sections.map((s) => ({ ...s, items: s.items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) }));
    await saveHandEdit(vault, doc.meta.id, version, sections);
  };

  const editItem = async (it: MeetingItem) => {
    if (!version) return;
    const text = await askText('Edit line', 'Text (empty to remove the line)', it.text);
    if (text == null) return;
    const sections = version.sections.map((s) => ({ ...s, items: text.trim() ? s.items.map((x) => (x.id === it.id ? { ...x, text: text.trim() } : x)) : s.items.filter((x) => x.id !== it.id) })).filter((s) => s.items.length);
    await saveHandEdit(vault, doc.meta.id, version, sections);
  };

  const shown = busy && streaming?.sections.length ? { tldr: streaming.tldr, sections: streaming.sections } : version;
  const hasMaterial = (doc.meta.recordings?.length ?? 0) > 0 || notesTextOf(doc.pages).trim().length > 0 || doc.pages.some((p) => p.strokes.length);

  return (
    <div className="mtg-body">
      <div className="mtg-scroll">
        {!shown && loaded && !busy && (
          <div className="mtg-empty">
            <Sparkles size={22} aria-hidden />
            <h3>Enhanced notes</h3>
            <p>Write what matters to you; Inkwright fills in the rest from what was said. Your words stay yours, in ink; what the AI adds is grey, with a link to the moment it was said.</p>
            {isLive ? <p className="mtg-hint">Recording now. Your notes are enhanced when it ends.</p> : null}
            <button type="button" className="btn btn-primary" disabled={!hasMaterial || isLive} onClick={() => void enhance('enhance')}><Sparkles size={15} /> Enhance notes</button>
            {!hasMaterial && <p className="mtg-hint">Record the meeting or write some notes first.</p>}
          </div>
        )}
        {shown && (
          <article className={cx('mtg-notes', busy && 'is-writing')} aria-busy={!!busy}>
            {shown.tldr && <p className="mtg-tldr">{shown.tldr}</p>}
            {shown.sections.map((s) => {
              const actions = /action|next step|to.?do|follow.?up|tasks?\b/i.test(s.heading);
              return (
                <section key={s.heading} className="mtg-section">
                  <h3>{s.heading}</h3>
                  <ul>
                    {s.items.map((it) => (
                      <li key={it.id} className={cx('mtg-item', it.mine ? 'is-mine' : 'is-ai', it.depth === 1 && 'is-sub', it.done && 'is-done')}>
                        {actions && (
                          <button type="button" className="mtg-check" aria-label={it.done ? 'Mark not done' : 'Mark done'} aria-pressed={!!it.done} disabled={!!busy || !version} onClick={() => void toggleDone(it)}>
                            {it.done ? <SquareCheck size={16} /> : <Square size={16} />}
                          </button>
                        )}
                        <span className="mtg-text" onDoubleClick={() => !busy && void editItem(it)}>{it.text}</span>
                        {it.owner && <span className="mtg-owner">{it.owner}</span>}
                        {it.cites?.slice(0, 2).map((ms) => (
                          <button key={ms} type="button" className="mtg-cite" title="Hear this moment and see what you wrote" onClick={() => it.clipId && focusSaid(doc.meta.id, it.clipId, ms, 'link')} disabled={!it.clipId}>{formatStamp(ms)}</button>
                        ))}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {version && !busy && <p className="mtg-by">{version.reason === 'edit' ? 'Edited by you' : version.reason === 'ask' ? `Changed as asked: “${version.request}”` : `Enhanced with ${version.by}`} · {new Date(version.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>}
          </article>
        )}
        {busy && !streaming?.sections.length && <p className="mtg-status" aria-live="polite"><span className="dot-pulse" /> {busy}</p>}
      </div>
      {version && (
        <div className="mtg-bar">
          <button ref={copyBtn} type="button" className="btn btn-sm" onClick={() => setMenu('copy')} disabled={!!busy}><Copy size={14} /> Copy</button>
          <button type="button" className="btn btn-sm" onClick={() => setShareOpen(true)} disabled={!!busy}><Send size={14} /> Share</button>
          <button type="button" className="btn btn-sm" onClick={() => void enhance('regenerate')} disabled={!!busy || isLive} title="Write the notes again"><RefreshCw size={14} /> Regenerate</button>
          <button ref={verBtn} type="button" className="btn btn-sm btn-ghost" onClick={() => setMenu('versions')} disabled={!!busy} aria-label="Versions"><History size={14} /></button>
          <button ref={moreBtn} type="button" className="btn btn-sm btn-ghost" onClick={() => setMenu('more')} disabled={!!busy} aria-label="More"><PenLine size={14} /></button>
          {busy && <button type="button" className="btn btn-sm btn-ghost" onClick={() => abort.current?.abort()}>Stop</button>}
        </div>
      )}
      <Popover anchor={copyBtn.current} open={menu === 'copy'} onClose={() => setMenu(null)}>
        {version && <Menu onClose={() => setMenu(null)} items={[
          { label: 'Copy notes', icon: <Copy size={15} />, hint: 'For Docs, Notion, email', onClick: () => void copyRich(meetingHtml(header, version), meetingMarkdown(header, version, { stamps: false })).then(() => toast({ text: 'Copied' })) },
          { label: 'Copy as Markdown', icon: <Copy size={15} />, onClick: () => void navigator.clipboard.writeText(meetingMarkdown(header, version)).then(() => toast({ text: 'Copied Markdown' })) },
          { label: 'Copy for Slack', icon: <Copy size={15} />, onClick: () => void navigator.clipboard.writeText(meetingSlack(header, version)).then(() => toast({ text: 'Copied for Slack' })) },
          { label: 'Email to attendees', icon: <Mail size={15} />, onClick: () => { window.location.href = meetingMailto(header, version, (header.attendees ?? []).map((a) => a.email).filter((e): e is string => !!e)); } },
        ]} />}
      </Popover>
      <Popover anchor={verBtn.current} open={menu === 'versions'} onClose={() => setMenu(null)} title="Versions">
        {file && <Menu onClose={() => setMenu(null)} items={[...file.versions].reverse().map((v) => ({
          label: `${v.reason === 'edit' ? 'Your edit' : v.reason === 'ask' ? `Asked: ${v.request ?? ''}`.slice(0, 40) : v.reason === 'regenerate' ? 'Regenerated' : 'Enhanced'}`,
          hint: new Date(v.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }),
          icon: v.id === file.current ? <Check size={15} /> : <History size={15} />,
          onClick: () => void showMeetingNotesVersion(vault, doc.meta.id, v.id),
        }))} />}
      </Popover>
      <Popover anchor={moreBtn.current} open={menu === 'more'} onClose={() => setMenu(null)}>
        {version && <Menu onClose={() => setMenu(null)} items={[
          ...(onWriteOnPage ? [
            { label: 'Write on the page in my handwriting', icon: <PenLine size={15} />, onClick: () => onWriteOnPage(version, 'hand') },
            { label: 'Add to the page as text', icon: <NotebookPen size={15} />, onClick: () => onWriteOnPage(version, 'typed') },
          ] : []),
          { label: 'Use another template…', icon: <Wand2 size={15} />, onClick: () => void (async () => {
            const lib = useMeetingsLibrary.getState().library;
            const names = allTemplates(lib).map((t) => t.name).join(', ');
            const v = await askText('Regenerate with a template', `Template (${names})`, findTemplate(version.template, lib.templates).name, 'Regenerate');
            const t = v && allTemplates(lib).find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
            if (t) { doc.updateMeta((m) => ({ ...m, meeting: { ...(m.meeting ?? {}), template: t.id } })); await enhance('regenerate', t.id); }
          })() },
        ]} />}
      </Popover>
      {version && (
        <form className="mtg-ask" onSubmit={(e) => { e.preventDefault(); void submitAsk(); }}>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask to change the notes: shorter, add pricing details…" aria-label="Ask to change the notes" disabled={!!busy} />
          <button type="submit" className="mtg-ask-send" disabled={!ask.trim() || !!busy} aria-label="Change the notes"><ArrowUp size={16} /></button>
        </form>
      )}
      {shareOpen && version && <ShareDialog header={header} version={version} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

// ---- Recipes on this meeting -------------------------------------------------------------------------

function RecipesTab({ doc, vault }: { doc: NoteDocument; vault: AppVault }) {
  const toast = useApp((s) => s.toast);
  const navigate = useApp((s) => s.navigate);
  const lib = useMeetingsLibrary((s) => s.library);
  const recipes = allRecipes(lib).filter((r) => r.scope === 'meeting');
  const [result, setResult] = useState<{ recipe: Recipe; text: string; done: boolean } | null>(null);
  const [single, setSingle] = useState<{ noteId: string; clipId: string; segments: TranscriptSegment[] } | null>(null);
  const [files, setFiles] = useState<TranscriptFile[]>([]);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    void loadNoteTranscripts(vault, doc.meta).then((rs) => {
      const r = rs[rs.length - 1];
      setSingle(r ? { noteId: doc.meta.id, clipId: r.clip.id, segments: r.file.segments } : null);
      setFiles(rs.map((x) => x.file));
    });
  }, [vault, doc.meta.id, doc.meta.recordings?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async (recipe: Recipe) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setResult({ recipe, text: '', done: false });
    try {
      const r = await runRecipe({ vault, recipe, notes: [doc.meta], signal: ctrl.signal, onText: (t) => setResult({ recipe, text: t, done: false }) });
      setResult({ recipe, text: r.text, done: true });
    } catch (e) {
      if (!ctrl.signal.aborted) { toast({ text: (e as Error).message, tone: 'error' }); setResult(null); }
    }
  };

  const html = result ? meetingReplyHtml(result.text.replace(/<think>[\s\S]*?(<\/think>|$)/g, ''), [doc.meta], single) : '';
  const isEmail = result && /^\s*Subject:/im.test(result.text);
  return (
    <div className="mtg-body">
      <div className="mtg-scroll">
        {!result && (
          <>
            <StatsCard files={files} them={(doc.meta.meeting?.attendees?.length ?? 0) === 1 ? doc.meta.meeting!.attendees![0]!.name : undefined} />
            <p className="mtg-hint mtg-pad">Run a recipe on this meeting. Across several meetings: Meetings in the library.</p>
            <ul className="mtg-recipes">
              {recipes.map((r) => (
                <li key={r.id}>
                  <button type="button" className="mtg-recipe" onClick={() => void go(r)}>
                    <span className="mtg-recipe-name">{r.name}{!r.builtIn && <em> · yours</em>}</span>
                    <span className="mtg-recipe-desc">{r.description}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-ghost btn-sm mtg-pad" onClick={() => navigate({ name: 'settings', section: 'meetings' })}><Plus size={14} /> Make your own recipe</button>
          </>
        )}
        {result && (
          <article className="mtg-result">
            <header>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { abort.current?.abort(); setResult(null); }}>← Recipes</button>
              <h3>{result.recipe.name}</h3>
            </header>
            {result.text ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="mtg-status"><span className="dot-pulse" /> Working…</p>}
            {result.done && (
              <div className="mtg-bar">
                <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(result.text).then(() => toast({ text: 'Copied' }))}><Copy size={14} /> Copy</button>
                {isEmail && <button type="button" className="btn btn-sm" onClick={() => {
                  const to = (doc.meta.meeting?.attendees ?? []).map((a) => a.email).filter((e): e is string => !!e);
                  window.location.href = meetingMailto(headerOf(doc), { id: 'x', at: 0, by: '', template: '', clipIds: [], sections: [] }, to, result.text);
                }}><Mail size={14} /> Open in mail</button>}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void go(result.recipe)}><RefreshCw size={14} /> Again</button>
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  );
}

