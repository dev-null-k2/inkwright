// On-device OCR files for the memory timeline (src/recall/ocr-engine.ts): tesseract.js's worker,
// its WebAssembly core (SIMD + LSTM build, the wasm embedded in the .js) and the English language
// model, copied to fixed names under `tesseract/` so they load offline from the app itself.
// Only the desktop build (and the e2e build that tests the capture loop) includes them, so the
// web and Android builds stay ~7 MB lighter.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

export const OCR_FILES: Record<string, string> = {
  'tesseract/worker.min.js': 'tesseract.js/dist/worker.min.js',
  'tesseract/tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract/eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};

export function desktopOcrAssets(): Plugin {
  return {
    name: 'inkwright-desktop-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        const spec = OCR_FILES[name];
        if (!spec) return next();
        res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(require.resolve(spec)));
      });
    },
    generateBundle() {
      for (const [fileName, spec] of Object.entries(OCR_FILES)) this.emitFile({ type: 'asset', fileName, source: readFileSync(require.resolve(spec)) });
    },
  };
}
