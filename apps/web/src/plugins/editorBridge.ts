/**
 * What plugins and the automation API may know about the editor: the open note, the page in
 * view and the selection's text — and the one write they may make there (placing typed text).
 * The editor publishes itself with `useEditorBridge`; nothing else in the editor is reachable.
 */
import { useEffect } from 'react';
import { newId, type NoteDocument, type TextBox } from '@inkwright/core';
import type { InkEngine, SelectionInfo } from '../canvas/engine.ts';

interface Bridge {
  doc: NoteDocument;
  engine: InkEngine;
}

let current: Bridge | null = null;
const selectionListeners = new Set<(noteId: string, text: string) => void>();
const openListeners = new Set<(noteId: string, title: string) => void>();

/** Called by the editor screen while a note is open. */
export function useEditorBridge(doc: NoteDocument | null, engine: InkEngine | null, sel: SelectionInfo | null): void {
  useEffect(() => {
    if (!doc || !engine) return;
    const mine: Bridge = { doc, engine };
    current = mine;
    for (const l of openListeners) l(doc.meta.id, doc.meta.title);
    return () => { if (current === mine) current = null; };
  }, [doc, engine]);
  useEffect(() => {
    if (!doc || !engine) return;
    const text = selectionText();
    for (const l of selectionListeners) l(doc.meta.id, text);
  }, [sel, doc, engine]);
}

/** The open note's document (edits through it are live and undoable), if any. */
export function openDocument(): NoteDocument | null {
  return current?.doc ?? null;
}

export function editorState(): { noteId: string; title: string; page: number; pages: number } | null {
  if (!current) return null;
  return { noteId: current.doc.meta.id, title: current.doc.meta.title, page: current.engine.currentPageIndex + 1, pages: current.doc.pageCount };
}

/** Typed text and recognized handwriting of the current selection ('' when nothing is selected). */
export function selectionText(): string {
  if (!current) return '';
  const items = current.engine.getSelectionItems();
  if (!items) return '';
  const page = current.doc.page(items.pageIndex);
  const ids = new Set(items.strokes.map((s) => s.id));
  const lines = (page.recognizedLines ?? []).filter((l) => l.strokeIds.some((id) => ids.has(id))).map((l) => l.text);
  return [...items.texts.map((t) => t.text), ...lines].join('\n').trim();
}

/** Places typed text below the content of the page in view (one undoable step). */
export function insertTextInEditor(text: string, label: string): void {
  if (!current) throw new Error('No note is open.');
  const { doc, engine } = current;
  const pageIndex = engine.currentPageIndex;
  const page = doc.page(pageIndex);
  const ys = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 60)];
  const y = ys.length ? Math.max(...ys) + 32 : 96;
  const box: TextBox = { id: newId(), x: 64, y, width: (doc.meta.pageSize.width || 794) - 128, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'import' };
  doc.upsertText(pageIndex, box, label);
}

export function onSelectionChanged(l: (noteId: string, text: string) => void): () => void {
  selectionListeners.add(l);
  return () => selectionListeners.delete(l);
}

export function onNoteOpened(l: (noteId: string, title: string) => void): () => void {
  openListeners.add(l);
  return () => openListeners.delete(l);
}
