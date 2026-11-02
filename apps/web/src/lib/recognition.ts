import { segmentLines, type InkStroke, type RecognizedLine } from '@inkstone/core';
import { InkstoneNative, hasNativePlugin } from '../platform/native.ts';
import { useSettings } from '../state/settings.ts';

/**
 * Handwriting → text. Engines, best first:
 *  - on-device ML Kit Digital Ink (Android app): private, offline, automatic;
 *  - the browser's Handwriting Recognition API where available (ChromeOS);
 *  - a vision-capable AI model with the user's own key (on request, or automatic if enabled).
 */
export type RecognitionEngine = 'native' | 'browser' | 'ai' | 'none';

let browserRecognizer: any | null | undefined;

async function getBrowserRecognizer(lang: string) {
  if (browserRecognizer !== undefined) return browserRecognizer;
  try {
    const nav = navigator as any;
    if (typeof nav.createHandwritingRecognizer !== 'function') return (browserRecognizer = null);
    const ok = await nav.queryHandwritingRecognizer?.({ languages: [lang.split('-')[0]] });
    if (!ok) return (browserRecognizer = null);
    browserRecognizer = await nav.createHandwritingRecognizer({ languages: [lang.split('-')[0]] });
  } catch {
    browserRecognizer = null;
  }
  return browserRecognizer;
}

let nativeState: 'unknown' | 'ready' | 'unavailable' = 'unknown';

export async function availableEngine(): Promise<RecognitionEngine> {
  const s = useSettings.getState().recognition;
  if (s.engine === 'off') return 'none';
  if (s.engine === 'ai') return 'ai';
  if (hasNativePlugin && nativeState !== 'unavailable') {
    try {
      const r = await InkstoneNative.prepareRecognizer({ language: s.language });
      nativeState = r.state === 'ready' ? 'ready' : r.state === 'downloading' ? 'unknown' : 'unavailable';
      if (r.state === 'ready') return 'native';
    } catch {
      nativeState = 'unavailable';
    }
  }
  if (s.engine === 'native') return 'none';
  if (await getBrowserRecognizer(s.language)) return 'browser';
  return s.autoAI ? 'ai' : 'none';
}

/**
 * Recognizes the handwriting of one page with a local engine. Null when none is available.
 * `lines` anchors each recognized line to its strokes and bounds, so search results and AI
 * citations can point at the exact handwriting.
 */
export async function recognizeLocally(strokes: InkStroke[]): Promise<{ text: string; engine: RecognitionEngine; lines: RecognizedLine[] } | null> {
  const engine = await availableEngine();
  if (engine !== 'native' && engine !== 'browser') return null;
  const lang = useSettings.getState().recognition.language;
  const lines = segmentLines(strokes);
  if (!lines.length) return { text: '', engine, lines: [] };
  if (engine === 'native') {
    let pre = '';
    const payload = lines.map((l) => {
      const item = {
        strokes: l.strokes.map((s) => ({ x: s.points.map((p) => p.x), y: s.points.map((p) => p.y), t: s.points.map((p) => s.createdAt + p.t) })),
        width: l.bounds.maxX - l.bounds.minX,
        height: l.bounds.maxY - l.bounds.minY,
        preContext: pre,
      };
      pre = '';
      return item;
    });
    const r = await InkstoneNative.recognize({ language: lang, lines: payload });
    const anchored = lines.map((l, i) => ({ text: (r.lines[i] ?? '').trim(), strokeIds: l.strokes.map((s) => s.id), bounds: l.bounds })).filter((l) => l.text);
    return { text: r.lines.filter((x) => x.trim()).join('\n'), engine, lines: anchored };
  }
  const rec = await getBrowserRecognizer(lang);
  const out: string[] = [];
  const anchored: RecognizedLine[] = [];
  for (const l of lines) {
    const drawing = rec.startDrawing({ recognitionType: 'text', inputType: 'stylus', textContext: out[out.length - 1] ?? '' });
    for (const s of l.strokes) {
      const st = new (window as any).HandwritingStroke();
      for (const p of s.points) st.addPoint({ x: p.x, y: p.y, t: p.t });
      drawing.addStroke(st);
    }
    const preds = await drawing.getPrediction();
    if (preds?.[0]?.text) {
      out.push(preds[0].text);
      anchored.push({ text: preds[0].text, strokeIds: l.strokes.map((s) => s.id), bounds: l.bounds });
    }
    drawing.clear?.();
  }
  return { text: out.join('\n'), engine, lines: anchored };
}
