import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Bold, CheckSquare, ChevronDown, Code, Copy, Eraser, FileCode2, FileDown, FileText, FileType2, FileUp, Heading, Highlighter, ImagePlus, Italic,
  Link2, List, ListOrdered, ListTree, Minus, MoreHorizontal, PenLine, Printer, Quote, Redo2, Rows3, Scissors, Sparkles, SquareCode, Strikethrough,
  Table2, Trash2, Underline, Undo2, X,
} from 'lucide-react';
import { Editor } from '@tiptap/core';
import { DOCUMENT_ROLE, documentBody, type NoteDocument, type TextBox } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import type { EditorSession } from '../lib/session.ts';
import { duplicateNote, trashNote } from '../lib/actions.ts';
import { pickFiles } from '../platform/files.ts';
import { saveDocument } from '../platform/saveAs.ts';
import { isMac, isNative, modKey } from '../platform/env.ts';
import { useApp } from '../state/app.ts';
import { activePreset, useSettings } from '../state/settings.ts';
import { isModuleOn, useModules } from '../modules/registry.ts';
import { AIPanel } from '../ui/AIPanel.tsx';
import { IconButton, Menu, Popover, cx, useMediaQuery } from '../ui/primitives.tsx';
import { askText } from '../ui/prompts.tsx';
import { ThemeToggle } from '../ui/ThemeToggle.tsx';
import { NewNoteButton } from '../ui/NewNoteButton.tsx';
import { FingerDrawButton, useFingerDraw } from '../ui/FingerDraw.tsx';
import { PenNib } from '../ui/PenNib.tsx';
import { documentExtensions } from './extensions.ts';
import { assetsIn, markdownToHtml, prepareHtml, toMarkdown, type PMNode } from './markdown.ts';
import { InkLayer } from './InkLayer.tsx';
import { documentBodyBox } from './create.ts';
import './documents.css';

declare const __E2E__: boolean;
/** Test builds expose the open document and its editor to end-to-end tests; releases never do. */
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

/**
 * The document editor: typed, formatted text (Tiptap/ProseMirror) on a sheet, with ink on top.
 *
 * Where things live (docs/VAULT_FORMAT.md › Documents): the body is the note's `role: "document"`
 * text box as Markdown; typing saves it a moment after you pause (one `NoteDocument.adjust`, so
 * it is not an ink undo step — the text editor has its own undo); ink annotations are strokes on
 * the same page. Changes that arrive from elsewhere (the assistant's edit_document, sync, version
 * history) replace the editor's content when they differ from what it last saved. Text another
 * feature drops onto the page as a separate box (the assistant's "Insert on page", dictation) is
 * folded into the document at the end, as one undo step.
 */
export default function DocumentEditor({ session, onBack }: { session: EditorSession; onBack: () => void }) {
  const doc = session.doc;
  const vault = session.vault;
  const noteId = doc.meta.id;
  const { navigate, toast } = useApp();
  const mods = useModules((m) => m.enabled);
  const wide = useMediaQuery('(min-width: 900px)');
  const roomForTheme = useMediaQuery('(min-width: 600px)');
  const width = doc.meta.document?.width ?? 720;

  const host = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const tableBtn = useRef<HTMLButtonElement>(null);
  const formatBtn = useRef<HTMLButtonElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, setTick] = useState(0);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [panel, setPanel] = useState<'outline' | 'ai' | null>(null);
  const [menu, setMenu] = useState<'more' | 'table' | 'format' | null>(null);
  const [annotate, setAnnotate] = useState(false);
  const [inkTool, setInkTool] = useState<'pen' | 'eraser'>('pen');
  const [exporting, setExporting] = useState(false);
  const [containerW, setContainerW] = useState(0);
  const finger = useFingerDraw();
  const settings = useSettings();
  const pen = activePreset(settings);

  // ---- Images in the note: asset name → displayable URL ----------------------------------------
  const urls = useRef(new Map<string, string>());
  useEffect(() => () => { for (const u of urls.current.values()) URL.revokeObjectURL(u); }, []);
  const resolve = useCallback((name: string) => urls.current.get(name), []);
  const loadAssets = useCallback(async (md: string) => {
    for (const name of assetsIn(md)) {
      if (urls.current.has(name)) continue;
      const bytes = await vault.vault.readAsset(noteId, name);
      if (bytes) urls.current.set(name, URL.createObjectURL(new Blob([bytes as BlobPart], { type: /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg' })));
    }
  }, [vault, noteId]);

  // ---- Saving ----------------------------------------------------------------------------------
  const lastSaved = useRef<string | null>(null);
  const saveTimer = useRef(0);
  const editorRef = useRef<Editor | null>(null);
  const save = useCallback((e: Editor | null = editorRef.current) => {
    clearTimeout(saveTimer.current);
    if (!e || e.isDestroyed) return;
    const md = toMarkdown(e.getJSON() as PMNode);
    if (md === lastSaved.current) return;
    const page = doc.page(0);
    const list = page.texts ?? [];
    const i = list.findIndex((t) => t.role === DOCUMENT_ROLE);
    lastSaved.current = md;
    if (i < 0) {
      doc.adjust(0, { label: 'Edit document', texts: { removed: [], added: [{ index: list.length, item: documentBodyBox(md) }] } });
    } else {
      doc.adjust(0, { label: 'Edit document', texts: { removed: [{ index: i, item: list[i]! }], added: [{ index: i, item: { ...list[i]!, text: md } }] } });
    }
  }, [doc]);

  // ---- The editor ------------------------------------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    let e: Editor | null = null;
    const md = documentBody(doc.page(0))?.text ?? '';
    void loadAssets(md).then(() => {
      if (!alive || !host.current) return;
      lastSaved.current = md;
      e = new Editor({
        element: host.current,
        extensions: documentExtensions(),
        content: markdownToHtml(md, resolve),
        editorProps: { attributes: { class: 'doc-prose', 'aria-label': 'Document', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' } },
        onUpdate: () => { clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => save(), 450); },
        onTransaction: () => setTick((t) => t + 1),
      });
      editorRef.current = e;
      setEditor(e);
      // A new, empty document starts with the cursor in it.
      if (!md.trim()) e.commands.focus('end');
    });
    return () => {
      alive = false;
      if (e) { save(e); e.destroy(); }
      editorRef.current = null;
    };
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // Test hook (only with ?e2e): the note and the text editor, so specs can check what is saved.
  useEffect(() => {
    if (E2E_BUILD) (window as any).__inkwright = { doc, engine: null, docEditor: editor };
  }, [doc, editor]);

  // Saving state for the dot by the title.
  useEffect(() => {
    const prev = session.onSaved;
    session.onSaved = (st) => setSaveState(st === 'saving' ? 'saving' : st === 'error' ? 'error' : 'saved');
    return () => { session.onSaved = prev; };
  }, [session]);

  // ---- Changes from elsewhere -------------------------------------------------------------------
  const quiet = useRef(false);
  useEffect(() => doc.subscribe(() => {
    if (quiet.current) return;
    const page = doc.page(0);
    // Typed text other features dropped on the page joins the document.
    const strays = (page.texts ?? []).filter((t) => t.role !== DOCUMENT_ROLE && t.text.trim());
    if (strays.length) { absorb(doc, strays); return; }
    const md = documentBody(page)?.text ?? '';
    const e = editorRef.current;
    if (!e || e.isDestroyed || md === lastSaved.current) return;
    lastSaved.current = md;
    void loadAssets(md).then(() => { if (!e.isDestroyed) e.commands.setContent(markdownToHtml(md, resolve), { emitUpdate: false }); });
  }), [doc, loadAssets, resolve]);

  const absorbed = useRef(false);
  const absorb = (d: NoteDocument, strays: TextBox[]) => {
    // Quiet while folding in: saving and the commit below notify this same subscriber.
    quiet.current = true;
    let next = '';
    try {
      save();
      const page = d.page(0);
      const list = page.texts ?? [];
      const body = documentBody(page);
      const add = strays.map((t) => t.text.trim()).join('\n\n');
      next = body ? `${body.text.trimEnd()}\n\n${add}\n` : `${add}\n`;
      const removed = list.map((t, index) => ({ index, item: t })).filter((x) => strays.includes(x.item) || x.item === body);
      const bi = body ? list.indexOf(body) : 0;
      d.commit(0, { label: 'Add to document', texts: { removed, added: [{ index: Math.min(bi, list.length - removed.length), item: body ? { ...body, text: next } : documentBodyBox(next) }] } });
    } finally { quiet.current = false; }
    absorbed.current = true;
    lastSaved.current = next;
    void loadAssets(next).then(() => editorRef.current?.commands.setContent(markdownToHtml(next, resolve), { emitUpdate: false }));
  };

  /**
   * What the assistant panel sees as "the canvas": page 0, and an undo that also takes back the
   * folding-in of text it just inserted (two steps: the fold, then the insert).
   */
  const engineForPanel = useMemo(() => ({
    get currentPageIndex() { return 0; },
    undo: () => {
      quiet.current = true;
      try {
        if (absorbed.current) { doc.undo(); absorbed.current = false; }
        doc.undo();
      } finally { quiet.current = false; }
      const md = documentBody(doc.page(0))?.text ?? '';
      lastSaved.current = md;
      editorRef.current?.commands.setContent(markdownToHtml(md, resolve), { emitUpdate: false });
    },
    redo: () => doc.redo(),
  }) as unknown as InkEngine, [doc, resolve]);

  // ---- Layout: the sheet keeps its width while ink is shown, so ink stays on its words -----------
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // The room inside the scroller's padding is what the sheet can use.
    const measure = () => { const cs = getComputedStyle(el); setContainerW(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const hasInk = doc.page(0).strokes.length > 0;
  const fixed = hasInk || annotate || exporting || containerW >= width;
  const scale = fixed && containerW ? Math.min(1, containerW / width) : 1;

  // ---- Keyboard --------------------------------------------------------------------------------
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      if (!mod) { if (ev.key === 'Escape' && annotate) setAnnotate(false); return; }
      const k = ev.key.toLowerCase();
      if (k === 's') { ev.preventDefault(); save(); void session.flush().then(() => toast({ text: 'Saved', tone: 'success' })); }
      else if (k === 'p') { ev.preventDefault(); void print(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // ---- Commands ----------------------------------------------------------------------------------
  const e = editor;
  const run = (f: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => { if (e) f(e.chain().focus()).run(); };
  const is = (name: string, attrs?: Record<string, unknown>) => !!e?.isActive(name, attrs);
  const blockType = !e ? 'p' : [1, 2, 3, 4].find((l) => is('heading', { level: l })) ? `h${[1, 2, 3, 4].find((l) => is('heading', { level: l }))}` : 'p';

  const setLink = async () => {
    if (!e) return;
    const prev = (e.getAttributes('link').href as string | undefined) ?? '';
    const href = await askText(prev ? 'Edit link' : 'Add link', 'Web address (leave empty to remove)', prev, 'Save');
    if (href == null) return;
    if (!href.trim()) run((c) => c.extendMarkRange('link').unsetLink());
    else {
      const url = /^[a-z][a-z0-9+.-]*:/i.test(href.trim()) ? href.trim() : `https://${href.trim()}`;
      if (e.state.selection.empty && !is('link')) run((c) => c.insertContent({ type: 'text', text: href.trim(), marks: [{ type: 'link', attrs: { href: url } }] }));
      else run((c) => c.extendMarkRange('link').setLink({ href: url }));
    }
  };

  const insertImage = async () => {
    const [f] = await pickFiles('image/*', false);
    if (!f || !e) return;
    const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
    const name = vault.newAssetName(ext);
    await vault.vault.writeAsset(noteId, name, new Uint8Array(await f.arrayBuffer()));
    const url = URL.createObjectURL(f);
    urls.current.set(name, url);
    run((c) => c.setImage({ src: url, alt: f.name.replace(/\.[^.]+$/, '') } as never).updateAttributes('image', { asset: name }));
  };

  const importInto = async () => {
    const { DOCUMENT_FILES, readDocumentFile } = await import('./convert.ts');
    const [f] = await pickFiles(DOCUMENT_FILES, false);
    if (!f || !e) return;
    try {
      const r = await readDocumentFile(f, vault.newAssetName('x').replace(/\.x$/, ''));
      for (const im of r.images) {
        await vault.vault.writeAsset(noteId, im.name, im.bytes);
        urls.current.set(im.name, URL.createObjectURL(new Blob([im.bytes as BlobPart], { type: im.mime })));
      }
      run((c) => c.insertContent(prepareHtml(r.html, resolve)));
      toast({ text: `Added ${f.name}`, tone: 'success' });
    } catch (err) {
      toast({ text: `Couldn't open ${f.name}: ${(err as Error).message}`, tone: 'error' });
    }
  };

  // ---- Export --------------------------------------------------------------------------------------
  const baseName = () => (doc.meta.title.trim() || 'Document').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  const nextFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const pdfBytes = async () => {
    setExporting(true);
    await nextFrames();
    try {
      const { documentToPdf } = await import('./pdf.ts');
      return await documentToPdf(sheet.current!, host.current!.querySelector('.doc-prose') as HTMLElement, width, { title: doc.meta.title, ink: doc.page(0).strokes });
    } finally {
      setExporting(false);
    }
  };
  const exportAs = async (kind: 'pdf' | 'docx' | 'md' | 'html') => {
    if (!e) return;
    save();
    await session.flush();
    try {
      if (kind === 'pdf') {
        toast({ text: 'Preparing PDF…' });
        await saveDocument(`${baseName()}.pdf`, await pdfBytes(), 'application/pdf', '.pdf');
      } else if (kind === 'docx') {
        const { toDocx } = await import('./docx.ts');
        const bytes = await toDocx(e.getJSON() as PMNode, { title: doc.meta.title, image: (n) => imageForDocx(n) });
        await saveDocument(`${baseName()}.docx`, bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx');
      } else if (kind === 'md') {
        const md = toMarkdown(e.getJSON() as PMNode);
        const names = assetsIn(md);
        if (!names.length) await saveDocument(`${baseName()}.md`, new TextEncoder().encode(md), 'text/markdown', '.md');
        else {
          // Pictures travel with the text: a zip of the Markdown and its assets/ folder.
          const { zipSync, strToU8 } = await import('fflate');
          const files: Record<string, Uint8Array> = { [`${baseName()}.md`]: strToU8(md) };
          for (const n of names) { const b = await vault.vault.readAsset(noteId, n); if (b) files[`assets/${n}`] = b; }
          await saveDocument(`${baseName()}.zip`, zipSync(files), 'application/zip', '.zip');
        }
      } else {
        await saveDocument(`${baseName()}.html`, new TextEncoder().encode(await standaloneHtml()), 'text/html', '.html');
      }
    } catch (err) {
      console.error(err);
      toast({ text: `Export failed: ${(err as Error).message}`, tone: 'error' });
    }
  };
  const imageForDocx = async (n: PMNode) => {
    const name = n.attrs?.asset as string | undefined;
    const bytes = name ? await vault.vault.readAsset(noteId, name) : null;
    if (!bytes) return null;
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
    const size = { width: bmp.width, height: bmp.height };
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (isPng || isJpg) { bmp.close(); return { bytes, type: isPng ? 'png' as const : 'jpeg' as const, ...size }; }
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png' as const, ...size } : null;
  };
  const standaloneHtml = async () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = e!.getHTML();
    for (const img of [...tpl.content.querySelectorAll('img[data-asset]')]) {
      const bytes = await vault.vault.readAsset(noteId, img.getAttribute('data-asset')!);
      if (!bytes) continue;
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('src', `data:${/\.png$/i.test(img.getAttribute('data-asset')!) ? 'image/png' : 'image/jpeg'};base64,${btoa(bin)}`);
    }
    const wrap = document.createElement('div');
    wrap.appendChild(tpl.content);
    const title = doc.meta.title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>\n<style>body{max-width:720px;margin:40px auto;padding:0 20px;font:16px/1.6 system-ui,sans-serif;color:#1b1f24}img{max-width:100%}pre{background:#f1eff3;padding:12px;border-radius:6px;overflow:auto}code{font-family:ui-monospace,monospace}blockquote{border-left:3px solid #bbb;margin:0;padding-left:14px;color:#555}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:6px 10px}th{background:#f1eff3}ul[data-type=taskList]{list-style:none;padding-left:4px}ul[data-type=taskList] li::before{content:'☐ '}ul[data-type=taskList] li[data-checked=true]::before{content:'☑ '}.page-break{break-after:page}@media screen{.page-break{border-top:1px dashed #bbb;margin:24px 0}}</style></head>\n<body>\n${wrap.innerHTML}\n</body></html>\n`;
  };
  const print = async () => {
    save();
    if (isNative) {
      // Android's WebView can't print a page: share the PDF and pick Print in the share sheet.
      toast({ text: 'Choose Print in the share sheet' });
      await saveDocument(`${baseName()}.pdf`, await pdfBytes(), 'application/pdf', '.pdf');
      return;
    }
    setExporting(true);
    await nextFrames();
    try { window.print(); } finally { setExporting(false); }
  };

  // ---- Outline and counts ---------------------------------------------------------------------------
  const outline = useMemo(() => {
    const out: { level: number; text: string; pos: number }[] = [];
    e?.state.doc.descendants((n, pos) => { if (n.type.name === 'heading') out.push({ level: n.attrs.level as number, text: n.textContent, pos }); return n.type.name !== 'heading'; });
    return out;
  }, [e, e?.state.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = e?.state.doc.textBetween(0, e.state.doc.content.size, ' ', ' ') ?? '';
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;
  const goTo = (pos: number) => {
    if (!e) return;
    e.chain().focus().setTextSelection(pos + 1).run();
    (e.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    if (!wide) setPanel(null);
  };

  // ---- Render ------------------------------------------------------------------------------------
  const on = (id: string) => isModuleOn(id, mods);
  const flush = async () => { save(); await session.flush(); };
  const inTable = is('table');
  const fmt = (label: string, icon: React.ReactNode, active: boolean, act: () => void, shortcut?: string) => (
    <IconButton key={label} label={label} shortcut={shortcut} active={active} onClick={act} disabled={!e}>{icon}</IconButton>
  );
  const extras = [
    fmt('Strikethrough', <Strikethrough size={18} />, is('strike'), () => run((c) => c.toggleStrike()), `${modKey}⇧S`),
    fmt('Inline code', <Code size={18} />, is('code'), () => run((c) => c.toggleCode()), `${modKey}E`),
    fmt('Quote', <Quote size={18} />, is('blockquote'), () => run((c) => c.toggleBlockquote())),
    fmt('Code block', <SquareCode size={18} />, is('codeBlock'), () => run((c) => c.toggleCodeBlock())),
    fmt('Divider', <Minus size={18} />, false, () => run((c) => c.setHorizontalRule())),
    fmt('Page break', <Scissors size={18} />, false, () => run((c) => c.setPageBreak()), `${modKey}↵`),
  ];

  return (
    <div className={cx('editor', 'doc-editor', wide && 'is-wide', panel && 'has-panel', exporting && 'is-exporting')}>
      <header className="ed-top">
        <IconButton label="Back to library" onClick={() => { void flush().then(onBack); }}><ArrowLeft size={20} /></IconButton>
        <button type="button" className="ed-title" onClick={async () => { const t = await askText('Rename document', 'Title', doc.meta.title, 'Rename'); if (t) doc.rename(t); }}>
          <span className="ed-title-text">{doc.meta.title}</span>
          <span className={cx('save-dot', `is-${saveState}`)} title={saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved — retrying' : 'Saved'} aria-label={saveState === 'saved' ? 'Saved' : saveState} />
        </button>
        <div className="ed-top-spacer" />
        {wide && <span className="doc-count" aria-live="polite">{words.toLocaleString()} {words === 1 ? 'word' : 'words'}</span>}
        <div className="ed-top-actions">
          {roomForTheme && <ThemeToggle />}
          <NewNoteButton meta={doc.meta} flush={flush} onNewPage={() => run((c) => c.setPageBreak())} newPageLabel="Page break here" />
          {on('assistant') && (
            <button type="button" className={cx('ai-btn', panel === 'ai' && 'is-on')} onClick={() => { save(); setPanel(panel === 'ai' ? null : 'ai'); }} aria-pressed={panel === 'ai'} aria-label="AI" title="AI assistant">
              <Sparkles size={17} /><span>AI</span>
            </button>
          )}
          <button ref={moreBtn} type="button" className="icon-btn" aria-label="More" title="More" onClick={() => setMenu('more')}><MoreHorizontal size={19} /></button>
        </div>
      </header>

      {/* Buttons don't take focus from the text, so typing carries on where the cursor was. */}
      <div className="doc-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(ev) => { if ((ev.target as HTMLElement).closest('button')) ev.preventDefault(); }}>
        <label className="doc-style">
          {wide && <Heading size={16} aria-hidden />}
          <select aria-label="Text style" value={blockType} disabled={!e} onChange={(ev) => {
            const v = ev.target.value;
            if (v === 'p') run((c) => c.setParagraph());
            else run((c) => c.setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 | 4 }));
          }}>
            <option value="p">Text</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="h4">Heading 4</option>
          </select>
        </label>
        <span className="doc-sep" aria-hidden />
        {fmt('Bold', <Bold size={18} />, is('bold'), () => run((c) => c.toggleBold()), `${modKey}B`)}
        {fmt('Italic', <Italic size={18} />, is('italic'), () => run((c) => c.toggleItalic()), `${modKey}I`)}
        {fmt('Underline', <Underline size={18} />, is('underline'), () => run((c) => c.toggleUnderline()), `${modKey}U`)}
        {fmt('Link', <Link2 size={18} />, is('link'), () => void setLink())}
        <span className="doc-sep" aria-hidden />
        {fmt('Bulleted list', <List size={18} />, is('bulletList'), () => run((c) => c.toggleBulletList()))}
        {fmt('Numbered list', <ListOrdered size={18} />, is('orderedList'), () => run((c) => c.toggleOrderedList()))}
        {fmt('Checklist', <CheckSquare size={18} />, is('taskList'), () => run((c) => c.toggleTaskList()))}
        <span className="doc-sep" aria-hidden />
        <button ref={tableBtn} type="button" className={cx('icon-btn', inTable && 'is-active')} aria-label="Table" title={inTable ? 'Table: rows and columns' : 'Insert a table'} disabled={!e}
          onClick={() => (inTable ? setMenu('table') : run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })))}>
          <Table2 size={18} />
        </button>
        {fmt('Image', <ImagePlus size={18} />, false, () => void insertImage())}
        {wide ? extras : (
          <button ref={formatBtn} type="button" className="icon-btn" aria-label="More formatting" title="More formatting" disabled={!e} onClick={() => setMenu('format')}><ChevronDown size={18} /></button>
        )}
        <span className="doc-sep" aria-hidden />
        {fmt('Undo', <Undo2 size={18} />, false, () => run((c) => c.undo()), `${modKey}Z`)}
        {fmt('Redo', <Redo2 size={18} />, false, () => run((c) => c.redo()), `${modKey}⇧Z`)}
        <span className="doc-toolbar-spacer" />
        {/* Annotate stays in view at the toolbar's end even when the row scrolls on a phone. */}
        <button type="button" className={cx('btn', 'btn-sm', 'doc-annotate', annotate && 'is-on')} aria-pressed={annotate} onClick={() => setAnnotate(!annotate)} title="Write on the document with the pen">
          <PenLine size={16} /> <span>{annotate ? 'Done' : 'Annotate'}</span>
        </button>
        {wide && fmt('Outline', <ListTree size={18} />, panel === 'outline', () => setPanel(panel === 'outline' ? null : 'outline'))}
      </div>

      <div className="ed-body">
        <div ref={scroller} className={cx('doc-scroll', annotate && 'is-annotating')}>
          <div ref={sheet} className={cx('doc-sheet', fixed && 'is-fixed')} style={fixed ? { width, zoom: scale } as React.CSSProperties : undefined}>
            <div ref={host} className="doc-host" />
            <InkLayer doc={doc} active={annotate} tool={inkTool} pen={pen} fingerDraws={finger.on} width={width} scroller={scroller.current} onStroke={() => session.scheduleRecognition(0)} />
          </div>
          {!wide && <p className="doc-foot muted">{words.toLocaleString()} {words === 1 ? 'word' : 'words'} · {Math.max(1, Math.round(words / 230))} min read</p>}
        </div>
        {panel === 'outline' && (
          <aside className="side-panel doc-outline" aria-label="Outline">
            <header className="side-head">
              <h2>Outline</h2>
              <IconButton label="Close outline" onClick={() => setPanel(null)}><X size={18} /></IconButton>
            </header>
            {outline.length ? (
              <ol className="doc-outline-list">
                {outline.map((h) => (
                  <li key={h.pos} style={{ paddingLeft: (h.level - 1) * 14 }}><button type="button" className="nav-item" onClick={() => goTo(h.pos)}><span className="nav-label">{h.text || 'Untitled heading'}</span></button></li>
                ))}
              </ol>
            ) : <p className="muted doc-outline-empty">Headings you add appear here. Choose Heading 1–4 from the text style menu.</p>}
            <p className="muted doc-outline-empty">{words.toLocaleString()} words · {text.length.toLocaleString()} characters</p>
          </aside>
        )}
        {panel === 'ai' && on('assistant') && (
          <AIPanel session={session} engine={engineForPanel} request={null} onClose={() => setPanel(null)} onOpenSettings={() => navigate({ name: 'settings', section: 'ai' })} />
        )}
      </div>

      {annotate && (
        <div className="dock is-horizontal doc-ink-dock" role="toolbar" aria-label="Ink tools">
          <div className="tray" role="radiogroup" aria-label="Pens">
            {settings.tray.slice(0, 6).map((p) => {
              const sel = inkTool === 'pen' && settings.activePresetId === p.id;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={sel} className={cx('pen', sel && 'is-on')} aria-label={`Pen ${p.pen}`}
                  onClick={() => { settings.update(() => ({ activePresetId: p.id })); setInkTool('pen'); }}>
                  <PenNib pen={p.pen} color={p.color} size={0.62} />
                </button>
              );
            })}
          </div>
          <div className="dock-sep" />
          <div className="dock-group">
            <IconButton label="Eraser" active={inkTool === 'eraser'} onClick={() => setInkTool(inkTool === 'eraser' ? 'pen' : 'eraser')}><Eraser size={19} /></IconButton>
            <IconButton label="Undo ink" disabled={!doc.canUndo} onClick={() => doc.undo()}><Undo2 size={18} /></IconButton>
            <FingerDrawButton />
            <IconButton label="Done annotating" onClick={() => setAnnotate(false)}><X size={19} /></IconButton>
          </div>
        </div>
      )}

      <Popover anchor={formatBtn.current} open={menu === 'format'} onClose={() => setMenu(null)} title="More formatting" placement="below">
        <div className="doc-format-grid" role="group" aria-label="More formatting">{extras}</div>
      </Popover>
      <Popover anchor={tableBtn.current} open={menu === 'table'} onClose={() => setMenu(null)} title="Table" placement="below">
        <Menu onClose={() => setMenu(null)} items={[
          { label: 'Add row below', icon: <Rows3 size={16} />, onClick: () => run((c) => c.addRowAfter()) },
          { label: 'Add column right', icon: <Table2 size={16} />, onClick: () => run((c) => c.addColumnAfter()) },
          { label: 'Header row', icon: <Highlighter size={16} />, onClick: () => run((c) => c.toggleHeaderRow()) },
          'sep',
          { label: 'Delete row', icon: <Minus size={16} />, onClick: () => run((c) => c.deleteRow()) },
          { label: 'Delete column', icon: <Minus size={16} />, onClick: () => run((c) => c.deleteColumn()) },
          { label: 'Delete table', icon: <Trash2 size={16} />, danger: true, onClick: () => run((c) => c.deleteTable()) },
        ]} />
      </Popover>
      <Popover anchor={moreBtn.current} open={menu === 'more'} onClose={() => setMenu(null)} title="More" placement="below" className="more-pop">
        <Menu onClose={() => setMenu(null)} items={[
          { label: 'Export PDF', icon: <FileType2 size={16} />, onClick: () => void exportAs('pdf') },
          { label: 'Export Word document', icon: <FileDown size={16} />, hint: '.docx', onClick: () => void exportAs('docx') },
          { label: 'Export Markdown', icon: <FileText size={16} />, hint: '.md', onClick: () => void exportAs('md') },
          { label: 'Export web page', icon: <FileCode2 size={16} />, hint: '.html', onClick: () => void exportAs('html') },
          { label: 'Print', icon: <Printer size={16} />, hint: `${modKey}P`, onClick: () => void print() },
          'sep',
          { label: 'Insert a file', icon: <FileUp size={16} />, hint: 'Word, Markdown, HTML', onClick: () => void importInto() },
          { label: 'Outline', icon: <ListTree size={16} />, hint: `${outline.length}`, onClick: () => setPanel('outline') },
          ...(hasInk ? [{ label: 'Clear ink', icon: <Eraser size={16} />, hint: 'Undo brings it back', onClick: () => doc.deleteStrokes(0, new Set(doc.page(0).strokes.map((s) => s.id)), 'Clear ink') }] : []),
          'sep',
          { label: 'Duplicate document', icon: <Copy size={16} />, onClick: async () => { await flush(); await duplicateNote(noteId); toast({ text: 'Duplicated', tone: 'success' }); } },
          { label: 'Move to Trash', icon: <Trash2 size={16} />, danger: true, onClick: async () => { await flush(); await trashNote(noteId); navigate({ name: 'library' }); } },
        ]} />
      </Popover>
    </div>
  );
}

