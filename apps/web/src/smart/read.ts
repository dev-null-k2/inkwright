import { extractJson, runSkill, type Skill } from '@inkwright/ai';
import { boundsOfStrokes, strokesByCell, tableRect, type InkStroke, type NoteDocument, type PageInk, type TableObject } from '@inkwright/core';
import { getActiveAI, transcribePage, type ActiveAI } from '../lib/ai.ts';
import { pageImageForAI } from '../lib/exporter.ts';
import { availableEngine, recognizeLocally } from '../lib/recognition.ts';
import type { AppVault } from '../lib/vault.ts';
import { useSettings } from '../state/settings.ts';
import { engineLabel, isConfident, readMathLocally } from './inkmath.ts';

/**
 * Reading ink for the smart-ink features. Order of preference:
 *  1. on-device recognition from the strokes (ML Kit in the Android app, the browser's
 *     handwriting API, and for maths the built-in reader) — private, offline, automatic;
 *  2. a strong vision AI reading a picture of the ink — only a cloud model with the person's key
 *     (or a model server they run), never a small on-device model: those misread handwriting
 *     badly. Used when on-device reading is unavailable or unsure, automatically only where the
 *     person allowed it, otherwise on an explicit tap.
 */

/**
 * The AI to read handwriting with, or null. Small on-device models (Gemini Nano, Gemma, models
 * in the browser) are excluded: reading handwriting from a picture is exactly what they get wrong.
 */
export async function strongVisionAI(doc: NoteDocument): Promise<ActiveAI | null> {
  const ai = await getActiveAI({ task: 'vision', source: 'smart-ink', notes: [doc.meta] }).catch(() => null);
  if (!ai?.vision) return null;
  if (ai.local && ai.budgetKey === 'device') return null;
  return ai;
}

export interface MathReading {
  /** Plain ASCII maths ("2*x + 3 = 7"; one equation per line for systems). */
  plain: string;
  latex?: string;
  /** Worked steps, when an AI read it. */
  steps?: string[];
  /** The AI's own final answer (used only when the solver cannot do it). */
  answer?: string;
  by: 'ai' | 'local';
  /** Who read it, for people: "ML Kit on this device", or the AI's name. */
  source: string;
  /** On-device readings: how sure the reader is (0..1). */
  confidence?: number;
}

export interface MathReadInput { image: { mediaType: string; data: string } }

/**
 * A strict prompt: maths out as JSON in a syntax our solver parses, plus short steps. Nothing
 * else, so a chatty model cannot leak prose onto the page.
 */
export const readMathSkill: Skill<MathReadInput, Omit<MathReading, 'by' | 'source'>> = {
  id: 'read-math',
  label: 'Read handwritten maths',
  description: 'Reads handwritten maths from an image and explains how to solve it.',
  vision: true,
  build(input) {
    return {
      system: [
        'You read handwritten mathematics from an image for a calculator.',
        'Reply with one JSON object and nothing else:',
        '{"plain": string, "latex": string, "steps": string[], "answer": string}',
        'Rules for "plain" (it is parsed by a computer algebra system):',
        '- ASCII only: + - * / ^ ( ) = , numbers, single-letter variables, sqrt(), abs(), sin cos tan ln log exp, pi.',
        '- Equations keep their "="; a trailing "=" with nothing after it means "evaluate" — drop it.',
        '- Several equations (a system): one per line.',
        '- Derivative: d/dx(f). Integral: integrate(f, x) or integrate(f, x, a, b). Limit: limit(f, x, a) (use Infinity for ∞).',
        '- Units stay as words: "5 km/h to m/s".',
        '- Copy exactly what is written; never fix or complete the problem.',
        '"steps": at most 6 short steps solving it (plain text, no LaTeX). "answer": the final answer, short.',
        'If the image holds no maths, reply {"plain": ""}.',
      ].join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this.' }, { type: 'image', mediaType: input.image.mediaType, data: input.image.data }] }],
      json: true,
      temperature: 0,
      maxTokens: 800,
    };
  },
  parse(text) {
    const o = extractJson(text) as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object') throw new Error('The AI did not return maths');
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
    return {
      plain: str(o.plain) ?? '',
      latex: str(o.latex) || undefined,
      steps: Array.isArray(o.steps) ? o.steps.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 8) : undefined,
      answer: str(o.answer) || undefined,
    };
  },
};

/** An image of just these strokes (no paper, no other content), for vision models. */
async function inkImage(vault: AppVault, doc: NoteDocument, pageIndex: number, strokes: InkStroke[]) {
  const page = doc.page(pageIndex);
  const only: PageInk = { ...page, strokes, texts: [], images: [], objects: [], background: undefined };
  const pages = doc.pages.map((p, i) => (i === pageIndex ? only : p));
  return pageImageForAI(vault, doc.meta, pages, pageIndex, boundsOfStrokes(strokes));
}

/** Whether ink can be read right now without asking (on-device, or a strong AI the user allowed). */
export async function canReadAutomatically(doc?: NoteDocument): Promise<'local' | 'ai' | false> {
  const e = await availableEngine().catch(() => 'none' as const);
  if (e === 'native' || e === 'browser') return 'local';
  if (!useSettings.getState().recognition.autoAI) return false;
  const ai = doc ? await strongVisionAI(doc) : null;
  return ai ? 'ai' : false;
}

/** Whether ink can be read at all (possibly after a tap that allows the AI). */
export async function canRead(doc?: NoteDocument): Promise<boolean> {
  if (await canReadAutomatically(doc)) return true;
  return !!(doc && (await strongVisionAI(doc)));
}

/** Reads maths with the AI's vision (it also gives steps). */
export async function readMathWithAI(vault: AppVault, doc: NoteDocument, pageIndex: number, strokes: InkStroke[], ai: ActiveAI): Promise<MathReading> {
  const img = await inkImage(vault, doc, pageIndex, strokes);
  const r = await runSkill(readMathSkill, ai.provider, ai.model, { image: { mediaType: img.mediaType, data: img.base64 } });
  return { ...r, by: 'ai', source: ai.label };
}

/**
 * Reads maths: on this device from the strokes first, always. A strong vision AI reads the
 * picture instead only when the on-device reading is unsure or empty and `allowAI` (an explicit
 * tap, or auto-AI on).
 */
export async function readMath(vault: AppVault, doc: NoteDocument, pageIndex: number, strokes: InkStroke[], allowAI = true): Promise<MathReading> {
  const local = await readMathLocally(strokes);
  const fromLocal = (): MathReading => ({ plain: local!.plain, latex: local!.latex || undefined, by: 'local', source: `${engineLabel(local!.engine)} on this device`, confidence: local!.confidence });
  if (local && isConfident(local)) return fromLocal();
  const ai = allowAI ? await strongVisionAI(doc) : null;
  if (ai) {
    try { return await readMathWithAI(vault, doc, pageIndex, strokes, ai); } catch (e) { if (!local?.plain) throw e; }
  }
  if (local?.plain) return fromLocal();
  if (!local) throw new Error('Handwriting recognition is off. Turn it on in Settings › Pen & touch to read maths.');
  throw new Error('Couldn’t read that as maths. Write each symbol clearly, a little larger, and try again.');
}

/** Reads text: on-device first; the AI only when `allowAI` (an explicit tap, or auto-AI on). */
export async function readText(vault: AppVault, doc: NoteDocument, pageIndex: number, strokes: InkStroke[], allowAI: boolean): Promise<{ text: string; by: 'local' | 'ai' } | null> {
  const local = await recognizeLocally(strokes).catch(() => null);
  if (local) return { text: local.text, by: 'local' };
  if (!allowAI) return null;
  if (!(await strongVisionAI(doc))) return null;
  const text = await transcribePage(vault, doc, pageIndex, strokes, 'plain');
  return text == null ? null : { text, by: 'ai' };
}

interface TableReadInput { image: { mediaType: string; data: string }; rows: number; cols: number }

/** Reads a whole table's handwriting in one AI call, as a rows × cols grid of strings. */
export const readTableSkill: Skill<TableReadInput, string[][]> = {
  id: 'read-table',
  label: 'Read a handwritten table',
  description: 'Reads the handwriting in each cell of a table.',
  vision: true,
  build(input) {
    return {
      system: [
        `The image shows a table with ${input.rows} rows and ${input.cols} columns, with handwriting in some cells.`,
        `Reply with JSON only: {"cells": string[][]} — exactly ${input.rows} arrays of ${input.cols} strings, top to bottom, left to right.`,
        'Transcribe exactly what is written in each cell; use "" for empty cells. No commentary.',
      ].join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the cells.' }, { type: 'image', mediaType: input.image.mediaType, data: input.image.data }] }],
      json: true,
      temperature: 0,
      maxTokens: 1500,
    };
  },
  parse(text, input) {
    const o = extractJson(text) as { cells?: unknown } | undefined;
    const rows = Array.isArray(o?.cells) ? (o!.cells as unknown[]) : [];
    return Array.from({ length: input.rows }, (_, r) => Array.from({ length: input.cols }, (_, c) => {
      const row = rows[r];
      const v = Array.isArray(row) ? row[c] : undefined;
      return typeof v === 'string' ? v.trim() : '';
    }));
  },
};

export async function readTableCells(vault: AppVault, doc: NoteDocument, pageIndex: number, t: TableObject): Promise<string[][]> {
  const ai = await strongVisionAI(doc);
  if (!ai) throw new Error('Reading table cells needs on-device recognition (the Android app) or a cloud AI with vision (Settings › AI).');
  const page = doc.page(pageIndex);
  const ink = [...strokesByCell(t, page.strokes).values()].flat();
  const only: PageInk = { ...page, strokes: ink, texts: [], images: [], objects: [t], background: undefined };
  const pages = doc.pages.map((p, i) => (i === pageIndex ? only : p));
  const img = await pageImageForAI(vault, doc.meta, pages, pageIndex, tableRect(t));
  return runSkill(readTableSkill, ai.provider, ai.model, { image: { mediaType: img.mediaType, data: img.base64 }, rows: t.rows.length, cols: t.cols.length });
}
