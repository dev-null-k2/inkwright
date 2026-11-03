/**
 * Settings › About › Check this device › "Record handwriting samples": write on the pad, type
 * what you meant, save; repeat; then share the file. Each sample also keeps what the on-device
 * maths reader read, so a shared file shows exactly where reading goes wrong on this device and
 * this pen. Nothing leaves the device unless the person shares the file (docs/MATH.md).
 */
import { useEffect, useRef, useState } from 'react';
import { Eraser, Share2 } from 'lucide-react';
import { Dialog } from '../ui/primitives.tsx';
import { useApp } from '../state/app.ts';
import { APP_VERSION, nativePlatform } from '../platform/env.ts';
import { saveFile } from '../platform/files.ts';
import { readMathLocally } from '../smart/inkmath.ts';
import { roundPoint, sampleToInk, samplesFile, type HandwritingSample, type SampleStroke } from './samples.ts';
import './samples.css';

/** Samples survive closing the dialog (until the app reloads), so a long session isn't lost to a stray tap. */
let kept: HandwritingSample[] = [];

/** Captures strokes on a canvas: every coalesced pointer event, with pressure and timing. */
function usePad(el: HTMLCanvasElement | null, onChange: (n: number) => void) {
  const strokes = useRef<SampleStroke[]>([]);
  const redraw = useRef<() => void>(() => {});
  useEffect(() => {
    if (!el) return;
    const ctx = el.getContext('2d');
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || 'currentColor';
    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      el.width = Math.round(r.width * dpr);
      el.height = Math.round(r.height * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw.current();
    };
    redraw.current = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.strokeStyle = ink;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of strokes.current) {
        ctx.beginPath();
        s.points.forEach(([x, y, , p], i) => { ctx.lineWidth = 1.2 + 2.4 * (p || 0.5); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        if (s.points.length === 1) ctx.lineTo(s.points[0]![0] + 0.1, s.points[0]![1]);
        ctx.stroke();
      }
    };
    let cur: { s: SampleStroke; t0: number; id: number } | null = null;
    const add = (e: PointerEvent) => {
      if (!cur) return;
      const r = el.getBoundingClientRect();
      const evs = typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e];
      for (const p of evs) cur.s.points.push(roundPoint(p.clientX - r.left, p.clientY - r.top, p.timeStamp - cur.t0, p.pressure || 0.5));
      redraw.current();
    };
    const down = (e: PointerEvent) => {
      if (e.button > 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or already-lifted pointer */ }
      cur = { s: { createdAt: Date.now(), pointer: e.pointerType || 'mouse', points: [] }, t0: e.timeStamp, id: e.pointerId };
      strokes.current.push(cur.s);
      add(e);
    };
    const move = (e: PointerEvent) => { if (cur && e.pointerId === cur.id) add(e); };
    const up = (e: PointerEvent) => {
      if (!cur || e.pointerId !== cur.id) return;
      add(e);
      cur = null;
      onChange(strokes.current.length);
    };
    fit();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    addEventListener('resize', fit);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      removeEventListener('resize', fit);
    };
  }, [el]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    take(): SampleStroke[] { const s = strokes.current; strokes.current = []; redraw.current(); onChange(0); return s; },
    clear() { strokes.current = []; redraw.current(); onChange(0); },
  };
}

export function SampleRecorderDialog({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const toast = useApp((a) => a.toast);
  // A callback ref: the dialog mounts its content after its own first render.
  const [padEl, setPadEl] = useState<HTMLCanvasElement | null>(null);
  const [count, setCount] = useState(0);
  const [label, setLabel] = useState('');
  const [samples, setSamples] = useState<HandwritingSample[]>(kept);
  const pad = usePad(padEl, setCount);
  useEffect(() => { kept = samples; }, [samples]);

  const save = async () => {
    if (!count || !label.trim()) return;
    const strokes = pad.take();
    const sample: HandwritingSample = { label: label.trim(), createdAt: new Date().toISOString(), strokes };
    setLabel('');
    setSamples((s) => [...s, sample]);
    // What the on-device reader makes of it, for whoever tunes the reader from this file.
    const r = await readMathLocally(sampleToInk(sample)).catch(() => null);
    sample.read = r ? { plain: r.plain, engine: r.engine, confidence: Math.round(r.confidence * 1000) / 1000 } : null;
    setSamples((s) => [...s]);
  };

  const share = async () => {
    const el = padEl;
    const file = samplesFile(samples, {
      app: APP_VERSION,
      device: { userAgent: navigator.userAgent, platform: nativePlatform, screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio || 1 } },
      pad: { width: Math.round(el?.clientWidth ?? 0), height: Math.round(el?.clientHeight ?? 0) },
    });
    try {
      await saveFile(`inkwright-handwriting-samples-${file.createdAt.slice(0, 10)}.json`, new TextEncoder().encode(JSON.stringify(file)), 'application/json');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast({ text: `Couldn’t save the file: ${(e as Error).message}`, tone: 'error' });
    }
  };

  return (
    <Dialog open title="Record handwriting samples" wide onClose={onClose} actions={(
      <>
        <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
        <button type="button" className="btn" disabled={!samples.length} onClick={() => { setSamples([]); kept = []; }}>Discard all</button>
        <button type="button" className="btn btn-primary" disabled={!samples.length} onClick={() => void share()}><Share2 size={15} /> Share file</button>
      </>
    )}>
      <div className="dc-test hs">
        <p>Write something on the pad as you normally would — a sum, a fraction, one symbol — then type what you meant and save it. The file stays on this device until you share it; it helps tune how Inkwright reads your handwriting.</p>
        <div className="dc-pad-wrap">
          <canvas ref={setPadEl} className="dc-pad" aria-label="Sample pad: write here" />
          <span className="dc-count" aria-live="polite">{count ? `${count} ${count === 1 ? 'stroke' : 'strokes'}` : 'Write here'}</span>
          {count > 0 && <button type="button" className="btn btn-ghost btn-sm dc-clear" onClick={() => pad.clear()}><Eraser size={14} /> Clear</button>}
        </div>
        <form className="hs-row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What you wrote, e.g. 2+2= or x^2-4" aria-label="What you wrote" />
          <button type="submit" className="btn btn-primary" disabled={!count || !label.trim()}>Save sample</button>
        </form>
        <p className="muted small" aria-live="polite">{samples.length ? `${samples.length} ${samples.length === 1 ? 'sample' : 'samples'}` : 'No samples yet'}</p>
        {samples.length > 0 && (
          <ul className="hs-list" aria-label="Saved samples">
            {samples.slice(-6).reverse().map((s) => (
              <li key={s.createdAt + s.label}>
                <span className="hs-label">{s.label}</span>
                <span className="muted small">{s.read === null ? 'not read' : s.read ? `read as ${s.read.plain || 'nothing'}` : 'reading…'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
