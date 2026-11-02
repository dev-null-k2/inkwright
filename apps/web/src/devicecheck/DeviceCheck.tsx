/**
 * Settings › About › Check this device: measures what only a real device can tell — how often
 * the pen reports and whether it senses pressure and tilt, how long ink takes to reach the screen,
 * how smoothly frames come while drawing, the system bars and the screen, the hardware, graphics
 * and audio — and makes a report to copy or share (plain text for people, JSON for tools).
 *
 * Nothing is sent anywhere: the report leaves the device only if the person copies or shares it.
 */
import { useEffect, useRef, useState } from 'react';
import { Copy, Eraser, Share2, Stethoscope } from 'lucide-react';
import { Dialog } from '../ui/primitives.tsx';
import { useApp } from '../state/app.ts';
import { isNative } from '../platform/env.ts';
import { analyzeFrames, analyzeInput, analyzeLatency, checkFit, reportJson, reportText, type DeviceFacts, type DeviceReport } from './analysis.ts';
import { collectFacts, collectFitBoxes, readSafeArea, recordPad } from './probe.ts';

export function DeviceCheckButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}><Stethoscope size={16} /> Check this device</button>
      {open && <DeviceCheckDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The layout-fit check, kept current while the test view is open: it runs again whenever the
 * window or the visual viewport changes (folding or unfolding, rotating, the keyboard, a
 * split-screen resize), so someone can watch it while they change the device's posture.
 */
function useLiveFit(active: boolean) {
  const measure = () => {
    const insets = readSafeArea().used;
    return {
      problems: checkFit(collectFitBoxes(), { width: innerWidth, height: innerHeight }, insets),
      viewport: `${innerWidth} × ${innerHeight}`,
      bars: `${insets.top} and ${insets.bottom} px`,
    };
  };
  const [fit, setFit] = useState(() => ({ problems: [] as string[], viewport: `${innerWidth} × ${innerHeight}`, bars: '' }));
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    // After layout settles (the dialog places itself in the first frame).
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => requestAnimationFrame(() => setFit(measure()))); };
    run();
    addEventListener('resize', run);
    visualViewport?.addEventListener('resize', run);
    screen.orientation?.addEventListener?.('change', run);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', run);
      visualViewport?.removeEventListener('resize', run);
      screen.orientation?.removeEventListener?.('change', run);
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return fit;
}

function DeviceCheckDialog({ onClose }: { onClose: () => void }) {
  const toast = useApp((a) => a.toast);
  const pad = useRef<HTMLCanvasElement>(null);
  const recorder = useRef<ReturnType<typeof recordPad> | null>(null);
  const [facts, setFacts] = useState<DeviceFacts | null>(null);
  const [samples, setSamples] = useState(0);
  const [report, setReport] = useState<DeviceReport | null>(null);
  const fit = useLiveFit(report == null);

  // Facts are gathered once on open (opening is a tap, which lets the audio probe start sound).
  useEffect(() => { void collectFacts().then(setFacts); }, []);

  useEffect(() => {
    if (!pad.current) return;
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || 'currentColor';
    setSamples(0);
    const r = recordPad(pad.current, ink, setSamples);
    recorder.current = r;
    return () => { r.stop(); recorder.current = null; };
  }, [report == null]); // eslint-disable-line react-hooks/exhaustive-deps -- a fresh pad after "Check again"

  const make = () => {
    if (!facts || !recorder.current) return;
    const rec = recorder.current.results();
    const insets = readSafeArea().used;
    const boxes = collectFitBoxes();
    setReport({
      createdAt: new Date().toISOString(),
      facts,
      input: rec.samples.length ? analyzeInput(rec.samples) : null,
      latency: rec.latency.length ? analyzeLatency(rec.latency) : null,
      frames: rec.frames.length ? analyzeFrames(rec.frames) : null,
      fit: { problems: checkFit(boxes, { width: innerWidth, height: innerHeight }, insets), checked: boxes.length },
    });
  };

  const text = report ? reportText(report) : '';
  const copy = async (what: 'text' | 'json') => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(what === 'text' ? text : reportJson(report));
      toast({ text: what === 'text' ? 'Report copied' : 'JSON copied', tone: 'success' });
    } catch {
      toast({ text: 'Couldn’t copy here. Select the report and copy it by hand.', tone: 'error' });
    }
  };
  const share = async () => {
    if (!report) return;
    const title = 'Inkwright device check';
    try {
      if (isNative) {
        const { Share } = await import('@capacitor/share');
        await Share.share({ title, text, dialogTitle: 'Share the device check' });
        return;
      }
      if (navigator.share) {
        const file = new File([reportJson(report)], 'inkwright-device-check.json', { type: 'application/json' });
        const withFile = navigator.canShare?.({ files: [file] }) ? { files: [file] } : {};
        await navigator.share({ title, text, ...withFile });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast({ text: 'Sharing isn’t available here, so the report was copied instead.' });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast({ text: `Couldn’t share: ${(e as Error).message}`, tone: 'error' });
    }
  };

  return (
    <Dialog open title="Check this device" wide onClose={onClose} actions={report ? (
      <>
        <button type="button" className="btn btn-ghost" onClick={() => setReport(null)}>Check again</button>
        <button type="button" className="btn" onClick={() => void copy('json')}><Copy size={15} /> Copy JSON</button>
        <button type="button" className="btn" onClick={() => void copy('text')}><Copy size={15} /> Copy report</button>
        <button type="button" className="btn btn-primary" onClick={() => void share()}><Share2 size={15} /> Share</button>
      </>
    ) : (
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" disabled={!facts} onClick={make}>{facts ? 'Make report' : 'Measuring…'}</button>
      </>
    )}>
      {report ? (
        <div className="dc-report">
          <p className="muted small">Nothing has left this device. Copy or share the report to send it.</p>
          <pre className="dc-text" tabIndex={0} aria-label="Device report">{text}</pre>
        </div>
      ) : (
        <div className="dc-test">
          <p>Draw on the pad for a few seconds with the pen you use: loops, quick strokes, and press harder and lighter. It measures how often the pen reports, pressure and tilt, and how long ink takes to appear.</p>
          <div className="dc-pad-wrap">
            <canvas ref={pad} className="dc-pad" aria-label="Test pad: draw here" />
            <span className="dc-count" aria-live="polite">{samples ? `${samples} samples` : 'Draw here'}</span>
            {samples > 0 && <button type="button" className="btn btn-ghost btn-sm dc-clear" onClick={() => recorder.current?.clear()}><Eraser size={14} /> Clear</button>}
          </div>
          <p className="dc-fit small" aria-live="polite">
            {fit.problems.length
              ? <><span className="dc-fit-bad">Layout: {fit.problems.length === 1 ? '1 problem' : `${fit.problems.length} problems`}</span> {fit.problems[0]}</>
              : <>Layout: fits this screen ({fit.viewport}, system bars {fit.bars})</>}
          </p>
          <p className="muted small">It also reads the screen, the system bars, memory, graphics and audio. Nothing is sent anywhere.</p>
        </div>
      )}
    </Dialog>
  );
}
