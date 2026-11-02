/// <reference lib="webworker" />
/**
 * Photo to ink off the main thread: thresholding, thinning and tracing a phone photo takes a few
 * hundred milliseconds to a couple of seconds, which must never stall the pen.
 */
import { photoToInk, type Quad, type Rgba } from '@inkstone/core';

export interface PhotoJob { image: Rgba; quad: Quad; pageWidth: number; now: number }

self.onmessage = (e: MessageEvent<PhotoJob>) => {
  try {
    const { image, quad, pageWidth, now } = e.data;
    const r = photoToInk(image, { quad, pageWidth, now });
    (self as unknown as Worker).postMessage({ ok: true, result: r }, [r.rectified.data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: (err as Error).message || String(err) });
  }
};
