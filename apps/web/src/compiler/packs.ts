/**
 * Context packs and AGENTS.md in the app: gathers the chosen notes, the compiled pages that cite
 * them and images of handwriting nobody has transcribed, builds the pack (core packs.ts), saves
 * it in the vault (so the MCP server serves it as `inkwright://packs/{id}`) and downloads it as
 * Markdown, JSON or an Agent Skill folder (.zip).
 */
import { agentsMd, buildContextPack, extractClaims, boundsOfStrokes, pageText, rectIsEmpty, textItemKey, unitAnchor, type ContextPack, type PackImage, type PackNote, type PackPage } from '@inkwright/core';
import { pageImageForAI } from '../lib/exporter.ts';
import { agentHub } from '../lib/agent/hub.ts';
import { saveFile } from '../platform/files.ts';
import { allDocs, compilerStore, compilerVault } from './service.ts';
import { readNoteProvenance } from './target.ts';

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function memoryLists(): Promise<{ instructions: string[]; facts: string[] }> {
  const items = (await agentHub()?.memory.load().catch(() => [])) ?? [];
  return { instructions: items.filter((i) => i.status === 'active' && i.kind === 'instruction').map((i) => i.text), facts: items.filter((i) => i.status === 'active' && i.kind === 'fact').map((i) => i.text) };
}

export interface PackOptions {
  noteIds: string[];
  title: string;
  purpose?: string;
  includeWiki: boolean;
  includeInk: boolean;
  includeMemory: boolean;
}

/** Builds a pack from notes (and the compiled pages about them). */
export async function buildPack(o: PackOptions): Promise<ContextPack> {
  const v = compilerVault();
  const nbs = new Map((await v.listNotebooks()).map((n) => [n.id, n.name]));
  const notes: PackNote[] = [];
  const images: PackImage[] = [];
  for (const id of o.noteIds) {
    const meta = await v.vault.readNote(id);
    if (!meta || meta.lock || meta.trashedAt != null) continue;
    const pages = await v.vault.readPages(meta);
    notes.push({ id, title: meta.title || 'Untitled', ...(meta.notebookId && nbs.get(meta.notebookId) ? { notebook: nbs.get(meta.notebookId)! } : {}), tags: meta.tags, updatedAt: meta.updatedAt, ...(meta.summary ? { summary: meta.summary } : {}), pages: pages.map((p, index) => ({ index, text: pageText(p) })) });
    if (!o.includeInk) continue;
    for (const [index, p] of pages.entries()) {
      if (images.length >= 8 || p.recognizedText?.trim() || p.strokes.length < 3) continue;
      const r = boundsOfStrokes(p.strokes);
      if (rectIsEmpty(r)) continue;
      const img = await pageImageForAI(v, meta, pages, index, r).catch(() => null);
      if (img) images.push({ name: `ink-${id.slice(-8)}-${index + 1}.jpg`, noteId: id, noteTitle: meta.title || 'Untitled', page: index, alt: 'handwriting (not transcribed)', mediaType: img.mediaType, bytes: b64ToBytes(img.base64) });
    }
  }
  const compiled: PackPage[] = [];
  if (o.includeWiki) {
    const state = await compilerStore().state();
    const ids = new Set(o.noteIds);
    for (const p of Object.values(state.pages)) {
      if (!p.sourceNotes.some((n) => ids.has(n))) continue;
      const claims = (await readNoteProvenance(v, p.noteId)).items[textItemKey(p.textId)]?.claims ?? [];
      if (claims.length) compiled.push({ title: p.title, kind: p.kind, claims });
    }
  }
  return buildContextPack({ title: o.title, ...(o.purpose ? { purpose: o.purpose } : {}), createdAt: Date.now(), notes, compiled, images, ...(o.includeMemory ? { memory: await memoryLists() } : {}) });
}

/** Saves a pack in the vault (served to agents by the MCP server). */
export async function savePack(pack: ContextPack): Promise<void> {
  await compilerStore().savePack(pack.id, { json: JSON.stringify(pack.json, null, 1), markdown: pack.markdown });
}

const fileBase = (pack: ContextPack) => pack.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'Context pack';

export async function downloadPack(pack: ContextPack, format: 'md' | 'json' | 'skill'): Promise<void> {
  const enc = new TextEncoder();
  if (format === 'md') return saveFile(`${fileBase(pack)}.md`, enc.encode(pack.markdown), 'text/markdown');
  if (format === 'json') return saveFile(`${fileBase(pack)}.json`, enc.encode(JSON.stringify(pack.json, null, 1)), 'application/json');
  const { writeZip } = await import('@inkwright/sync');
  const zip = await writeZip(Object.entries(pack.skill).map(([path, v]) => ({ path, bytes: typeof v === 'string' ? enc.encode(v) : v })));
  return saveFile(`${fileBase(pack)} skill.zip`, zip, 'application/zip');
}

/** AGENTS.md: standing instructions and facts, and decisions written in notes (with where). */
export async function buildAgentsMd(): Promise<string> {
  const mem = await memoryLists();
  const decisions = [];
  for (const d of await allDocs()) {
    for (const c of extractClaims(d)) {
      if (c.kind !== 'decision' || c.polarity == null) continue;
      const u = d.units.find((x) => x.id === c.unitId)!;
      decisions.push({ text: c.text, noteTitle: d.title, src: unitAnchor(u), date: new Date(d.updatedAt).toISOString().slice(0, 10), at: d.updatedAt });
    }
  }
  decisions.sort((a, b) => b.at - a.at);
  return agentsMd({ instructions: mem.instructions, facts: mem.facts, decisions: decisions.slice(0, 60), createdAt: Date.now() });
}

export async function downloadAgentsMd(): Promise<string> {
  const md = await buildAgentsMd();
  await saveFile('AGENTS.md', new TextEncoder().encode(md), 'text/markdown');
  return md;
}
