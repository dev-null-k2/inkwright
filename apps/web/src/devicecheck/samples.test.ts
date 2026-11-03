import { describe, expect, it } from 'vitest';
import { parseSamplesFile, roundPoint, sampleToInk, samplesFile, SAMPLES_FORMAT } from './samples.ts';

describe('handwriting samples file', () => {
  const sample = { label: '2+2=', createdAt: '2026-11-02T10:00:00.000Z', strokes: [{ createdAt: 5, pointer: 'pen', points: [roundPoint(1.234, 2.25, 0.4, 0.51234), roundPoint(3, 4, 8, 0.6)] }], read: { plain: '2+2=', engine: 'ml-kit', confidence: 0.9 } };
  const meta = { app: '1.0.0', device: { userAgent: 'test', platform: 'android', screen: { width: 720, height: 800, dpr: 2.5 } }, pad: { width: 600, height: 240 } };

  it('round-trips through JSON and rejects other files', () => {
    const file = samplesFile([sample], meta, new Date('2026-11-02T10:00:00Z'));
    expect(file.format).toBe(SAMPLES_FORMAT);
    const back = parseSamplesFile(JSON.stringify(file));
    expect(back.samples[0]!.strokes[0]!.points[0]).toEqual([1.2, 2.3, 0, 0.512]);
    expect(() => parseSamplesFile('{"format":"something-else","version":1,"samples":[]}')).toThrow();
    expect(() => parseSamplesFile(JSON.stringify({ ...file, version: 99 }))).toThrow(/newer/);
    expect(() => parseSamplesFile(JSON.stringify({ ...file, samples: [{ label: 'x', strokes: [{ points: [[1, 'a']] }] }] }))).toThrow();
  });

  it('turns a sample back into ink for the reader', () => {
    const ink = sampleToInk(sample);
    expect(ink).toHaveLength(1);
    expect(ink[0]).toMatchObject({ input: 'pen', createdAt: 5 });
    expect(ink[0]!.points[1]).toMatchObject({ x: 3, y: 4, t: 8, p: 0.6 });
  });
});
