/**
 * Showing and reading connection codes: a QR code with the same code as copyable text, and a
 * field that takes a pasted code or one read with the camera (BarcodeDetector, where the
 * browser has it — Chrome on Android, ChromeOS and macOS; elsewhere, paste the text).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Camera, Check, ClipboardPaste, Copy } from 'lucide-react';

/** A QR code as SVG (dark modules on light, whatever the theme, so phones can read it). */
export function QrCode({ text, label }: { text: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'L');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { n: n + 8, d };
  }, [text]);
  return (
    <svg className="peer-qr" viewBox={`0 0 ${svg.n} ${svg.n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="peer-qr-paper" width={svg.n} height={svg.n} />
      <path className="peer-qr-ink" d={svg.d} />
    </svg>
  );
}

/** A code to hand to the other device: QR code, the text, and a copy button. */
export function ShowCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  // Very long codes (lots of network candidates) still copy; the QR code needs to stay readable.
  const fitsQr = code.length <= 2300;
  return (
    <div className="peer-code">
      {fitsQr ? <QrCode text={code} label={label} /> : <p className="muted small">This code is too long for a QR code on this network; copy it instead.</p>}
      <div className="peer-code-text">
        <textarea readOnly value={code} aria-label={`${label} (text)`} rows={3} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => {})}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

interface Detector { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
const Barcode = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;

/** A field for the other device's code: paste it, or read its QR code with the camera. */
export function ReadCode({ label, onCode, busy }: { label: string; onCode: (code: string) => void; busy?: boolean }) {
  const [text, setText] = useState('');
  const [scanning, setScanning] = useState(false);
  const [canScan, setCanScan] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const formats = await (Barcode as unknown as { getSupportedFormats?: () => Promise<string[]> })?.getSupportedFormats?.();
        if (live) setCanScan(!!formats?.includes('qr_code') && !!navigator.mediaDevices?.getUserMedia);
      } catch {
        /* no detector */
      }
    })();
    return () => { live = false; };
  }, []);
  const submit = (v: string) => { if (v.trim()) onCode(v.trim()); };
  return (
    <div className="peer-read">
      <label className="field">
        <span className="field-label">{label}</span>
        <textarea value={text} rows={3} placeholder="ink1:…" spellCheck={false} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="row-buttons">
        <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.readText().then((t) => { setText(t); submit(t); }, () => {})}><ClipboardPaste size={14} /> Paste</button>
        {canScan && <button type="button" className="btn btn-sm" onClick={() => setScanning(true)}><Camera size={14} /> Scan</button>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={() => submit(text)}>Continue</button>
      </div>
      {scanning && <Scanner onCode={(c) => { setScanning(false); setText(c); submit(c); }} onClose={() => setScanning(false)} />}
    </div>
  );
}

/** True when this browser can read QR codes with the camera. */
export async function canScanQr(): Promise<boolean> {
  try {
    const formats = await (Barcode as unknown as { getSupportedFormats?: () => Promise<string[]> })?.getSupportedFormats?.();
    return !!formats?.includes('qr_code') && !!navigator.mediaDevices?.getUserMedia;
  } catch {
    return false;
  }
}

/** The camera, reading QR codes until one passes `accept` (long codes start with `ink` by default). */
export function Scanner({ onCode, onClose, accept = (v) => v.startsWith('ink') }: { onCode: (c: string) => void; onClose: () => void; accept?: (raw: string) => boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const detector = new Barcode!({ formats: ['qr_code'] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stop) return;
        video.current!.srcObject = stream;
        await video.current!.play();
        while (!stop) {
          const found = await detector.detect(video.current!).catch(() => []);
          const code = found.find((f) => accept(f.rawValue))?.rawValue;
          if (code) return onCode(code);
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError' ? 'Camera access was refused. Paste the code instead.' : 'The camera could not start. Paste the code instead.');
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
    // `accept` is a filter, not a reason to restart the camera.
  }, [onCode]);
  return (
    <div className="peer-scan">
      {error ? <p className="muted small">{error}</p> : <video ref={video} muted playsInline aria-label="Camera" />}
      <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Stop scanning</button>
    </div>
  );
}
