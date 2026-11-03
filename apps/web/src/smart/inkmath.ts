import { builtInRecognizer, readMathInk, type InkGroup, type MathInkReading, type RawCandidate, type SymbolRecognizer } from '@inkwright/core';
import type { InkStroke } from '@inkwright/core';
import { availableEngine } from '../lib/recognition.ts';
import { InkwrightNative, hasNativePlugin } from '../platform/native.ts';
import { useSettings } from '../state/settings.ts';

/**
 * Handwritten maths, read on this device: picks the best stroke recognizer available and runs
 * the deterministic reader in @inkwright/core (packages/core/src/mathink; docs/MATH.md).
 *
 * Engines, best first — all on device, nothing leaves it:
 *  1. ML Kit Digital Ink in the Android app, one ink per symbol with ranked candidates
 *     (`recognizeSymbols` in InkwrightNativePlugin.kt);
 *  2. the browser's Handwriting Recognition API where it exists (ChromeOS), with alternatives;
 *  3. the built-in template classifier, which always works but knows fewer handwriting styles.
 * A picture is never involved: small on-device vision models misread handwriting badly (a
 * "2+2=" came back as "the Roman numeral fifteen and an arrow"), and strokes carry more than
 * pixels — order, direction, which marks belong together.
 */

/** The part of the native plugin this module uses (also what the e2e stand-in implements). */
export interface SymbolPlugin {
  prepareRecognizer(opts: { language: string }): Promise<{ state: 'ready' | 'downloading' | 'failed' | 'unsupported' }>;
  recognize(opts: { language: string; lines: NativeInk[] }): Promise<{ lines: string[] }>;
  recognizeSymbols?(opts: { language: string; inks: NativeInk[]; maxCandidates: number }): Promise<{ results: { candidates: { text: string; score: number | null }[] }[] }>;
}

interface NativeInk { strokes: { x: number[]; y: number[]; t: number[] }[]; width: number; height: number; preContext: string }

declare const __E2E__: boolean;
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

/** E2E builds accept a scripted stand-in for ML Kit, set by the test before the app loads. */
function e2eRecognizer(): SymbolPlugin | null {
  return E2E_BUILD ? ((globalThis as { __inkwrightFakeRecognizer?: SymbolPlugin }).__inkwrightFakeRecognizer ?? null) : null;
}

/** Inks relative to the top-left of everything read in one call, so ML Kit's writing area means something. */
function toNativeInks(groups: readonly InkGroup[], area: { width: number; height: number }): NativeInk[] {
  const ox = Math.min(...groups.map((g) => g.bounds.minX)), oy = Math.min(...groups.map((g) => g.bounds.minY));
  return groups.map((g) => ({
    strokes: g.strokes.map((s) => ({ x: s.points.map((p) => p.x - ox), y: s.points.map((p) => p.y - oy), t: s.points.map((p) => s.createdAt + p.t) })),
    width: area.width,
    height: area.height,
    preContext: '',
  }));
}

/** ML Kit (or its e2e stand-in) as a symbol recognizer. */
export function mlKitSymbols(plugin: SymbolPlugin, language: string): SymbolRecognizer {
  return {
    name: 'ml-kit',
    async recognize(groups, area) {
      if (!groups.length) return [];
      const inks = toNativeInks(groups, area);
      if (plugin.recognizeSymbols) {
        const r = await plugin.recognizeSymbols({ language, inks, maxCandidates: 6 });
        return groups.map((_, i) => (r.results[i]?.candidates ?? []).map((c): RawCandidate => ({ text: c.text, score: c.score })));
      }
      // An app built before recognizeSymbols: one ink per "line", top answer only.
      const r = await plugin.recognize({ language, lines: inks });
      return groups.map((_, i) => (r.lines[i] ? [{ text: r.lines[i]! }] : []));
    },
  };
}

/** The browser's Handwriting Recognition API (ChromeOS), one drawing per symbol, with alternatives. */
function browserSymbols(rec: any): SymbolRecognizer {
  return {
    name: 'browser',
    async recognize(groups) {
      const out: RawCandidate[][] = [];
      for (const g of groups) {
        const drawing = rec.startDrawing({ recognitionType: 'text', inputType: 'stylus', alternatives: 5 });
        for (const s of g.strokes) {
          const st = new (window as any).HandwritingStroke();
          for (const p of s.points) st.addPoint({ x: p.x, y: p.y, t: p.t });
          drawing.addStroke(st);
        }
        const preds: { text: string }[] = (await drawing.getPrediction()) ?? [];
        drawing.clear?.();
        out.push(preds.map((p) => ({ text: p.text })));
      }
      return out;
    },
  };
}

let browserRec: any | null | undefined;
async function browserRecognizer(language: string): Promise<any | null> {
  if (browserRec !== undefined) return browserRec;
  try {
    const nav = navigator as any;
    const lang = language.split('-')[0];
    if (typeof nav.createHandwritingRecognizer !== 'function' || !(await nav.queryHandwritingRecognizer?.({ languages: [lang] }))) return (browserRec = null);
    browserRec = await nav.createHandwritingRecognizer({ languages: [lang] });
  } catch { browserRec = null; }
  return browserRec;
}

/**
 * The on-device recognizer to read maths with, or null when the person turned handwriting
 * recognition off (Settings › Pen & touch).
 */
export async function localSymbolRecognizer(): Promise<SymbolRecognizer | null> {
  const s = useSettings.getState().recognition;
  if (s.engine === 'off') return null;
  const fake = e2eRecognizer();
  if (fake) {
    const ready = await fake.prepareRecognizer({ language: s.language }).catch(() => ({ state: 'failed' as const }));
    return ready.state === 'ready' ? mlKitSymbols(fake, s.language) : builtInRecognizer;
  }
  const engine = await availableEngine().catch(() => 'none' as const);
  if (engine === 'native' && hasNativePlugin) return mlKitSymbols(InkwrightNative, s.language);
  if (engine === 'browser') { const rec = await browserRecognizer(s.language); if (rec) return browserSymbols(rec); }
  return builtInRecognizer;
}

/** How an engine is named to people ("Read on this device with …"). */
export function engineLabel(name: string): string {
  return name === 'ml-kit' ? 'ML Kit' : name === 'browser' ? 'the browser’s handwriting recognition' : 'Inkwright’s built-in reader';
}

/**
 * Below these the reading is shaky: the weakest symbol or the reading as a whole. Then a strong
 * cloud AI with vision may read it instead, when one is set up (read.ts).
 */
export const CONFIDENT = { overall: 0.5, weakest: 0.2 };

export function isConfident(r: MathInkReading): boolean {
  return !!r.plain && r.confidence >= CONFIDENT.overall && r.weakest >= CONFIDENT.weakest;
}

/** Reads handwritten maths on this device. Null when recognition is off. */
export async function readMathLocally(strokes: readonly InkStroke[]): Promise<MathInkReading | null> {
  const rec = await localSymbolRecognizer();
  if (!rec) return null;
  try {
    return await readMathInk(strokes, rec);
  } catch {
    // A failing engine (ML Kit model missing mid-call) must not stop the built-in reader.
    return rec === builtInRecognizer ? null : readMathInk(strokes, builtInRecognizer);
  }
}
