import { extractJson, runSkill, type Skill } from '@inkstone/ai';
import { boundsOfStrokes, strokesByCell, tableRect, type InkStroke, type NoteDocument, type PageInk, type TableObject } from '@inkstone/core';
import { getActiveAI, transcribePage } from '../lib/ai.ts';
import { pageImageForAI } from '../lib/exporter.ts';
import { availableEngine, recognizeLocally } from '../lib/recognition.ts';
import type { AppVault } from '../lib/vault.ts';
import { useSettings } from '../state/settings.ts';

/**
 * Reading ink for the smart-ink features. Order of preference:
 *  1. on-device recognition (ML Kit in the Android app, the browser's handwriting API) — private,
 *     offline, automatic;
 *  2. the active AI's vision (whatever `getActiveAI()` returns: a cloud model with the user's key,
 *     or an on-device model) — used automatically only where the user allowed it, otherwise on an
 *     explicit tap.
 */

export interface MathReading {
  /** Plain ASCII maths ("2*x + 3 = 7"; one equation per line for systems). */
  plain: string;
  latex?: string;
  /** Worked steps, when an AI read it. */
  steps?: string[];
  /** The AI's own final answer (used only when the solver cannot do it). */
  answer?: string;
  by: 'ai' | 'local';
}

export interface MathReadInput { image: { mediaType: string; data: string } }

/**
 * A strict prompt: maths out as JSON in a syntax our solver parses, plus short steps. Nothing
 * else, so a chatty model cannot leak prose onto the page.
 */
export const readMathSkill: Skill<MathReadInput, Omit<MathReading, 'by'>> = {
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

/** Whether ink can be read right now without asking (on-device, or AI the user allowed). */
export async function canReadAutomatically(): Promise<'local' | 'ai' | false> {
  const e = await availableEngine().catch(() => 'none' as const);
  if (e === 'native' || e === 'browser') return 'local';
  const ai = await getActiveAI().catch(() => null);
  if (ai?.vision && useSettings.getState().recognition.autoAI) return 'ai';
  return false;
}

/** Whether ink can be read at all (possibly after a tap that allows the AI). */
export async function canRead(): Promise<boolean> {
  if (await canReadAutomatically()) return true;
  return !!(await getActiveAI().catch(() => null))?.vision;
}

/** Reads maths: the AI's vision when available (it also gives steps), else on-device recognition. */
export async function readMath(vault: AppVault, doc: NoteDocument, pageIndex: number, strokes: InkStroke[]): Promise<MathReading> {
  const ai = await getActiveAI().catch(() => null);
  if (ai?.vision) {
    const img = await inkImage(vault, doc, pageIndex, strokes);
    const r = await runSkill(readMathSkill, ai.provider, ai.model, { image: { mediaType: img.mediaType, data: img.base64 } });
    return { ...r, by: 'ai' };
  }
  const local = await recognizeLocally(strokes);
  if (local) return { plain: local.text.replace(/\n+/g, '\n').trim(), by: 'local' };
  throw new Error('To read handwritten maths, use the Android app (on-device recognition) or add an AI with vision in Settings › AI.');
}

/** Reads text: on-device first; the AI only when `allowAI` (an explicit tap, or auto-AI on). */
export async function readText(vault: AppVault, doc: NoteDocument, pageIndex: number, strokes: InkStroke[], allowAI: boolean): Promise<{ text: string; by: 'local' | 'ai' } | null> {
  const local = await recognizeLocally(strokes).catch(() => null);
  if (local) return { text: local.text, by: 'local' };
  if (!allowAI) return null;
  const ai = await getActiveAI().catch(() => null);
  if (!ai?.vision) return null;
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
  const ai = await getActiveAI().catch(() => null);
  if (!ai?.vision) throw new Error('Reading table cells needs an AI with vision (Settings › AI) or the Android app.');
  const page = doc.page(pageIndex);
  const ink = [...strokesByCell(t, page.strokes).values()].flat();
  const only: PageInk = { ...page, strokes: ink, texts: [], images: [], objects: [t], background: undefined };
  const pages = doc.pages.map((p, i) => (i === pageIndex ? only : p));
  const img = await pageImageForAI(vault, doc.meta, pages, pageIndex, tableRect(t));
  return runSkill(readTableSkill, ai.provider, ai.model, { image: { mediaType: img.mediaType, data: img.base64 }, rows: t.rows.length, cols: t.cols.length });
}
