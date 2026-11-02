/** Encodes a canvas as image bytes (PNG/JPEG/WebP). */
export function canvasBytes(c: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => c.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('Canvas export failed'))), type, quality));
}
