# On-device AI and search everything

Most people will never paste an API key. Inkstone therefore runs its assistant, **Ask** and
search by meaning on the device by default. The model runs inside the app, nothing leaves the
device, and after one download it works offline. People who have a key, or who already run
Ollama or LM Studio, can choose those instead.

This document records what we evaluated in November 2026, what we chose and why, and how it is
built. Sources are listed at the end.

## What we chose

| Role | Default | Runtime |
|---|---|---|
| Embeddings (search by meaning) | **EmbeddingGemma 2**, text-only, 256-d Matryoshka (190 MB on GPU, 207 MB on CPU); **Granite Embedding 97M** on devices without WebGPU (123 MB) | transformers.js 4 in a Web Worker |
| Chat (assistant, Ask) | By device tier: **Qwen3 4B Instruct 2507** (2.9 GB), **Qwen3 1.7B** (1.4 GB), **Qwen3 0.6B** (583 MB), **Granite 4.0 350M** (583 MB, CPU) | same worker |
| Chrome's own model | **Chrome built-in AI** (Prompt API, Gemini Nano) when the browser has it | `LanguageModel` |
| Native model (later) | `NativeLLM` hook for Gemini Nano (ML Kit GenAI / AICore) or LiteRT-LM on Android, Foundation Models on iOS | host app |
| Desktop servers | Ollama, LM Studio, llama.cpp `llama-server`, Foundry Local, found automatically | existing OpenAI-compatible provider |

Every model we ship a download for is **Apache-2.0 or MIT**, so we can ship it in a paid app
without extra terms. A unit test enforces this. Models under the Gemma Terms (EmbeddingGemma 1,
Gemma 3), the Llama Community License and the LFM Open License were left out for that reason.
Gemma 4 and EmbeddingGemma 2 are Apache-2.0.

### Device tiers

`detectHardware()` reads the WebGPU adapter: whether it exists and is not a software fallback,
`shader-f16`, `maxBufferSize` and vendor/architecture. It also reads `navigator.deviceMemory`,
`hardwareConcurrency` and the OS. `recommendLocal()` then picks a tier:

| Tier | Rule | Chat | Embeddings |
|---|---|---|---|
| `gpu-large` | desktop, WebGPU with shader-f16, ≥ 8 GB memory, `maxBufferSize` ≥ 4 GB (discrete GPUs, Apple Silicon) | Qwen3 4B Instruct 2507, q4f16 | EmbeddingGemma 2 |
| `gpu` | WebGPU on a laptop or desktop, or a phone with ≥ 8 GB | Qwen3 1.7B (q4f16, or q4 without f16) | EmbeddingGemma 2 |
| `gpu-small` | WebGPU on phones with < 8 GB, and all of iOS (WebKit kills tabs far below the device's RAM) | Qwen3 0.6B | EmbeddingGemma 2 |
| `cpu` | no WebGPU for web content: WASM on the CPU | Granite 4.0 350M, q4 (none below ~3 GB) | Granite Embedding 97M int8 |

On a GPU without `shader-f16`, Inkstone uses the 4-bit build with float32 maths instead of the
half-precision one (`pickVariant`). People can choose any model their device can run, for each
role, in **Settings › AI**. Each choice shows the exact download size and licence.

### Why transformers.js

- **One runtime for both roles.** The same transformers.js worker runs encoders (embeddings) and
  decoders (chat), using WebGPU with a WASM fallback. That means one 27 MB WebAssembly file,
  shipped with the app. WebLLM is excellent for chat on WebGPU, but it has no CPU fallback and
  loads its model libraries from GitHub at run time. wllama (llama.cpp in WASM) is CPU-only in
  the browser. LiteRT-LM's web SDK (`@litert-lm/core`) mostly targets Gemma models, some of them
  gated. MediaPipe LLM Inference is now maintenance-only.
- **v4 (Feb 2026)** brought a rewritten WebGPU runtime (around 4× faster for BERT-style
  embedders), `ModelRegistry` for listing files, sizes and dtypes before downloading, and
  `env.customCache` / `env.fetch` hooks. We use the custom cache to serve models from our own
  resumable OPFS store.
- **Qwen3 and Granite 4 are trained on the `<tool_call>{json}</tool_call>` format.** That is the
  same text protocol `withPromptTools` (packages/ai/src/providers/prompt-tools.ts) already used for
  text-only providers, so tool calling works with small local models without special cases.
  Reasoning blocks (`<think>…</think>`) are hidden while streaming. Qwen3's hybrid thinking is off
  by default (`enable_thinking: false`) so answers come quickly.

We verified both code paths with real weights. EmbeddingGemma 2 loaded text-only (vision and
audio encoders removed from the config) ranks a Fourier passage first for a frequency question.
Qwen3 0.6B in Node answers a cited RAG prompt correctly. In headless Chromium, the app's worker
downloads MiniLM into OPFS, embeds every note and finds a passage with no keyword overlap (see
Testing).

## Platform availability (late 2026)

| | WebGPU for web content | Chrome Prompt API | Notes |
|---|---|---|---|
| Chrome / Edge, Windows · macOS · Linux · ChromeOS | yes (Chrome 113+) | Chrome 148+, desktop only. Gemini Nano needs ~22 GB free, 16 GB RAM and more than 4 cores, or 4 GB VRAM | Recent Chrome versions may ask the user before a site reaches local servers |
| Chrome on Android | yes since Chrome 121 (Android 12+, Adreno and Mali GPUs first) | not yet; an Android implementation on the OS model is being prototyped | |
| Android WebView (the Capacitor app) | follows Chromium, but the WebGPU launch did not promise it on every WebView. Varies by device and GPU driver | **not available** in WebView | We detect at run time and fall back to WASM. For native speed use the `NativeLLM` hook (Gemini Nano through ML Kit GenAI, or LiteRT-LM) |
| Safari 26 (macOS 26, iOS/iPadOS 26, visionOS 26) | on by default in all Safari 26 versions | no | WKWebView: verify per OS version (earlier betas exposed `navigator.gpu` without GPU access in some apps). WebKit's per-tab memory limit on iOS is why iOS uses the small tier |
| Firefox | Windows first; other platforms in progress | no | Falls back to WASM |

The WASM backend runs single-threaded unless the page is cross-origin isolated (COOP/COEP
headers). Hosting the web app with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` enables up to four threads automatically
(`numThreads`). Check that Google sign-in (a popup) still works before turning this on.

## Desktop model servers

`detectLocalServers()` probes these ports (desktop only):

| Server | Base URL | Let the web app connect |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | set `OLLAMA_ORIGINS` (e.g. `*`) and restart: `launchctl setenv` on macOS, a user environment variable on Windows, `Environment=` in the systemd unit on Linux |
| LM Studio | `http://localhost:1234/v1` | Developer › Server settings › Enable CORS |
| llama.cpp `llama-server` | `http://localhost:8080/v1` | start with `--cors "*"` |
| Foundry Local | dynamic port; we probe 5272/5273 | fix the port with `foundry service set --port 5272`. Its REST docs say nothing about CORS, so check this case by case |

A CORS refusal looks like a network error to a page. When the normal request fails but an
opaque `no-cors` request reaches the server, Inkstone knows the server is running and shows the
one setting to change. When a server is ready, **Use** adds it as an OpenAI-compatible provider
with its first model. Two new registry entries cover llama.cpp and Foundry Local.

## How it is built

```
packages/core/src/memory.ts        chunkNote (anchored passages), MemoryCorpus (BM25), vectorRank,
                                   reciprocalRankFusion, hybridSearch
packages/ai/src/local/             catalog, hardware tiers, worker protocol (LocalEngine,
                                   serveLocalEngine, LocalEngineClient), on-device provider,
                                   Chrome built-in AI provider, server detection, selection
                                   logic, RAG prompt + citation parsing, provider embeddings
packages/ai/src/tools/memory.ts    search_memory tool + #mem/ links
apps/web/src/ai/local-worker.ts    transformers.js engine (WebGPU/WASM), OPFS store, generation
apps/web/src/ai/model-files.ts     OPFS layout, status, delete (main thread safe)
apps/web/src/lib/localai.ts        device state, preferences, downloads, who answers, embedders
apps/web/src/lib/memory.ts         AppMemory: follows the keyword index, PDF text layers,
                                   background embedding, IndexedDB vectors
apps/web/src/lib/ask.ts            Ask: retrieve → numbered passages → streamed, cited answer
apps/web/src/ui/Palette.tsx        Search everything (Ctrl/⌘-K) and Ask
apps/web/src/ui/LocalAISettings.tsx, LocalAISetup.tsx
apps/web/src/platform/native-llm.ts  NativeLLM hook for the Android/iOS shells
```

**Downloads.** The worker lists the model repository from the Hugging Face API, which gives exact
sizes. It writes each file into OPFS with synchronous access handles. If the connection drops,
the next attempt sends `Range: bytes=<have>-` and continues. Before starting, it checks the
storage quota and asks for persistent storage. A manifest marks a variant complete. Status and
delete run on the main thread, so the worker only starts when a model is used. Without writable
OPFS (some private windows), transformers.js falls back to Cache Storage, and downloads in that
case do not resume. ONNX Runtime's WebAssembly is bundled with the app, not loaded from a CDN.
The CSP allows `'wasm-unsafe-eval'`. The service worker does not precache the 27 MB `.wasm`
file; it caches it the first time it is used.

**Who answers** (`chooseAssistant`):

1. With a provider configured: the provider (or whatever the person picked under *Who answers*).
2. Otherwise: Claude built into the claude.ai preview, then a ready native model, then the
   downloaded on-device model, then Chrome built-in AI.
3. If none is ready: offer the on-device download once, showing its size.

Answers always show which AI answered.

**Memory index.** Every path that updates the keyword index (editor saves, sync, imports, the
assistant, trash) also updates the passage corpus. Passages carry note id, page index, a
page-space rectangle and, for handwriting, stroke ids:

- **Typed text:** a passage per paragraph group, positioned within its text box.
- **Recognized handwriting:** per line. Line-by-line recognizers (ML Kit, the browser
  Handwriting API) now store `recognizedLines` with stroke ids and bounds (see
  VAULT_FORMAT.md). Older text is matched to the page's writing lines.
- **PDF text:** taken from pdf.js's text layer, cached in IndexedDB.
- **Title, tags and summary:** one note-level passage.

Vectors are keyed by a hash of the passage text, so editing one line re-embeds one passage. They
are stored in IndexedDB on this device only and are never synced. Embedding runs at low priority
in the worker.

**Ranking.** BM25 over passages (prefix matching; question words dropped), the existing
note-level keyword index (its hit counts as the best passage on the matching page) and cosine
similarity are fused with reciprocal rank fusion (k = 60). There are at most three passages per
note. With no embedder the vector list is simply missing and search stays keyword-based.

**Citations.** Ask numbers the passages and asks the model to cite `[n]`.
`parseAnswerCitations` turns valid numbers into buttons; numbers the model invented stay as
text. Tapping one calls `openAnchor`, which navigates to the note. The editor's
`useFocusRequests` then calls `engine.flashRegion(pageIndex, rect)`, which scrolls the region
into view and highlights it in jade for about two seconds. The assistant's `search_memory` tool
returns `#mem/<note>/<page>/<x,y,w,h>` links. A global click handler opens them from any
assistant reply.

## Next steps (researched, not built)

- **Offline handwriting transcription with a vision model.** Gemma 4 E2B (Apache-2.0, image,
  audio and text input; ONNX on Hugging Face) fits only the `gpu-large` tier: the q4f16 decoder
  alone is 1.5 GB, plus per-layer embeddings and the vision encoder. On Android, ML Kit Digital
  Ink already recognizes offline through the native plugin.
- **Speech to text** for recordings. Moonshine base (MIT; its merged decoder is 42 MB as int8
  and 73 MB as q4) or Whisper base (MIT; a 19–23 MB quantized encoder plus a 54–124 MB decoder)
  would run in the same worker. whisper-large-v3-turbo is an option for desktops.
- **Native models.** Implement `NativeLLM` in the Android shell: Gemini Nano through the ML Kit
  GenAI Prompt API on AICore devices, or LiteRT-LM for others. iOS could use Apple's Foundation
  Models.

## Testing

- `packages/core/test/memory.test.ts`: chunking and anchors (typed text, recognizer lines, line
  alignment, PDF reading order, splitting, stable hashes), BM25, incremental updates, RRF, hybrid
  ranking with and without vectors, per-note caps.
- `packages/ai/test/local.test.ts`: the worker protocol over a real `MessageChannel` with a fake
  engine (progress, streaming, cancel, errors, transferred vectors), the on-device provider
  (thinking filter, context budget, tool calls through the text protocol), hardware tiers and
  variants, licences, repository file lists, assistant and embedder selection, citation parsing,
  `#mem/` links, the Chrome provider, server detection (including CORS-blocked), provider
  embeddings.
- `apps/web/src/lib/*.test.ts`: AppMemory following the keyword index, background embedding,
  re-embedding only changed passages, Ask with anchored sources, palette actions, focus requests.
- e2e: `search.spec.ts` covers typed-text hits, the handwriting anchor flashing exactly around its
  strokes, PDF text opening on the right page, actions, Ask with a mocked provider and citation
  → note + highlight, `#mem/` links, and the download offer without AI. `search-touch.spec.ts`
  covers the library field opening the palette on phones and foldables. `local-ai.spec.ts`
  checks that the download size shows before downloading, then interrupts a download, resumes
  it with a Range request, checks OPFS, and deletes.
- **Opt-in real models.** These download the real MiniLM model into the app's worker in Chromium
  and check search by meaning. Requests are relayed through Node.

  ```
  cd apps/web
  INKSTONE_REAL_MODELS=1 PW_PORT=4181 npx playwright test e2e/local-ai.spec.ts --project desktop
  ```

  `INKSTONE_REAL_MODELS=chat` also downloads Granite 4.0 350M and answers an Ask question on the
  CPU. Large files are relayed in 64 MB slices, which also exercises download resume.

## Sources

- Hugging Face, “Transformers.js v4” (Feb 2026): https://huggingface.co/blog/transformersjs-v4
- Chromium blink-dev, “Intent to Ship: Prompt API”: https://groups.google.com/a/chromium.org/g/blink-dev/c/iR6R7-nQeHI
- Chrome for Developers, LanguageModel guide (Prompt API, Chrome 148, requirements, streaming): https://developer.chrome.com/docs/modern-web-guidance/guides/built-in-ai/language-model
- Chromium blink-dev, “Intent to Ship: WebGPU on Android”: https://groups.google.com/a/chromium.org/g/blink-dev/c/YFWuDlCKTP4
- Safari 26 WebGPU on by default on all Apple platforms: https://app.cinevva.com/news/2025-09-15-safari-webgpu and https://appdevelopermagazine.com/webgpu-in-ios-26/
- WKWebView WebGPU caveat (Apple Developer Forums): https://developer.apple.com/forums/thread/770862
- Google, LiteRT-LM for JavaScript: https://developers.google.com/edge/litert-lm/js
- MediaPipe LLM Inference maintenance mode / LiteRT-LM: https://dev.to/charleshartmann/mediapipe-llm-inference-is-maintenance-only-start-on-litert-lm-and-add-this-abi-check-48h2
- ML Kit GenAI APIs (Gemini Nano on Android): https://developers.google.com/ml-kit/genai
- EmbeddingGemma 2 ONNX model card (Apache-2.0, prefixes, text-only loading, MRL): https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
- Model repositories and licences (Hugging Face API, sizes checked Nov 2026):
  https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX, https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX,
  https://huggingface.co/onnx-community/Qwen3-4B-Instruct-2507-ONNX, https://huggingface.co/onnx-community/granite-4.0-350m-ONNX-web,
  https://huggingface.co/onnx-community/granite-4.0-1b-ONNX-web, https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX,
  https://huggingface.co/Xenova/all-MiniLM-L6-v2, https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX,
  https://huggingface.co/onnx-community/moonshine-base-ONNX, https://huggingface.co/onnx-community/whisper-base
- Browser-side small-model comparison (May 2026): https://callsphere.ai/blog/llm-comparison-browser-side-llm-webgpu-small-models-may-2026.md
- Local LLM CORS settings (Ollama `OLLAMA_ORIGINS`, LM Studio, llama.cpp `--cors`): https://pooya.blog/use-local-llm/docs/guides/cors-setup
- LM Studio server settings: https://lmstudio.ai/docs/developer/core/server/settings
- Foundry Local REST reference (dynamic port, OpenAI-compatible endpoints): https://learn.microsoft.com/en-us/azure/foundry-local/reference/reference-rest
- Foundry Local port setting: https://ravichaganti.com/blog/local-model-serving-using-foundry-local/
