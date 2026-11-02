# Performance: size and startup

What Inkwright costs to download, install and open, how that is measured, and the budget that keeps
it from creeping back. Every number here comes from a script in this repository and can be
re-measured with one command ([How to measure](#how-to-measure)).

Measured on November 2, 2026, before and after the changes described below (before: the security
review merge `b9d1ca0`). Sizes are decimal (1 MB = 10⁶ bytes), as Vite, `ls --si` and the Play
Console report them; web sizes are gzip level 9.

## Summary

| | Before | After | |
|---|---:|---:|---|
| **Play download, arm64-v8a phone** | 49.62 MB | **20.39 MB** | −59 % |
| Play download, armeabi-v7a phone | 38.34 MB | 9.11 MB | −76 % |
| Release APK people download from GitHub | 116.06 MB (universal) | **37.02 MB** (`arm64-v8a`) | −68 % |
| App Bundle uploaded to Play | 71.25 MB | 42.24 MB | −41 % (4.02 MB of it is R8's mapping, never installed) |
| Debug APK (installed by hand on the Razr Fold) | 130.83 MB | 44.39 MB | −66 % |
| Web: JavaScript before the app runs | 977.4 kB in 41 files | **303.5 kB** in 43 files | −69 % |
| Web: CSS before the app runs | 30.1 kB | 28.2 kB | |
| DuckDB, AI runtime, code parsers in the install | 106.8 MB (24.2 MB compressed) | **0**: downloaded, verified, on first use | |
| Library interactive, 4× CPU slowdown | 1,579 ms | **1,325 ms** | −16 % ([Startup](#startup)) |
| Library interactive, 4× CPU and a mid-tier mobile network | 7,443 ms | **3,538 ms** | −52 % |

What changed, in order of effect:

1. **Engines download on first use** ([details](#engines-downloaded-on-first-use)): DuckDB-WASM,
   ONNX Runtime Web and the tree-sitter grammars were 107 MB of WebAssembly in every install, used
   by a minority of people and only for specific features. They now download once when first
   needed, are checked against a SHA-384 computed at build time, and are cached for offline use.
2. **R8 and resource shrinking** for release builds, with keep rules for everything found by name
   at run time, and a build check that they hold ([Android](#android)).
3. **ABIs**: 32-bit x86 dropped (no supported device runs it); release APKs split per ABI; debug
   APKs carry only `arm64-v8a`.
4. **Only the library is in the startup bundle** ([Web](#web-what-loads-first)): the editor,
   Settings, the search palette and the app-wide overlays are separate chunks fetched while the
   library is idle; module start-up waits for the first quiet moment; pdf-lib and the MCP client
   left the startup path.
5. **No source maps in native builds** (they were 8.8 MB of the debug APK), and interface fonts
   limited to Latin.

## How to measure

```sh
# Web: initial JS/CSS, lazy chunks, and what the initial JS is made of (from source maps)
npm run build -w @inkwright/web
npm run perf:bundle -w @inkwright/web              # = node scripts/perf/bundle-report.mjs dist --why

# Startup: cold starts of the production build in Chromium at 4× CPU slowdown (and a mid-tier
# phone network), medians of 5; --budget fails on a regression (what CI runs); --against compares
# with another build, alternating run by run
npm run perf:startup -w @inkwright/web
npm run perf:budget -w @inkwright/web
node apps/web/scripts/perf/startup.mjs apps/web/dist --against /path/to/older/dist --profile both

# Why a module is in the startup bundle: the chain of static imports from src/main.tsx
node apps/web/scripts/perf/why-initial.mjs pdf-lib @modelcontextprotocol/client

# Android: composition of APKs and bundles, and the Play download per device (bundletool)
npm run cap:sync -w @inkwright/web
cd apps/web/android && ./gradlew bundleRelease && ./gradlew assembleRelease assembleDebug && cd ../../..
node apps/web/scripts/perf/android-size.mjs \
  apps/web/android/app/build/outputs/bundle/release/app-release.aab \
  apps/web/android/app/build/outputs/apk/release/app-arm64-v8a-release.apk \
  apps/web/android/app/build/outputs/apk/debug/app-debug.apk

# Android: everything Capacitor and native code find by name survived R8
node apps/web/scripts/android/check-r8.mjs
```

`android-size.mjs` runs bundletool from `$BUNDLETOOL` (the all-in-one jar) or, if that is not set,
from the copy the Android Gradle plugin already downloaded, so any machine that has built the app
can measure it offline. The Play download is what `bundletool get-size total` reports for the
APKs Play would generate: an arm64-v8a phone at xxhdpi, English, Android 14, and the range over
every configuration per ABI.

## Web: what loads first

"Initial" is exactly what `index.html` makes the browser fetch before the app runs: the entry
module, every `<link rel="modulepreload">` Vite emits for its static import graph, and the
stylesheet. Everything else is lazy.

| | Before | After |
|---|---:|---:|
| Initial JS (gzip) | 977.4 kB, 41 files | 303.5 kB, 43 files |
| Initial CSS (gzip) | 30.1 kB | 28.2 kB |
| Lazy JS (gzip) | 935.3 kB, 32 files | 1.66 MB, 87 files |
| Workers (gzip) | 1.00 MB, 6 files | 0.94 MB, 6 files |
| Fonts (woff2, by `unicode-range`) | 571.5 kB, 21 files | 525.7 kB, 16 files |

What the 303.5 kB of initial JavaScript is (minified bytes by origin, `perf:bundle --why`):
react-dom 207 kB, `@inkwright/core` 196 kB, `@inkwright/ai` 103 kB (the settings and provider
registry the library reads), `@inkwright/sync` 79 kB (the sync loop starts with the library),
`src/canvas` 57 kB (thumbnails are drawn by the ink engine's renderer), `src/lib` 56 kB, then
nothing over 21 kB. Before, the same list started with pdf-lib (217 kB), the MCP client (190 kB),
zod (96 kB) and the editor's whole tree.

How:

- **Screens and overlays are chunks** (`apps/web/src/boot/screens.ts`). `lazyNamed` wraps
  `React.lazy` with a `preload()` that shares the same promise, so preloading never fetches twice
  and a fast tap still works (the screen loads on demand behind a brand-mark fallback).
- **A background phase** (`apps/web/src/boot/background.ts`). Right after the library appears the
  main thread belongs to the person: module start-up (routines, plugins, peers…), the app-wide
  overlays and chunk preloading wait until the library has had 1.2 s to itself and the next idle
  period, or until the person leaves the library (then at the next idle moment, after the new
  screen has painted). Preloading is sequential: on a slow phone, evaluating a 100 kB chunk is a
  long task, and several at once would make the library janky exactly when someone scrolls.
- **The search shortcut is never lost** (`apps/web/src/boot/paletteShortcut.ts`): until the
  palette's chunk is on screen, Ctrl/⌘-K opens it through its store and mounts it at once.
- **Startup imports pruned**: pdf-lib loads with PDF export and import (`dev/diagramPdf.ts`,
  `authorship/certificate.ts`); the MCP OAuth redirect handler no longer imports the MCP client
  (`lib/agent/oauth-keys.ts`); the workspace packages declare `"sideEffects": false` so unused
  exports are dropped.
- **Fonts**: the interface faces (Hanken Grotesk, Brygada 1918) carry Latin and Latin Extended
  only, because the interface is in English (`src/styles/fonts.css`); the faces people write and
  export with (Caveat, Newsreader, JetBrains Mono) keep every script subset. Each subset is a
  separate file behind a `unicode-range`, so a browser fetches only those a page uses. Fonts stay
  in the install: they are 0.53 MB, and the first page must not wait for them.

## Startup

`scripts/perf/startup.mjs` serves a build with gzip like a real host, and measures cold starts
(fresh browser context: empty HTTP cache, storage and service worker) in Chromium, with the CPU
slowed down 4× through the DevTools protocol — roughly a mid-range phone.

- **FCP / LCP**: first and largest contentful paint.
- **Library visible**: the first frame with a note card.
- **Library interactive**: from then, the end of the first 300 ms window without a long task, i.e.
  from when a tap is handled within 50 ms.
- **Long tasks / blocking time** before interactive (blocking: each long task's time over 50 ms).
- **Note open**: tapping the welcome note to the editor's first frame, once the app has settled,
  and **early tap**: the same the instant the library appears (the editor chunk loads on demand).

Medians in milliseconds. `cpu4`: 4× CPU slowdown, unthrottled network (5 runs per build).
`mid-tier`: 4× CPU plus Lighthouse's mobile network, 150 ms RTT and 1.6 Mbps down (3 runs per
build). The before and after builds were measured alternately, run by run, so that both saw the
same machine (a shared 2-core Linux VM, Chromium 1243 headless; load average 2–8 during the runs).

| | cpu4 before | cpu4 after | mid-tier before | mid-tier after |
|---|---:|---:|---:|---:|
| First contentful paint | 940 | **652** | 6,856 | **2,736** |
| Largest contentful paint | 1,624 | **1,392** | 7,496 | **3,640** |
| Library visible | 1,095 | **820** | 6,992 | **2,951** |
| **Library interactive** | 1,579 | **1,325** | 7,443 | **3,538** |
| Long tasks before interactive | 5 | 5 | 6 | 5 |
| Blocking time before interactive | 815 | **450** | 776 | **580** |
| Blocking time in the 4.5 s after FCP, background work included | 334 | 592 | 277 | 636 |
| JavaScript transferred before interactive | 995 kB | **317 kB** | 995 kB | **317 kB** |
| Note open, app settled | 679 | 645 | 672 | 692 |
| Note open, tapped the instant the library appears | 1,144 | 1,442 | 1,092 | 4,520 |
| Navigation to editor, for that instant tap | 2,239 | 2,262 | 8,084 | 7,471 |

What the numbers say:

- The library paints and becomes usable sooner: interactive 16 % sooner on a slow CPU, 52 % sooner
  on a slow CPU over a mobile network, where the 680 kB of JavaScript no longer downloaded first
  dominates. Blocking time before interactive almost halves.
- The work did not disappear; it moved. Module start-up and the preloading of the other screens
  now run after the library is interactive, one chunk per idle period, which is why blocking time
  over the first seconds, background included, is higher. None of it lands in the first 300 ms
  window after the library appears, by design (`BACKGROUND_DELAY_MS`).
- Opening a note once the app has settled is unchanged: the editor chunk is preloaded and renders
  without a Suspense fallback (`lazyNamed`, `apps/web/src/boot/lazy.ts`; going through
  `React.lazy` cost ~300 ms of fallback throttling before that was fixed).
- The one case that got slower is a tap in the very first moment, before the editor chunk has been
  preloaded: it then loads on demand (1.4 s on cpu4; 4.5 s on the throttled network, which is
  mostly the 138 kB chunk crossing a 1.6 Mbps link). Counted from navigation, that person still
  reaches the editor no later than before (2.26 s vs 2.24 s; 7.5 s vs 8.1 s).

Re-measure one build with `npm run perf:startup -w @inkwright/web`, or compare two the way the table
was made: `node apps/web/scripts/perf/startup.mjs apps/web/dist --against <older build's dist>
--profile both`.

The CI budget (`apps/web/perf/budget.json`, run by `.github/workflows/ci.yml` after the e2e
suite): initial JS ≤ 337,920 bytes gzip, initial CSS ≤ 32,768 bytes, and at 4× CPU the median
library interactive ≤ 1,500 ms and LCP ≤ 2,000 ms. Bytes are exact; times depend on the machine,
so `PERF_BUDGET_SLACK=1.5` widens the time budgets (never the bytes) on a slow runner. Raise a
number only in the change that needs it, and say why.

## Engines downloaded on first use

| Engine | Files | On the device | Download (gzip) | Needed for |
|---|---|---:|---:|---|
| DuckDB (`duckdb-eh`) | `duckdb-eh.wasm`, its worker | 35.02 MB | 7.90 MB | fast SQL in the data sandbox (browsers with WebAssembly exceptions: all current ones) |
| DuckDB, compatibility build (`duckdb-mvp`) | `duckdb-mvp.wasm`, its worker | 40.21 MB | 8.97 MB | the same, on older browsers; only the build `selectBundle` picks is ever fetched |
| AI runtime (`onnx-runtime`) | ONNX Runtime Web (`.wasm` + `.mjs`) | 26.91 MB | 6.71 MB | on-device models in the app (search by meaning, transcripts, the assistant); it comes with the first model download, whose progress bar includes it |
| Code parsers (`tree-sitter`) | the runtime and 7 grammars | 5.68 MB | 0.70 MB | scanning a repository (developer module); each grammar when its language first appears |

SQLite (sql.js, 0.34 MB compressed) stays in the install: data queries and ```` ```sql ```` runbook
blocks work offline from the first launch, and while DuckDB is downloading or unreachable the data
panel says so and answers in SQLite. Hugging Face models were already downloaded on demand.

**How it works.** At build time, `apps/web/build/engines.ts` reads the exact files npm installed
and writes a catalog into the app: for each file its size, compressed size, SHA-384 and URL. At
run time `apps/web/src/engines/store.ts` fetches a file when a feature first asks for it, verifies
the SHA-384 with Web Crypto, and only then stores it in Cache Storage (`inkwright-engines-v1`) and
hands the feature a `blob:` URL. A file that does not match is an error, never a fallback; nothing
unverified is cached or run. Later uses read the cache, offline. The download shows progress where
the feature is (the data panel, the on-device AI setup) with copy that says it is one-time; Settings
› About › *Downloaded when first used* lists each engine with its size, and can fetch it ahead of
going offline or remove it. After an app update, files the new catalog no longer lists are deleted
at idle time. Workers use the same code (the AI worker fetches its own runtime) and a
`BroadcastChannel` keeps Settings current.

**Where from.** Native builds fetch from jsDelivr at version-pinned URLs
(`https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path>`), so the files are not in the APK. jsDelivr
serves npm package files byte for byte, which is why the checksums computed from `node_modules`
match. Web builds serve the files themselves, under `engines/<pkg>@<version>/` next to the app, so a
hosted copy needs no third party and works on an intranet; the service worker leaves them to the
engine cache rather than precaching 108 MB. Overrides: `INKWRIGHT_ENGINE_SOURCE=app` puts them back
into a native build (a fully offline enterprise APK), `INKWRIGHT_ENGINE_SOURCE=cdn` makes a web
build use the CDN (hosts with a per-file size limit), `INKWRIGHT_ENGINES_CDN` points at a mirror
with the same layout. The single-file preview build has none of them.

**Security.** The integrity check is what makes the CDN safe to use: a compromised or wrong mirror
can make a download fail, not substitute code. The sandbox restrictions from the security review
are unchanged and do not depend on where the engine came from: DuckDB is closed off
(`DUCKDB_HARDENING`: no external access, no extensions, configuration locked) right after it is
instantiated and before any query, or it is not used (SR-02); the runbook `js` sandbox does not use
engines (SR-05); the Content Security Policy is the same (`blob:` workers and WebAssembly were
already allowed for the AI runtime). The privacy policy says which features make the one-time
request and to whom ([PRIVACY.md](PRIVACY.md)).

**Why not Play Asset Delivery or Feature Delivery.** Play's on-demand asset packs would deliver the
same files on Android only, and only to installs from Google Play: not to the APKs on GitHub
Releases (how Inkwright is distributed today), iOS or the web, which would all still need this
mechanism. Their files also arrive as native files that the WebView would need a bridge to read.
Install-time and fast-follow packs do not reduce what a phone downloads at all. One mechanism,
verified by checksums the build controls, covers every platform; the cost is that native builds
depend on jsDelivr (or a configured mirror) the first time each engine is used, which degrades
to a clear message and, for data queries, to SQLite.

Feature Delivery is the right tool for the largest remaining item, LiteRT-LM's native library
(22.7 MB on arm64-v8a, about half of the Play download): it is only needed by people who run open
models on a phone without Gemini Nano. Moving it to an on-demand dynamic feature module means
moving the LiteRT bridge into that module behind an interface, loading it with SplitCompat, and
keeping a separate path for sideloaded APKs, which cannot install feature modules. That is a
change to the native AI code that needs testing on devices; it is the next step, not part of this
one.

## Android

### Composition

Release APK before (universal, R8 off) and the `arm64-v8a` release APK after; "stored" is the
size inside the APK, "raw" uncompressed. Native libraries are stored uncompressed and page-aligned
(the default since Android 6): the system maps them straight from the APK instead of extracting a
second copy, so the installed footprint is the APK size.

| | Before: stored | Before: raw | After: stored | After: raw |
|---|---:|---:|---:|---:|
| Native, x86_64 | 35.84 MB | 35.84 MB | — | — |
| Native, arm64-v8a | 29.80 MB | 29.80 MB | 29.80 MB | 29.80 MB |
| Web: WebAssembly | 24.20 MB | 106.83 MB | 0.34 MB (SQLite) | 0.69 MB |
| Native, x86 | 9.18 MB | 9.18 MB | — | — |
| Dex (Java/Kotlin) | 7.86 MB | 21.21 MB | 2.87 MB | 6.84 MB |
| Native, armeabi-v7a | 4.57 MB | 4.57 MB | — | — |
| Web: JavaScript | 2.92 MB | 9.75 MB | 2.50 MB | 7.92 MB |
| Resources | 0.71 MB | 0.83 MB | 0.66 MB | 0.76 MB |
| Web: fonts | 0.57 MB | 0.57 MB | 0.53 MB | 0.53 MB |
| Everything else, and zip overhead | 0.41 MB | 0.86 MB | 0.32 MB | 0.86 MB |
| **APK** | **116.06 MB** | | **37.02 MB** | |

The native libraries for arm64-v8a are LiteRT-LM (`liblitertlm_jni.so`, 22.69 MB: open models on
the phone), ML Kit digital ink recognition (`libdigitalink.so`, 6.89 MB) and AndroidX graphics-core
(`libgraphics-core.so`, 0.21 MB, the low-latency ink layer). All three ship stripped already (no
`.symtab` or debug sections); the "Unable to strip" line in the Gradle log only means the NDK is
not installed, and costs nothing.

The App Bundle (42.24 MB) carries all three ABIs and 4.02 MB of `BUNDLE-METADATA` (R8's mapping,
for the Play Console's crash reports), none of which a phone downloads. What Play sends, per
`bundletool get-size total`:

| Device | Before | After |
|---|---:|---:|
| arm64-v8a (nearly every phone, the Razr Fold) | 49.56–49.62 MB | 20.36–20.40 MB |
| armeabi-v7a (32-bit phones) | 38.27–38.34 MB | 9.07–9.11 MB |
| x86_64 (Chromebooks, emulator) | 50.72–50.79 MB | 21.52–21.56 MB |
| x86 | 39.48–39.55 MB | not shipped |

Debug APK: 130.83 MB → 44.39 MB (native 29.80 MB for arm64-v8a only, dex 9.84 MB unshrunk, web
JavaScript 2.77 MB; source maps 8.77 MB → none).

### ABIs

`apps/web/android/app/build.gradle` ships `arm64-v8a`, `armeabi-v7a` and `x86_64`, and leaves out
32-bit `x86` (no supported phone, tablet or Chromebook runs it) through packaging excludes, which
apply to APKs and bundles alike (`ndk.abiFilters` cannot be combined with ABI splits).

- **App Bundle (Play)**: all three; Play delivers one per device, so they cost nothing.
- **Release APKs (GitHub Releases)**: split per ABI instead of one universal APK (116 MB before),
  published as `Inkwright-<version>-arm64-v8a.apk` (what phones need), `-armeabi-v7a.apk` (32-bit
  phones; LiteRT-LM has no 32-bit build, so open on-device models are reported unavailable there)
  and `-x86_64.apk`. A universal APK with all three would be about 77 MB, for nobody's benefit.
- **Debug APKs**: `arm64-v8a` only (`-Pinkwright.debugAbis=arm64-v8a,x86_64` adds more; the
  emulator suite passes its image's ABI).

The Android Gradle plugin cannot build split APKs and a shrunk bundle in one invocation
([issue 402800800](https://issuetracker.google.com/402800800)); the build stops with a message
saying to run `bundleRelease` and `assembleRelease` separately, as the release workflow does.

### R8 and resource shrinking

Release builds set `minifyEnabled true` and `shrinkResources true` with
`proguard-android-optimize.txt`. Dex went from 21.21 MB to 6.84 MB uncompressed.

Capacitor finds plugins by reflection, which is why it ships with R8 off by default. What has to
keep its name, and what keeps it:

| Found by name at run time | Kept by |
|---|---|
| Capacitor plugin classes listed in `capacitor.plugins.json`, their `@PluginMethod`, `@PermissionCallback` and `@ActivityCallback` methods | Capacitor's consumer rules (`@CapacitorPlugin` classes and annotated methods) |
| `InkwrightNativePlugin`'s 26 plugin methods and its permission callback | the same rules (it is a `@CapacitorPlugin`) |
| `@capgo/capacitor-social-login` (Google sign-in through Credential Manager) | its consumer rules (the plugin, `androidx.credentials`, Google ID). Facebook, Apple and Twitter providers are not compiled in (`android/gradle.properties`) |
| ML Kit digital ink, ML Kit GenAI task APIs, Play services, AndroidX | their consumer rules |
| LiteRT-LM: its JNI library looks up Java classes, fields and callbacks by name | `app/proguard-rules.pro`: `com.google.ai.edge.litertlm.**` kept whole (~200 kB of Java) |
| ML Kit GenAI's shared module (the IPC boundary to Gemini Nano in AICore), which has no consumer rules | `app/proguard-rules.pro`: `com.google.mlkit.genai.**` kept whole |
| `@JavascriptInterface` methods (none today) | `app/proguard-rules.pro` |

`scripts/android/check-r8.mjs` turns this table into a build check: it reads the plugin sources
and R8's `mapping.txt` and fails if any plugin class Capacitor loads by name was renamed, any
method JavaScript calls is renamed or gone, or any class in the kept-whole packages was renamed.
On this build: 8 plugins and 74 methods called by name keep their names; 356 classes reached from
native code are intact. The release workflow runs it after building, and publishes the mapping
with each release (`Inkwright-<version>-r8-mapping.txt`) to read stack traces. Stack traces keep
line numbers (`-keepattributes SourceFile,LineNumberTable`).

A static check cannot prove the shrunk app runs on a phone. `assembleRelease`, `bundleRelease`
and `testDebugUnitTest` (153 JVM tests) pass; the native AI paths behind AICore and LiteRT-LM need
a real device, as before (docs/ANDROID.md, `npm run e2e:android`).

### Where the outputs are

| Output | Path (under `apps/web/android/app/build/outputs/`) |
|---|---|
| App Bundle for Play | `bundle/release/app-release.aab` |
| Release APKs | `apk/release/app-arm64-v8a-release.apk`, `app-armeabi-v7a-release.apk`, `app-x86_64-release.apk` |
| Debug APK | `apk/debug/app-debug.apk` |
| R8 mapping, seeds, usage | `mapping/release/` |
