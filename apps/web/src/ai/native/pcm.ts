/**
 * Recorded audio → what Android's recognizer reads from a file descriptor: 16-bit little-endian
 * mono PCM at 16 kHz. The WebView decodes the recording (webm/opus, mp4/aac) with Web Audio; the
 * mixing and conversion below are plain functions so they are unit-tested.
 */
export const SPEECH_SAMPLE_RATE = 16_000;

/** Averages channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i]! += c[i]! / channels.length;
  return out;
}

/** Float samples (-1..1, clipped) → 16-bit signed integers. */
export function floatToPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** PCM as little-endian bytes in base64 (the plugin's wire format). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type DecodeContext = { decodeAudioData(data: ArrayBuffer): Promise<{ numberOfChannels: number; getChannelData(i: number): Float32Array }> };

/**
 * Decodes a recording to 16 kHz mono PCM. decodeAudioData resamples to its context's rate, so an
 * OfflineAudioContext at 16 kHz does the resampling.
 */
export async function decodeToPcm16(audio: Blob, makeContext: (rate: number) => DecodeContext = (rate) => new OfflineAudioContext(1, 1, rate)): Promise<Int16Array> {
  const buf = await makeContext(SPEECH_SAMPLE_RATE).decodeAudioData(await audio.arrayBuffer());
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  return floatToPcm16(downmix(channels));
}
