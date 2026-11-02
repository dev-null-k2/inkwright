// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build scripts without type declarations
import { categoryOf } from '../../scripts/perf/android-size.mjs';
// @ts-expect-error plain ESM build scripts without type declarations
import { initialFiles } from '../../scripts/perf/bundle-report.mjs';
// @ts-expect-error plain ESM build scripts without type declarations
import { interactiveAt } from '../../scripts/perf/startup.mjs';

/**
 * The measuring scripts behind docs/PERFORMANCE.md and the CI startup budget. Their numbers are
 * only as good as these definitions: what counts as "initial", when the library is "interactive",
 * and which bucket a file in an APK or bundle belongs to.
 */

describe('startup: library interactive', () => {
  it('is the moment the library appears when no long task follows', () => {
    expect(interactiveAt(800, [])).toBe(800);
    expect(interactiveAt(800, [[100, 400]])).toBe(800); // finished before: does not count
  });

  it('waits for the end of the last long task that leaves less than 300 ms of quiet', () => {
    // 900–1000 starts within 300 ms of 800; 1250–1400 within 300 ms of 1000; 2000 is 600 ms later.
    expect(interactiveAt(800, [[1250, 1400], [900, 1000], [2000, 2100]])).toBe(1400);
  });

  it('counts a task already running when the library appears', () => {
    expect(interactiveAt(800, [[700, 950]])).toBe(950);
  });
});

describe('bundle report: what index.html loads first', () => {
  it('is the entry, its modulepreloads and the stylesheets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkwright-initial-'));
    try {
      writeFileSync(join(dir, 'index.html'), [
        '<script type="module" crossorigin src="./assets/index-a.js"></script>',
        '<link rel="modulepreload" crossorigin href="./assets/react-b.js">',
        '<link rel="stylesheet" crossorigin href="./assets/index-c.css">',
        '<link rel="manifest" href="./manifest.webmanifest">',
        '<script src="./not-a-module.js"></script>',
      ].join('\n'));
      expect(initialFiles(dir)).toEqual({ js: ['assets/index-a.js', 'assets/react-b.js'], css: ['assets/index-c.css'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Android size: categories', () => {
  it('sorts APK and bundle entries alike', () => {
    expect(categoryOf('lib/arm64-v8a/liblitertlm_jni.so')).toBe('native arm64-v8a');
    expect(categoryOf('base/lib/x86_64/libdigitalink.so')).toBe('native x86_64');
    expect(categoryOf('classes2.dex')).toBe('dex');
    expect(categoryOf('base/dex/classes.dex')).toBe('dex');
    expect(categoryOf('assets/public/assets/index-a.js')).toBe('web: js');
    expect(categoryOf('base/assets/public/assets/index-a.js.map')).toBe('web: source maps');
    expect(categoryOf('assets/public/engines/onnxruntime-web@1/dist/ort.wasm')).toBe('web: engines (bundled)');
    expect(categoryOf('assets/public/assets/sql-wasm-browser-x.wasm')).toBe('web: wasm');
    expect(categoryOf('assets/public/assets/caveat-latin-wght-normal.woff2')).toBe('web: fonts');
    expect(categoryOf('base/res/drawable/icon.xml')).toBe('resources');
    expect(categoryOf('resources.arsc')).toBe('resources');
  });

  it('does not count what a bundle carries only for Play Console (R8 mapping, symbols)', () => {
    expect(categoryOf('BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map')).toBe('bundle metadata (not installed)');
  });
});
