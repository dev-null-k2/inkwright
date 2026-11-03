import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, CheckSquare, FileText, Languages, Layers3, ListTodo, Settings2, Sparkles, Square, Tags, X, Wrench } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  extractTodos,
  makeFlashcards,
  runAgent,
  runGroundedTurn,
  runSkill,
  suggestTags,
  suggestTitle,
  summarizeNote,
  translate,
  type AgentEvent,
  type AgentTool,
  type ChatMessage,
  type ContentPart,
  type ToolCall,
} from '@inkwright/ai';
import { newId, pageText, type TextBox } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import type { EditorSession } from '../lib/session.ts';
import { getActiveAI, transcribeWithSource, type ActiveAI } from '../lib/ai.ts';
import { pageImageForAI } from '../lib/exporter.ts';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { askConfirm, askText } from './prompts.tsx';
import { IconButton, cx } from './primitives.tsx';
import { prepareAgentRun, type PreparedRun } from '../lib/agent/assistant.ts';
import { describeMcpToolName } from '../lib/agent/mcp.ts';
import { hostAgentViews, hostPromptInput } from '../lib/agent/hub.ts';
import { undoActivityRun } from '../lib/agent/undo.ts';
import { speak, useVoicePrefs } from '../lib/agent/voice.ts';
import { AgentMenuButton, MicButton, PanelAgentView, PanelWaiting } from './agent/panel.tsx';
import type { AgentViewId } from './agent/shared.tsx';
import { LocalAISetup } from './LocalAISetup.tsx';
import { linkLiveCitations, liveAskContext, useListen } from '../lib/listen/session.ts';
import { nativeSummary } from '../lib/native-ai.ts';
import type { Passage } from '@inkwright/core';
import { inkReplyActions } from '../inkanswer/answer.ts';
import { contextTokensOf, ensurePageRecognized, gatherGrounding, isSmallModel, noteTextForAI, selectionText, sendsImagesTo } from '../lib/assistant/context.ts';
import { requireHub } from '../lib/agent/hub.ts';
import { ChatMenu, usePersistentChat, type PanelItem } from './assistant/ChatMenu.tsx';
import { collectPassages, explainAnswer, genFor, insertAnswer, notePassages, recordSummaryProvenance } from '../compiler/explain.ts';

export type AIRequest = { kind: 'selection'; pageIndex: number; strokeIds: string[]; textIds: string[]; at: number };

/** One message in the panel; persisted per chat (lib/assistant/chats.ts) without its actions. */
type Item = PanelItem;

const TOOL_LABELS: Record<string, string> = {
  list_notes: 'Looked through your notes',
  search_notes: 'Searched your notes',
  read_note: 'Read a note',
  get_page_image: 'Looked at a page',
  create_note: 'Created a note',
  append_to_note: 'Added text to a note',
  update_note: 'Updated a note',
  list_notebooks: 'Checked notebooks',
  create_notebook: 'Created a notebook',
  trash_note: 'Moved a note to Trash',
  load_skill: 'Read a skill',
  read_skill_resource: 'Read a skill file',
  remember: 'Suggested something to remember',
  check_background_task: 'Checked a background task',
  search_memory: 'Searched everything you wrote',
};

/** Label for a tool row: note tools by name, connected-app tools as "Used X in App". */
const toolLabel = (name: string) => TOOL_LABELS[name] ?? ((m) => (m ? `Used ${m.tool} in ${m.server}` : name))(describeMcpToolName(name));

export function AIPanel({ session, engine, request, onClose, onOpenSettings }: { session: EditorSession; engine: InkEngine; request: AIRequest | null; onClose: () => void; onOpenSettings: () => void }) {
  const doc = session.doc;
  const vault = session.vault;
  const toast = useApp((s) => s.toast);
  const confirmDestructive = useSettings((s) => s.ai.confirmDestructive);
  const aiSettings = useSettings((s) => s.ai);
  const [ai, setAi] = useState<ActiveAI | null | undefined>(undefined);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  /** A lasso selection to ask about: as text for every model, as a picture only for strong vision models. */
  const [attach, setAttach] = useState<{ label: string; parts: ContentPart[]; sel: { pageIndex: number; strokeIds: string[]; textIds: string[] } } | null>(null);
  // Conversations persist per note (and general ones) across closing the panel and restarts.
  const chat = usePersistentChat({ scope: doc.meta.id, items, setItems, history, busy });
  const [view, setView] = useState<AgentViewId | null>(null);
  useEffect(() => hostAgentViews((v) => setView(v as AgentViewId)), []);
  // A connected app's prompt was picked: put it in the input to review and send.
  useEffect(() => hostPromptInput((text) => { setView(null); setInput(text); }), []);

  useEffect(() => { void getActiveAI({ source: 'assistant' }).then(setAi).catch(() => setAi(null)); }, [aiSettings]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [items]);

  // A lasso selection was sent here: attach it as an image.
  useEffect(() => {
    if (!request) return;
    void (async () => {
      const page = doc.page(request.pageIndex);
      const strokes = page.strokes.filter((s) => request.strokeIds.includes(s.id));
      const texts = (page.texts ?? []).filter((t) => request.textIds.includes(t.id));
      const pts = strokes.flatMap((s) => s.points);
      const tb = texts.map((t) => ({ minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + 40 }));
      const xs = [...pts.map((p) => p.x), ...tb.flatMap((r) => [r.minX, r.maxX])];
      const ys = [...pts.map((p) => p.y), ...tb.flatMap((r) => [r.minY, r.maxY])];
      const region = xs.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : undefined;
      const img = await pageImageForAI(vault, doc.meta, [...doc.pages], request.pageIndex, region);
      // Recognized on the device right away: the text is what small models read (and cloud models get it too).
      const read = await selectionText(doc, request.pageIndex, request.strokeIds, request.textIds).catch(() => ({ text: texts.map((t) => t.text).join('\n'), unreadInk: strokes.length > 0 }));
      const sel = { pageIndex: request.pageIndex, strokeIds: request.strokeIds, textIds: request.textIds };
      setAttach({ label: `Selection on page ${request.pageIndex + 1}`, sel, parts: [{ type: 'image', mediaType: img.mediaType, data: img.base64 }, ...(read.text ? [{ type: 'text' as const, text: `Text in the selection (typed, and handwriting recognized on this device):\n${read.text}` }] : [])] });
    })();
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = (it: Omit<Item, 'id'>) => {
    const id = newId();
    setItems((x) => [...x, { ...it, id }]);
    return id;
  };
  const patch = (id: string, p: Partial<Item>) => setItems((x) => x.map((i) => (i.id === id ? { ...i, ...p } : i)));

  const pageIndex = engine.currentPageIndex;
  const recordingHere = useListen((s) => s.noteId === doc.meta.id && s.status === 'listening');
  useListen((s) => s.segments.length); // re-link [m:ss] citations as the transcript grows

  const noteContext = () => {
    const parts = doc.pages.map((p, i) => `--- Page ${i + 1} ---\n${pageText(p) || (p.strokes.length ? '(handwriting not yet transcribed)' : '(blank)')}`);
    return `The user has this note open: "${doc.meta.title}" (id ${doc.meta.id}, ${doc.pageCount} pages, currently on page ${pageIndex + 1}).\n${parts.join('\n').slice(0, 12000)}`;
  };

  const insertText = (text: string, i = engine.currentPageIndex) => {
    const page = doc.page(i);
    const ctx = document.createElement('canvas').getContext('2d');
    void ctx;
    const ys = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 60)];
    const y = ys.length ? Math.max(...ys) + 32 : 96;
    const width = (doc.meta.pageSize.width || 794) - 128;
    const box: TextBox = { id: newId(), x: 64, y, width, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'ai' };
    doc.upsertText(i, box, 'AI text');
    toast({ text: 'Added to the page', action: { label: 'Undo', run: () => engine.undo() } });
  };

  const ensureAI = (needVision = false): ActiveAI | null => {
    if (!ai) { push({ role: 'error', text: 'Connect an AI first: add your own key for any provider in Settings.' }); return null; }
    if (needVision && !ai.vision) { push({ role: 'error', text: `${ai.label} can't read images. Choose a vision model (e.g. Gemini Flash, GPT-5 mini, Claude) in Settings.` }); return null; }
    return ai;
  };

  const runQuick = async (kind: 'transcribe' | 'summary' | 'todos' | 'cards' | 'translate' | 'title') => {
    if (busy) return;
    setBusy(true);
    // Handwriting is read on the device first, so every quick action works from text.
    if (kind !== 'transcribe') for (let i = 0; i < Math.min(doc.pageCount, 20); i++) await ensurePageRecognized(doc, i).catch(() => false);
    abort.current = new AbortController();
    const signal = abort.current.signal;
    try {
      if (kind === 'transcribe') {
        push({ role: 'user', text: `Transcribe the handwriting on page ${pageIndex + 1}` });
        const id = push({ role: 'assistant', text: 'Reading your handwriting…' });
        const read = await transcribeWithSource(vault, doc, pageIndex, undefined, 'markdown');
        const text = read?.text ?? '';
        doc.setRecognizedText(doc.page(pageIndex).id, text, read?.by ?? 'ai');
        patch(id, { text: text ? `${text}\n\n_Read by ${read!.by === 'This device' ? 'this device' : read!.by}._` : '_No handwriting found on this page._', actions: text ? [{ label: 'Insert as text', run: () => insertText(text) }, { label: 'Copy', run: () => void navigator.clipboard?.writeText(text) }] : [] });
        return;
      }
      const a = ensureAI();
      if (!a) return;
      const fullText = noteTextForAI(doc);
      if (!fullText.trim() && kind !== 'title') {
        push({ role: 'error', text: 'This note has no typed or recognized text yet. Use “Transcribe page” first so AI can read your handwriting.' });
        return;
      }
      if (kind === 'summary') {
        push({ role: 'user', text: 'Summarize this note' });
        const id = push({ role: 'assistant', text: '…' });
        const s = (await nativeSummary(a, fullText, 'bullets', (so) => patch(id, { text: so }), signal))
          ?? await runSkill(summarizeNote, a.provider, a.model, { title: doc.meta.title, text: fullText, style: 'bullets' }, { signal, onText: (_d, so) => patch(id, { text: so }) });
        const gen = genFor(a, 'skill.summarize/1');
        patch(id, { text: s, actions: [{ label: 'Save as note summary', run: () => { doc.updateMeta((m) => ({ ...m, summary: s })); void recordSummaryProvenance(doc, s, gen); toast({ text: 'Summary saved — it appears in the library and is given to agents' }); } }, { label: 'Insert on page', run: () => void insertAnswer(doc, engine.currentPageIndex, `## Summary\n${s}`, notePassages(doc), gen) }, { label: 'Explain', run: () => void explainAnswer('Summary', s, notePassages(doc), gen) }] });
      } else if (kind === 'todos') {
        push({ role: 'user', text: 'Pull out the to-dos' });
        const id = push({ role: 'assistant', text: 'Looking for tasks…' });
        const todos = await runSkill(extractTodos, a.provider, a.model, { text: fullText, title: doc.meta.title, today: new Date().toISOString().slice(0, 10) } as any, { signal });
        const md = todos.length ? todos.map((t: any) => `- [ ] ${t.text}${t.due ? ` (due ${t.due})` : ''}`).join('\n') : '_No tasks found._';
        patch(id, { text: md, actions: todos.length ? [{ label: 'Add checklist to page', run: () => insertText(`## To-do\n${md}`) }] : [] });
      } else if (kind === 'cards') {
        push({ role: 'user', text: 'Make flashcards' });
        const id = push({ role: 'assistant', text: 'Writing flashcards…' });
        const cards = await runSkill(makeFlashcards, a.provider, a.model, { text: fullText, title: doc.meta.title } as any, { signal });
        const md = cards.map((c: any, i: number) => `**${i + 1}. ${c.q ?? c.question}**\n${c.a ?? c.answer}`).join('\n\n');
        patch(id, { text: md || '_Not enough material for flashcards._', actions: cards.length ? [{ label: 'Add to page', run: () => insertText(`## Flashcards\n\n${md.replace(/\*\*/g, '')}`) }] : [] });
      } else if (kind === 'translate') {
        const lang = await askText('Translate', 'Into which language?', 'Spanish', 'Translate');
        if (!lang) return;
        push({ role: 'user', text: `Translate into ${lang}` });
        const id = push({ role: 'assistant', text: '…' });
        const t = await runSkill(translate, a.provider, a.model, { text: fullText, targetLanguage: lang } as any, { signal, onText: (_d, so) => patch(id, { text: so }) });
        patch(id, { text: t, actions: [{ label: 'Insert on page', run: () => insertText(t) }] });
      } else if (kind === 'title') {
        push({ role: 'user', text: 'Suggest a title and tags' });
        const id = push({ role: 'assistant', text: '…' });
        const text = fullText || doc.meta.title;
        const [title, tags] = await Promise.all([
          runSkill(suggestTitle, a.provider, a.model, { text } as any, { signal }),
          runSkill(suggestTags, a.provider, a.model, { text, existingTags: [...new Set(useApp.getState().notes.flatMap((n) => n.tags))] } as any, { signal }),
        ]);
        patch(id, { text: `**${title}**\n\n${tags.map((t: string) => `#${t}`).join(' ')}`, actions: [{ label: 'Apply', run: () => { doc.rename(title); doc.setTags([...doc.meta.tags, ...tags]); toast({ text: 'Title and tags updated' }); } }] });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') push({ role: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const send = async (spoken?: string) => {
    const q = (spoken ?? input).trim();
    if (!q || busy) return;
    const a = ensureAI();
    if (!a) return;
    setInput('');
    push({ role: 'user', text: attach ? `${q}\n\n_(with ${attach.label.toLowerCase()})_` : q });
    const small = isSmallModel(a);
    // Pictures only for strong vision models; everyone gets the selection's recognized text.
    const content: ContentPart[] = [{ type: 'text', text: q }, ...(attach ? attach.parts.filter((p) => p.type === 'text' || sendsImagesTo(a)) : [])];
    const sel = attach?.sel ?? null;
    setAttach(null);
    const before = history.current;
    if (!small) history.current = [...history.current, { role: 'user', content }];
    setBusy(true);
    abort.current = new AbortController();
    let prep: PreparedRun | null = null;
    let replyId: string | null = null;
    let reply = '';
    const toolItems = new Map<string, string>();
    const read: Passage[] = []; // what the model read this turn ("Explain this answer")
    const confirm = async (call: ToolCall, tool: AgentTool) => {
      // The trust layer asks for writes after the run read something that looks like planted instructions.
      if (tool.confirmReason && !tool.destructive) return askConfirm('Allow this change?', `${tool.confirmReason} The assistant wants to ${TOOL_LABELS[call.name]?.toLowerCase() ?? call.name}: ${JSON.stringify(call.arguments).slice(0, 200)}`, 'Allow');
      const app = describeMcpToolName(call.name);
      if (app) return askConfirm(`Allow ${app.server} to run “${app.tool}”?`, `The assistant wants to use ${app.server}: ${JSON.stringify(call.arguments).slice(0, 300)}`, 'Allow');
      if (!confirmDestructive) return true;
      return askConfirm('Allow this action?', `The assistant wants to ${TOOL_LABELS[call.name]?.toLowerCase() ?? call.name}. ${JSON.stringify(call.arguments).slice(0, 200)}`, 'Allow', true);
    };
    const onEvent = (e: AgentEvent) => {
      if (e.type === 'text') {
        reply += e.delta;
        if (!replyId) replyId = push({ role: 'assistant', text: reply });
        else patch(replyId, { text: reply });
      } else if (e.type === 'tool_start') {
        reply = '';
        replyId = null;
        const q = (e.call.arguments as any)?.query ?? (e.call.arguments as any)?.title ?? '';
        toolItems.set(e.call.id, push({ role: 'tool', text: toolLabel(e.call.name), tool: { name: e.call.name, detail: q ? String(q) : undefined } }));
      } else if (e.type === 'tool_result') {
        collectPassages(e.call.name, e.result, read);
        const id = toolItems.get(e.call.id);
        if (id) patch(id, { tool: { name: e.call.name, ok: true, detail: (e.call.arguments as any)?.query ?? (e.call.arguments as any)?.title } });
      } else if (e.type === 'tool_error') {
        const id = toolItems.get(e.call.id);
        if (id) patch(id, { tool: { name: e.call.name, ok: false, detail: e.denied ? 'not allowed' : e.error } });
      }
    };
    try {
      // While recording, the live transcript so far (with times to cite) joins the note context.
      const live = liveAskContext(doc.meta.id, engine.currentPageIndex, doc.pages[engine.currentPageIndex]);
      let text: string;
      if (small) {
        // Retrieval first for on-device models (lib/assistant/context.ts): the page recognized now,
        // the selection as text, the best passages and memory, then a compact agent.
        const memory = await requireHub().memory.load().catch(() => []);
        const grounding = await gatherGrounding({ ai: a, vault, question: live ? `${q}\n\n${live}` : q, doc, pageIndex: engine.currentPageIndex, selection: sel, memory });
        for (const src of grounding.sources) if (src.noteId) read.push({ noteId: src.noteId, title: src.label, pageIndex: Math.max(0, (src.page ?? 1) - 1), text: src.text });
        prep = await prepareAgentRun({ ai: a, vault, source: 'assistant', label: 'Assistant', prompt: q, openDoc: doc, notes: 'write', skills: false, remember: true, mcp: [] });
        const res = await runGroundedTurn({ provider: a.provider, model: a.model, question: q, history: before, grounding, openNote: { id: doc.meta.id, title: doc.meta.title, currentPage: engine.currentPageIndex + 1 }, tools: prep.tools, contextTokens: contextTokensOf(a), appName: 'Inkwright', today: new Date().toISOString().slice(0, 10), signal: abort.current.signal, onEvent, confirm });
        history.current = [...before, ...res.remember];
        text = res.text;
        // The guardrails may have replaced what streamed (a dodge, or nothing): show the final reply.
        if (replyId) patch(replyId, { text });
        else replyId = push({ role: 'assistant', text });
      } else {
        // Cloud models keep the full agent; the page's handwriting is still read on the device first.
        await ensurePageRecognized(doc, engine.currentPageIndex).catch(() => false);
        // Note tools (logged for undo), skills, memory and connected apps — shared with routines.
        prep = await prepareAgentRun({ ai: a, vault, source: 'assistant', label: 'Assistant', prompt: q, openDoc: doc, notes: 'write', skills: true, remember: true, mcp: 'all', context: live ? `${noteContext()}\n\n${live}` : noteContext() });
        const res = await runAgent({ provider: a.provider, model: a.model, system: prep.system, messages: history.current, tools: prep.tools, maxSteps: 12, signal: abort.current.signal, confirm, onEvent });
        history.current = res.messages.filter((m) => m.role !== 'system');
        text = res.text;
        if (!res.text && !replyId) push({ role: 'assistant', text: 'Done.' });
      }
      if (replyId && text) {
        const gen = genFor(a);
        patch(replyId, { actions: [{ label: 'Explain', run: () => void explainAnswer('Answer', text, read, gen) }, { label: 'Insert on page', run: () => void insertAnswer(doc, engine.currentPageIndex, text, read, gen).then(() => toast({ text: 'Added to the page', action: { label: 'Undo', run: () => engine.undo() } })) }, ...inkReplyActions(doc, engine, text, read, gen)] });
      }
      const run = await prep.recorder.finish('done', { reply: text });
      if (run.ops.length) {
        const n = run.ops.length;
        push({ role: 'tool', text: `${n} ${n === 1 ? 'change' : 'changes'} logged in Activity`, tool: { name: 'activity', ok: true }, actions: [
          { label: 'Undo', run: () => void undoActivityRun(run.id).then((r) => toast({ text: r.notes[0] ?? `Undid ${r.undone} ${r.undone === 1 ? 'change' : 'changes'}` })) },
          { label: 'Review', run: () => setView('activity') },
        ] });
      }
      if (text && useVoicePrefs.getState().speakReplies) speak(text);
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError' || abort.current?.signal.aborted;
      await prep?.recorder.finish(aborted ? 'cancelled' : 'error', { error: aborted ? undefined : (e as Error).message });
      if ((e as Error).name !== 'AbortError') push({ role: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const quick = useMemo(() => [
    { k: 'transcribe' as const, label: 'Transcribe page', icon: <FileText size={15} /> },
    { k: 'summary' as const, label: 'Summarize', icon: <Layers3 size={15} /> },
    { k: 'todos' as const, label: 'To-dos', icon: <ListTodo size={15} /> },
    { k: 'cards' as const, label: 'Flashcards', icon: <CheckSquare size={15} /> },
    { k: 'translate' as const, label: 'Translate', icon: <Languages size={15} /> },
    { k: 'title' as const, label: 'Title & tags', icon: <Tags size={15} /> },
  ], []);

  return (
    <aside className="side-panel ai-panel" aria-label="AI assistant">
      <header className="side-head">
        <h2><Sparkles size={16} /> Assistant</h2>
        <span className="ai-model" title={ai?.label}>{ai === undefined ? '' : ai ? ai.label : 'Not connected'}</span>
        <ChatMenu scope={doc.meta.id} current={chat.thread} onNew={(scope) => { if (!busy) chat.startNew(scope); }} onOpen={(id) => { if (!busy) void chat.open(id); }} />
        <AgentMenuButton onOpen={setView} />
        <IconButton label="AI settings" onClick={onOpenSettings}><Settings2 size={17} /></IconButton>
        <IconButton label="Close assistant" onClick={onClose}><X size={18} /></IconButton>
      </header>
      {ai === null && (
        <div className="ai-setup">
          <LocalAISetup onReady={() => void getActiveAI({ source: 'assistant' }).then(setAi)} />
          <p className="ai-setup-lead">Use any AI with your notes.</p>
          <p className="muted">Add a key from OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, xAI or DeepSeek, or point Inkwright at a local model in Ollama or LM Studio. Keys stay encrypted on this device.</p>
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>Connect an AI</button>
        </div>
      )}
      <div className="ai-quick">
        {quick.map((q) => (
          <button key={q.k} type="button" className="chip" disabled={busy || !ai} onClick={() => void runQuick(q.k)}>{q.icon}{q.label}</button>
        ))}
      </div>
      <div className="ai-log" ref={scroll}>
        {items.length === 0 && ai && (
          <div className="ai-empty">
            <p>Ask about this note or anything you've written.</p>
            <ul>
              <li>“What did I decide about the budget last week?”</li>
              <li>“Make a new note with a packing list for Tokyo”</li>
              <li>“Tag all my biology notes with #exam”</li>
            </ul>
          </div>
        )}
        {items.map((it) => <Message key={it.id} item={it.role === 'assistant' ? { ...it, text: linkLiveCitations(it.text, doc.meta.id) } : it} />)}
        {busy && <div className="ai-typing" aria-live="polite"><span /><span /><span /></div>}
      </div>
      <PanelWaiting onOpen={setView} />
      {attach && (
        <div className="ai-attach">
          <span>{attach.label} attached</span>
          <button type="button" className="icon-btn" aria-label="Remove attachment" onClick={() => setAttach(null)}><X size={14} /></button>
        </div>
      )}
      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea value={input} rows={1} placeholder={ai ? (recordingHere ? 'Ask about what was just said' : 'Ask, or tell it what to do with your notes') : 'Connect an AI to chat'} disabled={!ai}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } e.stopPropagation(); }} />
        {!busy && <MicButton disabled={!ai} onPartial={setInput} onText={(t) => { setInput(t); void send(t); }} />}
        {busy ? (
          <button type="button" className="send-btn" aria-label="Stop" onClick={() => abort.current?.abort()}><Square size={14} fill="currentColor" /></button>
        ) : (
          <button type="submit" className="send-btn" aria-label="Send" disabled={!input.trim() || !ai}><ArrowUp size={18} /></button>
        )}
      </form>
      {view && <PanelAgentView view={view} onBack={() => setView(null)} />}
    </aside>
  );
}

function Message({ item }: { item: Item }) {
  if (item.role === 'tool') {
    return (
      <div className={cx('ai-tool', item.tool?.ok === false && 'is-failed')}>
        <Wrench size={13} /> <span>{item.text}{item.tool?.detail ? `: ${item.tool.detail}` : ''}</span>
        {item.tool?.ok === undefined && <span className="dot-pulse" />}
        {item.actions?.map((a) => <button key={a.label} type="button" className="ai-tool-act" onClick={a.run}>{a.label}</button>)}
      </div>
    );
  }
  // No images, forms, frames or styles: a reply can't load remote content (which could leak note text).
  const html = item.role === 'assistant' ? DOMPurify.sanitize(marked.parse(item.text, { async: false }) as string, { FORBID_TAGS: ['img', 'image', 'svg', 'iframe', 'form', 'input', 'style', 'video', 'audio', 'source', 'object', 'embed'], FORBID_ATTR: ['style', 'srcset'] }) : null;
  return (
    <div className={cx('ai-msg', `is-${item.role}`)}>
      {html != null ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <p>{item.text}</p>}
      {item.actions && item.actions.length > 0 && (
        <div className="ai-actions">{item.actions.map((a) => <button key={a.label} type="button" className="btn btn-sm" onClick={a.run}>{a.label}</button>)}</div>
      )}
    </div>
  );
}
