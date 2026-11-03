import type { InkPoint, InkStroke } from '@inkwright/core';

/**
 * Handwriting samples: what someone wrote on the pad and what they meant, saved as a JSON file
 * they can share. They are the ground truth the maths reader is tuned on (docs/MATH.md, "Tuning
 * with real handwriting"): real strokes from a real pen on a real screen, which synthetic
 * handwriting can only approximate.
 *
 * The file holds strokes, labels, what Inkwright read on the device, and a little about the
 * device — nothing else. It stays on the device until the person shares it.
 */

export const SAMPLES_FORMAT = 'inkwright-handwriting-samples';
export const SAMPLES_VERSION = 1;

/** One stroke on the pad: points are [x, y, t, pressure], CSS px from the pad's top-left, t in ms from the stroke's start. */
export interface SampleStroke {
  createdAt: number;
  pointer: string;
  points: [number, number, number, number][];
}

export interface HandwritingSample {
  /** What the person meant, as they typed it ("2+2=", "x^2-4", "π"). */
  label: string;
  createdAt: string;
  strokes: SampleStroke[];
  /** What the on-device reader made of it when it was saved. */
  read?: { plain: string; engine: string; confidence: number } | null;
}

export interface SamplesFile {
  format: typeof SAMPLES_FORMAT;
  version: number;
  app: string;
  createdAt: string;
  device: { userAgent: string; platform: string; screen: { width: number; height: number; dpr: number } };
  pad: { width: number; height: number };
  samples: HandwritingSample[];
}

export function samplesFile(samples: HandwritingSample[], meta: Omit<SamplesFile, 'format' | 'version' | 'samples' | 'createdAt'>, now = new Date()): SamplesFile {
  return { format: SAMPLES_FORMAT, version: SAMPLES_VERSION, createdAt: now.toISOString(), ...meta, samples };
}

/** Parses a shared samples file, rejecting anything that isn't one (for tuning tools and tests). */
export function parseSamplesFile(text: string): SamplesFile {
  const o = JSON.parse(text) as SamplesFile;
  if (o?.format !== SAMPLES_FORMAT || typeof o.version !== 'number' || !Array.isArray(o.samples)) throw new Error('Not an Inkwright handwriting samples file');
  if (o.version > SAMPLES_VERSION) throw new Error(`Samples file version ${o.version} is newer than this app understands`);
  for (const s of o.samples) {
    if (typeof s.label !== 'string' || !Array.isArray(s.strokes)) throw new Error('Malformed sample');
    for (const st of s.strokes) if (!Array.isArray(st.points) || st.points.some((p) => !Array.isArray(p) || p.length < 2 || !p.every(Number.isFinite))) throw new Error('Malformed stroke');
  }
  return o;
}

/** A sample's strokes as ink, for the reader (and for replaying samples in tuning tools). */
export function sampleToInk(sample: Pick<HandwritingSample, 'strokes'>, idPrefix = 's'): InkStroke[] {
  return sample.strokes.filter((s) => s.points.length).map((s, i): InkStroke => ({
    id: `${idPrefix}${i}`,
    pen: 'ballpoint',
    color: '#FF1F2433',
    size: 1.5,
    createdAt: s.createdAt,
    input: s.pointer === 'pen' ? 'pen' : s.pointer === 'touch' ? 'touch' : 'mouse',
    points: s.points.map(([x, y, t, p]): InkPoint => ({ x, y, t: t ?? 0, p: p ?? 0.5, tilt: -1, orient: -1 })),
  }));
}

/** Rounds coordinates so a file of a few hundred samples stays small (0.1 px is below any pen's noise). */
export function roundPoint(x: number, y: number, t: number, p: number): [number, number, number, number] {
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(t), Math.round(p * 1000) / 1000];
}
