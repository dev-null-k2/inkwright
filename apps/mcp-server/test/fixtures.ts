import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Vault, newNote, newPage, type InkStroke, type NoteMeta, type NotebookMeta, type PageInk } from '@inkstone/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createContext, type ContextOptions, type ServerContext } from '../src/context.ts';
import { NodeFS } from '../src/nodefs.ts';

export const HOUR = 3600_000;

/** A handwritten-looking word: moves right while oscillating, like digitizer input. */
export function wordStroke(id: string, x0: number, y: number, createdAt: number, width = 100): InkStroke {
  return {
    id,
    pen: 'fountain',
    color: '#FF1B1F24',
    size: 2.6,
    createdAt,
    points: Array.from({ length: 41 }, (_, i) => {
      const f = i / 40;
      return { x: x0 + f * width, y: y + 6 * Math.sin(f * 10 * Math.PI), t: i * 8, p: 0.5, tilt: -1, orient: -1 };
    }),
  };
}

export interface Fixture {
  dir: string;
  /** A second, independent writer on the same folder (stands in for the app / a sync client). */
  external: Vault;
  now: number;
  nb: { work: NotebookMeta; projects: NotebookMeta; personal: NotebookMeta };
  notes: { launch: NoteMeta; groceries: NoteMeta; sketch: NoteMeta; old: NoteMeta; trashed: NoteMeta };
  ctx(opts?: Partial<ContextOptions>): Promise<ServerContext>;
  cleanup(): Promise<void>;
}

async function saveNote(v: Vault, args: { id: string; title: string; updatedAt: number; pages: PageInk[]; notebookId?: string; tags?: string[]; extra?: Partial<NoteMeta> }): Promise<NoteMeta> {
  const base = newNote({ id: args.id, title: args.title, pageId: args.pages[0]!.id, now: args.updatedAt - HOUR, notebookId: args.notebookId, tags: args.tags });
  const note: NoteMeta = { ...base, pageIds: args.pages.map((p) => p.id), updatedAt: args.updatedAt, ...args.extra };
  await v.saveNote(note, args.pages);
  return note;
}

/** Temp vault with notebooks, handwriting (recognized and not), text boxes and a trashed note. */
export async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'inkstone-mcp-'));
  const now = Date.now();
  const vault = new Vault(new NodeFS(dir), () => now);
  await vault.init();

  const work: NotebookMeta = { id: 'NBWORK', name: 'Work', color: '#FF3D5A80', createdAt: now - 100 * HOUR, formatVersion: 2 };
  const projects: NotebookMeta = { id: 'NBPROJECTS', name: 'Projects', color: '#FF2E7D32', parentId: 'NBWORK', createdAt: now - 99 * HOUR, formatVersion: 2 };
  const personal: NotebookMeta = { id: 'NBPERSONAL', name: 'Personal', color: '#FFC62828', createdAt: now - 98 * HOUR, formatVersion: 2 };
  for (const nb of [work, projects, personal]) await vault.writeNotebook(nb);

  const launchP1: PageInk = {
    ...newPage('LAUNCHP1'),
    strokes: [wordStroke('s1', 130, 120, now - 2 * HOUR), wordStroke('s2', 130, 160, now - 2 * HOUR)],
    recognizedText: 'Launch the beta on Friday\nCall Maria about pricing',
    recognizedAt: now - HOUR,
    recognizedBy: 'mlkit',
  };
  const launchP2: PageInk = {
    ...newPage('LAUNCHP2'),
    strokes: [],
    texts: [{ id: 'T1', x: 128, y: 96, width: 500, text: 'Budget: 5k for the **beta** cohort', fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: now - 2 * HOUR }],
  };
  const launch = await saveNote(vault, { id: 'LAUNCH', title: 'Launch plan', updatedAt: now - HOUR, pages: [launchP1, launchP2], notebookId: projects.id, tags: ['work', 'launch'] });

  const groceries = await saveNote(vault, {
    id: 'GROCERIES',
    title: 'Grocery list',
    updatedAt: now - 72 * HOUR,
    notebookId: personal.id,
    tags: ['home'],
    pages: [{ ...newPage('GROCP1'), strokes: [], texts: [{ id: 'T2', x: 128, y: 96, width: 400, text: '- milk\n- eggs\n- coffee', fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: now - 72 * HOUR }] }],
  });

  const sketch = await saveNote(vault, {
    id: 'SKETCH',
    title: 'Whiteboard sketch',
    updatedAt: now - 30 * 60_000,
    pages: [{ ...newPage('SKETCHP1'), strokes: [wordStroke('k1', 150, 300, now - 30 * 60_000, 200), wordStroke('k2', 150, 340, now - 30 * 60_000)] }],
  });

  const old = await saveNote(vault, {
    id: 'OLDNOTE',
    title: 'Reading notes',
    updatedAt: now - 24 * 10 * HOUR,
    notebookId: work.id,
    tags: ['books'],
    extra: { summary: 'Thoughts on Deep Work' },
    pages: [{ ...newPage('OLDP1'), strokes: [wordStroke('o1', 130, 120, now - 240 * HOUR)], recognizedText: 'Deep work needs long uninterrupted blocks', recognizedBy: 'gemini-2.5-flash' }],
  });

  const trashed = await saveNote(vault, {
    id: 'TRASHED',
    title: 'Discarded idea',
    updatedAt: now - 5 * HOUR,
    pages: [{ ...newPage('TRASHP1'), strokes: [], recognizedText: 'zeppelin delivery service' }],
    extra: { trashedAt: now - 4 * HOUR },
  });

  const external = new Vault(new NodeFS(dir));
  const contexts: ServerContext[] = [];
  return {
    dir,
    external,
    now,
    nb: { work, projects, personal },
    notes: { launch, groceries, sketch, old, trashed },
    async ctx(opts = {}) {
      const c = await createContext({ root: dir, watch: false, renderPng: null, ...opts });
      contexts.push(c);
      return c;
    },
    async cleanup() {
      for (const c of contexts) c.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Text of the n-th text content item of a tool result. */
export function text(r: CallToolResult, n = 0): string {
  const items = r.content.filter((c) => c.type === 'text');
  const item = items[n];
  if (!item || item.type !== 'text') throw new Error(`No text content #${n}`);
  return item.text;
}

export function json<T = any>(r: CallToolResult, n = 0): T {
  return JSON.parse(text(r, n)) as T;
}
