# On-device AI and search everything

Most people will never paste an API key. Inkwright therefore runs its assistant, **Ask** and
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
| Speech to text (transcripts, dictation) | English: **Moonshine Base** (157 MB GPU / 67 MB CPU), **Moonshine Tiny** on CPU-only devices (32 MB); other languages: **Whisper Base** (209 / 80 MB); big GPUs: **Whisper Large v3 Turbo** (566 MB) | same worker |
| Chrome's own model | **Chrome built-in AI** (Prompt API, Gemini Nano) when the browser has it | `LanguageModel` |
| Native models (Android app) | **Gemini Nano** through ML Kit GenAI (AICore phones), its task APIs (summaries, proofreading, image descriptions), otherwise **Gemma 4 E2B** / **Qwen3 1.7B** / **Qwen3 0.6B** (Gemma 4 E4B as a choice) through LiteRT-LM on the GPU; voice through Android's on-device `SpeechRecognizer` — see [Android](#android-native-engines) | Kotlin plugin, `NativeLLM` |
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

On a GPU without `shader-f16`, Inkwright uses the 4-bit build with float32 maths instead of the
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
| Android WebView (the Capacitor app) | follows Chromium, but the WebGPU launch did not promise it on every WebView. Varies by device and GPU driver | **not available** in WebView | We detect at run time and fall back to WASM — but the app prefers its native engines (Gemini Nano through ML Kit GenAI, or LiteRT-LM), which run on the NPU/GPU directly |
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
opaque `no-cors` request reaches the server, Inkwright knows the server is running and shows the
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
packages/ai/src/speech/            VAD + windowing, WAV/resampling, timestamped segments, choosing the
                                   transcriber, summary and live-ask prompts, [m:ss] citations
packages/core/src/transcript.ts    transcript and page-summary files, time ↔ ink, page bucketing,
                                   "what was said" passages
apps/web/src/lib/listen/           capture, engines (device/browser/provider/native), live session,
                                   summaries, dictation, vault IO
apps/web/src/ui/TranscriptPanel.tsx, Dictation.tsx, SpeechSettings.tsx, PageSummaries.tsx
apps/web/src/platform/native-speech.ts  NativeSpeech hook (interface only)
apps/web/src/platform/native-llm.ts  NativeLLM registry (several engines, first ready answers),
                                   native provider, image descriptions for text-only engines
apps/web/src/ai/native/            Android bridge: NativeLLM over aiGenerate + aiDelta events,
                                   task APIs, Transcriber (16 kHz PCM), live speech sessions
apps/web/src/lib/native-ai.ts      Android status, downloads, engine/model choice, registration,
                                   summaries/proofreading through the task APIs
apps/web/src/ui/NativeAISettings.tsx  Settings rows and the assistant's offer on Android
apps/web/android/app/src/main/java/app/inkwright/ai/  the Kotlin engines (docs/ANDROID.md)
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
3. If none is ready: offer the on-device download once, showing its size. In the Android app the
   offer is Gemini Nano (an AICore download) when the phone has it, else the recommended open
   model; the WebView model is offered only when neither fits.

With `preferNative` (set when the Android shell registered native engines) a ready native engine
also wins when the person chose *This device*: it is several times faster than the same model in
the WebView. Answers always show which AI answered.

## Android: native engines

In the Android app the WebView runtime is the last resort. The plugin offers (details, wire
format and device list in docs/ANDROID.md):

| Engine | Used for | Size | Licence |
|---|---|---|---|
| Gemini Nano (ML Kit GenAI Prompt API, AICore) | assistant, Ask, skills | managed by Android, shared by all apps | Google's terms for AICore; nothing to ship |
| ML Kit summarization | the assistant's *Summarize* when Gemini Nano answers and the note language (the handwriting setting) is English, Japanese or Korean | small adapter, by Android | same |
| ML Kit proofreading | cleaning up on-device handwriting recognition (*Transcribe*, convert selection, smart read) | small adapter | same |
| ML Kit image description | describing an image attached to a question (a lasso selection) so text-only Gemini Nano can answer about it | small adapter | same |
| ML Kit rewriting | wired through the bridge (`nativeTask({ task: 'rewrite', tone })`), not yet in the UI: the free-form prompt covers rewrites today | small adapter | same |
| Gemma 4 E2B (`gemma-4-E2B-it.litertlm`) | assistant on ~8 GB+ phones without Gemini Nano | 2.59 GB | Apache-2.0 |
| Gemma 4 E4B (`gemma-4-E4B-it.litertlm`) | a choice on 12 GB+ phones | 3.66 GB | Apache-2.0 |
| Qwen3 1.7B (`Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm`) | default on 6 GB phones | 977 MB | Apache-2.0 |
| Qwen3 0.6B (`qwen3_0_6b_mixed_int4.litertlm`) | default on 4 GB phones | 498 MB | Apache-2.0 |
| Android `SpeechRecognizer` (on-device where installed) | voice input in the assistant; a `Transcriber` for recordings on Android 13+ | language packs by Android | system |

Why these:

- **Gemini Nano first.** It is already on the phone (no download of ours), runs on the NPU, and
  Google tunes the task adapters. Its limits: only the phones on Google's list (not the Razr Fold
  as of November 2026), a per-app quota (`busy`, `quota`), foreground only, and a context of a
  few thousand tokens. The bridge maps each to a plain message.
- **LiteRT-LM, not MediaPipe LLM Inference.** MediaPipe's LLM Inference API is in maintenance
  mode; LiteRT-LM is its successor, has a Kotlin API with streaming `Flow`s and cancel, runs
  `.litertlm` files on the GPU (OpenCL) or CPU, and is what litert-community publishes for. Its
  0.19 release is required by the current GPU exports, which is why the app builds with Kotlin 2.4.
- **Open models with open licences.** Same rule as the web catalog: Apache-2.0 or MIT. Gemma 3 /
  3n (Gemma Terms) and Llama 3.2 are left out; Gemma 4 is Apache-2.0. Files are pinned to a commit
  and a SHA-256, and come from huggingface.co (reachable from phones and from the build machine).
- **Speech**: Android's own recognizer, because it already ships on-device models on most phones
  and needs no download of ours; `createOnDeviceSpeechRecognizer` guarantees audio stays on the
  phone, and the UI says when only "prefer offline" is available.

Not used yet: LiteRT-LM's NPU backend (models must be compiled per chip and ship vendor
libraries), on-device embeddings through LiteRT-LM's EmbeddingGemma 2 (search keeps using the
WebView embedder), and ML Kit GenAI's speech recognition API (alpha in November 2026).

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

## Small models: answers from what you wrote

The first real-device report (a Razr Fold, Gemma 4 E2B through LiteRT-LM, Qwen3 1.7B in the
WebView, Gemini Nano through AICore) showed that wiring a small model to the same agent as a cloud
model does not work. Asked "I had written a budget, what is it for car", the reply bubble showed
`<|tool_call>call:tool_search_notes{query:{"query": "car budget"}}<tool_call|>`; asked "What's the
budget here?" on a page with "Budget Car 4000$" in handwriting, it said nothing; a lasso around
"2+2=" was sent as a picture and came back as "the Roman numeral fifteen followed by a downward
arrow". Three changes fix the class of problem, not the examples.

**1. Tool calls in every dialect** (`packages/ai/src/providers/tool-dialects.ts`). Text-only engines
get tools through the prompt, and each model family answers in the format it was trained on:

| Dialect | Written as | Models |
|---|---|---|
| `hermes` | `<tool_call>{"name": …, "arguments": {…}}</tool_call>` | Qwen2.5/3, Granite, Hermes |
| `gemma` | `<\|tool_call>call:name{key:<\|"\|>text<\|"\|>,n:3}<tool_call\|>`; FunctionGemma's `<start_function_call>…` | Gemma 4 |
| `llama` | `<\|python_tag\|>{"name": …, "parameters": {…}}`, `<function=name>{…}</function>` | Llama 3.1+ |
| `mistral` | `[TOOL_CALLS][{…}]`, `[TOOL_CALLS]name[ARGS]{…}` | Mistral |
| `json` | a bare or fenced `{name, arguments}` naming a known tool | small models off-script |
| `pythonic` | `[search_notes(query="…")]`, ` ```tool_code ` blocks | Llama 3.2, Gemma 3 |

Names models invent (`tool_search_notes`, `default_api.create_note`) map onto the real tools;
argument shapes are repaired against each tool's JSON Schema (an argument wrapped one level too
deep, a list where one string goes, `"5"` for an integer); a call that is recognised but can't be
read gets one repair retry with the exact format; and `ToolSyntaxStream` holds back anything that
is or may become tool syntax while streaming, so the person never sees it. Free-text forms (bare
JSON, Python calls) only count when they name one of the offered tools, so an answer that
contains JSON stays an answer. LiteRT-LM 0.19's Kotlin API also exposes structured function
calling (`ConversationConfig(tools = …, automaticToolCalling = false)`, `Message.toolCalls`,
`Content.ToolResponse`); using it is the next step for Gemma on Android (see Next steps).

**2. Retrieval first for on-device engines** (`packages/ai/src/local/grounding.ts`,
`grounded-agent.ts`, `apps/web/src/lib/assistant/context.ts`). When an on-device engine answers
(`isSmallModel`: the phone's engines, the WebView model, Chrome's model), the app gathers the
context *before* generation, deterministically:

- the page on screen: its handwriting is recognized on the device right then if it has no text
  yet, or has ink newer than its text (`ensurePageRecognized`; ML Kit Digital Ink on Android, the
  Handwriting Recognition API where the browser has it), and stored on the page for everything else;
- a lasso selection, as text: the recognized lines of its strokes, or the strokes recognized on
  their own right away (`selectionText`);
- other pages of the note that share words with the question, and the best passages from every
  note the AI may read (the memory index's hybrid search);
- the memory items that matter: standing instructions always, facts that share a word with the
  question.

They go into the user turn as numbered sources (`[2] "Budget", page 1 (the page you are on):`),
sized to the engine's context window (`contextBudget`), with a short system prompt that says
"here" means the page on screen, sums written in the context are to be worked out, and the model
must never ask for more context when the context has text. Tools stay for actions, cut to the
three to seven a model of that size handles (`compactTools`: create_note, append_to_note,
search_memory, …) with one-sentence descriptions; a request that is clearly an action ("make a new
note…", "add a to-do…") requires a tool call on the first turn. Cloud models keep the full agent;
the page is still recognized first, so they read text too.

**Pictures only for models that can read them.** `sendsImagesTo` is true only for vision models
that are not on-device engines. The lasso's "Ask AI" and "Write the answer here" send the recognized
text to everyone and a picture only to strong vision models; when nothing could read the
handwriting and no such model is set up, the person is told so instead of getting a guess.

**3. Guardrails.** A reply that dodges ("please provide more context", "I can't see") or is empty
while the context has text gets one nudge without tools; if that fails too, the best-matching line
of the notes is quoted and cited ("Here is what your notes say: “Budget Car 4000$” [1]"). With no
relevant text at all the reply says so plainly and says what to do (transcribe the page, try other
words). An action that wasn't carried out is reported as not done, never described as done.

**Conversations.** Every engine gets the earlier turns of the chat: small models a condensed
history (plain text of the last four to eight turns, tool transcripts dropped), cloud models the
full transcript. Chats are kept per note and as general threads in IndexedDB on this device
(`lib/assistant/chats.ts`; not synced, because they can quote local-only notes), reopened when the
panel opens, and listed under the panel's Chats button with New chat.

**Study from real sentences.** Recognized handwriting is judged by `textQuality` (core): lines of
symbol soup are left out of compiler units and of the text given to quick actions, and study cards
and teach-back questions only use recognized sentences with at least three real words
(`studyUnits`), so a fragment like "ools" never becomes a question.

**Settings › AI on Android.** AICore reports its own restarts as errors ("[ErrorCode 6] … 1-DOWNLOAD_ERROR
… 6-IPC_ERROR: AICore service disconnected") while it is still installing Gemini Nano. The Kotlin
bridge gives those the code `service` (`GenAiErrors.fromDetail`); the app retries them with backoff
(3 s, 8 s, 20 s, 45 s, 90 s), stands down when Android reports the model downloading or ready, and
shows "Retrying automatically…" in a calm tone, with the raw text only under Details
(`lib/assistant/download-status.ts`). Every download button in Settings › AI (Gemini Nano, the
writing tools, open models on the phone, models in the browser) is one `DownloadButton`: Download,
then "Downloading… 68%" with Cancel, then Ready.

### Real-model evals

`npm run eval:local` runs a real small model on the CPU with the app's own engine code
(`packages/ai/evals/node-engine.ts`: the worker's transformers.js calls in Node) through the cases
that failed on the phone and a few more, twice: the assistant as it was before these changes
(`before`: full agent, page handwriting not recognized before asking, lasso as a picture,
Hermes-only parser) and as it is now (`after`).

```
npm run eval:local -- --model qwen3-1.7b --context 4096 --json results.json --resume
INKWRIGHT_REAL_MODELS=assistant npx vitest run --project evals packages/ai/evals/local-model.eval.ts   # Qwen3 0.6B inside vitest
```

Weights download once from Hugging Face into `INKWRIGHT_MODEL_CACHE` (default: the OS temp folder),
never into the repository. CI skips them unless `INKWRIGHT_REAL_MODELS` is set. Two things make
them fit an 8 GB machine: the prompt is fed in 256-token chunks through the KV cache (these ONNX
exports compute logits for every prompt position — 1.8 GB for a 3,000-token prompt with Qwen's
152k vocabulary — which is also why short, retrieval-first prompts matter on phones), and ONNX
Runtime runs without its CPU arena and weight prepacking (Qwen3 1.7B: 2.8 GB instead of 4.1 GB).

Results are recorded below once a run completes.

## Speech to text: notes that listen

Recordings get a live transcript lined up with the ink, questions can be asked while a lecture is
happening, and each page gets a summary. By default all of it runs on the device.

### What we evaluated (November 2026)

transformers.js 4.3.2 runs these speech architectures: `whisper`, `moonshine`, `cohere_asr`,
`granite_speech` and `voxtral_realtime`. Candidates, with licences from their model cards:

| Model | Licence | Size in the browser | Verdict |
|---|---|---|---|
| **Moonshine Tiny / Base** (Useful Sensors) | MIT | 32 / 67 MB (int8, CPU); 79 / 157 MB (fp32 encoder + 4-bit decoder, GPU) | **Chosen for English.** Compute grows with the audio's length instead of padding every call to 30 s like Whisper, so short live windows are cheap even on a phone's CPU. English only. |
| **Whisper Base** (OpenAI) | Apache-2.0 | 80 MB (int8, CPU); 209 MB (GPU) | **Chosen for other languages.** ~100 languages and its own timestamps. |
| **Whisper Large v3 Turbo** | MIT | 566 MB (q4f16) / 762 MB (q4) | **Chosen for `gpu-large`.** Most accurate model that runs in a browser tab. |
| Distil-Whisper small.en | MIT | ~170 MB | Not chosen: English only and slower than Moonshine Base at similar accuracy. |
| Moonshine Streaming tiny/small/medium | MIT | — | The best fit for live captions, but transformers.js 4.3.2 has no `moonshine_streaming` model type. Next step when it does. |
| Cohere Transcribe (03-2026) | Apache-2.0 | encoder alone 1.4 GB (q4f16) | Too large for live use in a tab. |
| Granite 4.0 1B Speech, Voxtral Mini 4B Realtime | Apache-2.0 | 1–4 B parameters | Too large for live use beside a chat model. |
| Nemotron ASR streaming 0.6B | NVIDIA open model licence | — | Licence is not MIT/Apache; NeMo format, not transformers.js. |
| Moonshine in other languages (ja, ko, zh, ar, uk, vi…) | not stated in the ONNX repositories' metadata | — | Left out until the licence is clear. |

Defaults (`recommendAsr`): English speech gets Moonshine Tiny on CPU-only devices and Moonshine Base
with a GPU; other languages get Whisper Base; `gpu-large` devices get Whisper Large v3 Turbo. The
person can pick any runnable model, and the speech language, in **Settings › AI › Speech to text**.

### Who transcribes

`chooseTranscriber` (packages/ai/src/speech/select.ts):

1. **On this device** once the speech model is downloaded (or the phone's own on-device
   recognizer, through the `NativeSpeech` hook in `platform/native-speech.ts` — an interface only;
   the Android shell can implement it with `SpeechRecognizer.createOnDeviceSpeechRecognizer`).
2. Otherwise the **browser's live captions** (Web Speech API; most browsers send the audio to their
   maker).
3. Otherwise the **AI provider's** transcription endpoint (OpenAI, Groq, Gemini, custom).
4. Otherwise offer the on-device download, showing its size.

Choosing "This device" never falls back to the browser or a provider. Every transcript, the
dictation bar and Settings show where the audio is processed (on this device / browser speech
service / sent to a provider), and the transcript file records it (`where`).

### How it works

- **Capture.** While the clip records (MediaRecorder, unchanged), an AudioWorklet taps the same
  microphone stream for 16 kHz mono PCM (`lib/listen/capture.ts`; resampled when the context can't
  run at 16 kHz).
- **Windows.** `AudioWindower` (packages/ai/src/speech/audio.ts) runs an energy VAD with an
  adaptive noise floor and hangover. It cuts at the first pause (≥ 600 ms) once a window is 10 s
  long, or at the quietest moment once it reaches 28 s (under Whisper's 30 s context), trims each
  window to its speech and drops windows with no speech, so silence is never transcribed (Whisper
  invents text for silence). Times are exact sample positions from the start of the recording.
- **Transcription.** Each window goes to the worker's `transcribe` method (the
  automatic-speech-recognition pipeline, per-file dtypes such as an fp32 encoder with a 4-bit
  decoder) or, as WAV, to the provider. Whisper's own timestamps are used; for plain text
  (Moonshine, providers) sentences are laid over the window's speech regions in proportion to their
  length (`windowSegments`).
- **Alignment.** Segment times are relative to the clip's `startedAt`, and strokes carry their
  wall-clock `createdAt`, so the ink written during a sentence (plus 1.5 s of writing lag) is plain
  time arithmetic (`inkForSegment`, `segmentAtTime` in packages/core/src/transcript.ts). Tapping a
  sentence highlights those strokes (the rest dims) and plays the audio from there; with the
  transcript open, tapping ink finds the sentence.
- **Storage and search.** The transcript is saved next to the clip
  (`assets/<clipId>.transcript.json`, docs/VAULT_FORMAT.md) and merged by sync. The memory index
  turns it into "what was said" passages, anchored to the page and the ink written then, with the
  recording and time; a search result or Ask citation opens the note, seeks the audio and
  highlights that ink. The assistant's `search_memory` links carry the moment (`#mem/…@<clip>:<ms>`).
- **Asking during a recording.** The AI panel adds the live transcript so far (newest kept when
  long), the elapsed time and the current page to the assistant's context and asks for `[m:ss]`
  citations; only times that match a real segment become links (`linkStampCitations`).
- **Summaries.** When a recording ends (and on demand from the transcript or Pages panel), each page
  the recording covered gets a summary from the segments assigned to it (`bucketSegmentsByPage`)
  plus its text, and the recording gets a summary with key terms and to-dos. They use the
  assistant's AI (on the device unless a provider was chosen) and appear in Pages, optionally as a
  text note on the page. "When a recording ends" routines start after the transcript and summaries
  are saved and receive them in their context.
- **Dictation.** ••• › Audio › Dictate puts speech on the page as a text box; the mic in the text editor's
  toolbar inserts at the caret. Same engines, shorter windows; no audio is kept.

## Next steps (researched, not built)

- **Offline handwriting transcription with a vision model.** Gemma 4 E2B (Apache-2.0, image,
  audio and text input; ONNX on Hugging Face) fits only the `gpu-large` tier: the q4f16 decoder
  alone is 1.5 GB, plus per-layer embeddings and the vision encoder. On Android, ML Kit Digital
  Ink already recognizes offline through the native plugin.
- **Streaming speech models.** Moonshine Streaming (MIT) would give word-by-word on-device
  captions instead of a line every pause, once transformers.js supports `moonshine_streaming`.
- **iOS native model.** Implement `NativeLLM` in the iOS shell with Apple's Foundation Models
  (the Android engines are built; see above).
- **LiteRT-LM structured function calling for Gemma.** LiteRT-LM 0.19 (the version the app
  ships) has it in Kotlin: an `OpenApiTool` per tool (its JSON description and an `execute` that
  is never called), `ConversationConfig(tools = listOf(tool(…)), automaticToolCalling = false)`,
  the calls in `Message.toolCalls` (name and argument map), results back as
  `Message.tool(Contents.of(Content.ToolResponse(name, json)))`. Wiring it means sending the tool
  schemas over `aiGenerate` and returning calls beside the text; until it is built and checked on
  a phone, Gemma's text syntax is parsed by `tool-dialects.ts`, which is what the phone produced.
- **Chunked prefill in the WebView worker.** The eval engine's chunked prefill (see Real-model
  evals) would let the in-app worker take long prompts on phones without the logits spike.

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
- `packages/ai/test/tool-dialects.test.ts`: every tool-call dialect from real transcripts (the
  phone's Gemma output verbatim), name and argument repair, streaming that never shows syntax,
  the repair retry. `grounding.test.ts`: sources and budgets, memory picks, action detection,
  dodges, extractive answers, condensed history, compact tools, and grounded turns end to end
  with a scripted model (nudge, quote, not found, follow-ups, a required tool call in Gemma syntax).
- `packages/core/test/textquality.test.ts`: readable lines and study-worthy sentences.
- `apps/web/src/lib/assistant/assistant.test.ts`: download copy and button states, AICore retries
  with backoff against a fake plugin (success, Android carrying on, cancel, a real failure),
  chats persisting in IndexedDB, recognizing the page and a selection before asking, which models
  get pictures.
- e2e `assistant-local.spec.ts`: a scripted phone model emitting Gemma- and Qwen-style calls (run,
  never shown), retrieval first with handwriting recognized before asking, a dodge replaced by the
  page's words, chats surviving a reload with history sent to the model, New chat and past chats,
  AICore's IPC error retried calmly with the raw text under Details, and download buttons that say
  "Downloading… n%" then Ready.
- `apps/web/src/lib/*.test.ts`: AppMemory following the keyword index, background embedding,
  re-embedding only changed passages, Ask with anchored sources, palette actions, focus requests.
- e2e: `search.spec.ts` covers typed-text hits, the handwriting anchor flashing exactly around its
  strokes, PDF text opening on the right page, actions, Ask with a mocked provider and citation
  → note + highlight, `#mem/` links, and the download offer without AI. `search-touch.spec.ts`
  covers the library field opening the palette on phones and foldables. `local-ai.spec.ts`
  checks that the download size shows before downloading, then interrupts a download, resumes
  it with a Range request, checks OPFS, and deletes.
- Android native engines: JVM tests in `apps/web/android/app/src/test/java/app/inkwright/ai/`
  (status and AICore error mapping pinned to ML Kit's constants, prompt building and trimming,
  stream assembly, resumable-download bookkeeping, the pinned catalog and memory-based
  recommendation, task options, speech transcript assembly); `apps/web/src/ai/native/bridge.test.ts`
  (streaming, cancel, error codes, transcriber, live sessions, PCM) and
  `apps/web/src/lib/native-ai.test.ts` (registration order, engine/model choice, `pickAssistant`
  preferring native, downloads, summaries/proofreading/image descriptions) against a fake plugin;
  e2e `native-ai.spec.ts` drives Settings and the assistant with a scripted plugin (size prompt,
  progress, answer streamed from the phone; summaries through the task API). What needs a real
  phone is listed in docs/ANDROID.md.
- **Opt-in real models.** These download the real MiniLM model into the app's worker in Chromium
  and check search by meaning. Requests are relayed through Node.

  ```
  cd apps/web
  INKWRIGHT_REAL_MODELS=1 PW_PORT=4181 npx playwright test e2e/local-ai.spec.ts --project desktop
  ```

  `INKWRIGHT_REAL_MODELS=chat` also downloads Granite 4.0 350M and answers an Ask question on the
  CPU. Large files are relayed in 16 MB slices, which also exercises download resume.
  `INKWRIGHT_REAL_MODELS=1 npx vitest run --project ai packages/ai/test/local-models.live.test.ts`
  checks every catalog size against the live repositories.

  Results on the development machine (Nov 2026):
  - The embedding test passes, including resume across relay slices.
  - The catalog check passes for all eight models.
  - The chat test downloaded about 350 MB, then the headless page was killed by the sandbox's
    memory limit (8 GB shared with other builds). Generation itself is verified with the same
    transformers.js calls in Node: Qwen3 0.6B, `enable_thinking: false`, streaming. Run the chat
    test on a machine with more memory.

### Speech tests

- `packages/core/test/transcript.test.ts`: file format, time ↔ ink (writing lag, sentence at a
  moment, clip at a moment), page bucketing rules, speech passages and their memory chunks.
- `packages/ai/test/speech.test.ts`: VAD, windowing (pauses, maximum length, silence dropped, exact
  times, live vs whole-file), resampling, WAV, sentence splitting and spreading over speech, Whisper
  timestamps, transcriber choice, catalog and tier defaults, prompts, `[m:ss]` citations, links.
  `speech-worker.test.ts`: the worker protocol with a fake speech model (transfer, cancel, a whole
  recording becoming segments on the recording's clock).
- `packages/sync/test/listen-merge.test.ts`: transcript and page-summary merges, also through the
  sync engine with two devices.
- `apps/web/src/lib/listen/listen.test.ts`: speech passages in search and Ask with their anchors,
  page and lecture summaries with a scripted AI, routine context, live Ask context and citation
  links, dictation insertion, engine resolution.
- e2e `listen.spec.ts`: Chromium's fake microphone plays a generated speech-like WAV; the
  transcription endpoint is mocked. Lines appear while recording, lined up with the strokes written
  during them; Ask during the recording gets the live transcript and cites it; after stopping, the
  lecture summary and page summaries appear; tapping a sentence highlights its strokes and plays
  from there; tapping ink finds the sentence; search finds what was said and opens that moment;
  dictation on the page and at the caret; "This device" offers the download and uploads nothing.
- **Opt-in real models** (`INKWRIGHT_REAL_MODELS=1` or `=asr`):
  `npx vitest run --project ai packages/ai/test/speech-models.live.test.ts` runs Moonshine Tiny and
  Whisper Base in Node on a public-domain clip (JFK's inaugural address) cut by our windowing, and
  `PW_PORT=4181 npx playwright test e2e/listen-real.spec.ts --project desktop` downloads Moonshine
  Tiny into the app's worker and transcribes the clip live from the fake microphone.
  Results on the development machine (Nov 2026): both pass. Node: Moonshine Tiny "And so my fellow
  Americans ask not what your country can do for you, ask what you can do for your country."
  (5 s); Whisper Base the same with its own timestamps (14 s). In Chromium, Moonshine Tiny on the
  CPU produced the live lines "And so my fellow America asked not." (0:00) and "What your country
  can do for you, ask what you can do for your country." (0:05) with no audio uploaded. Whisper
  Large v3 Turbo was not run here (566 MB is above this sandbox's browser memory limit); its
  catalog entry is checked against the live repository.

## Sources

- Hugging Face, “Transformers.js v4” (Feb 2026): https://huggingface.co/blog/transformersjs-v4
- Chromium blink-dev, “Intent to Ship: Prompt API”: https://groups.google.com/a/chromium.org/g/blink-dev/c/iR6R7-nQeHI
- Chrome for Developers, LanguageModel guide (Prompt API, Chrome 148, requirements, streaming): https://developer.chrome.com/docs/modern-web-guidance/guides/built-in-ai/language-model
- Chromium blink-dev, “Intent to Ship: WebGPU on Android”: https://groups.google.com/a/chromium.org/g/blink-dev/c/YFWuDlCKTP4
- Safari 26 WebGPU on by default on all Apple platforms: https://app.cinevva.com/news/2025-09-15-safari-webgpu and https://appdevelopermagazine.com/webgpu-in-ios-26/
- WKWebView WebGPU caveat (Apple Developer Forums): https://developer.apple.com/forums/thread/770862
- Google, LiteRT-LM for JavaScript: https://developers.google.com/edge/litert-lm/js
- MediaPipe LLM Inference maintenance mode / LiteRT-LM: https://dev.to/charleshartmann/mediapipe-llm-inference-is-maintenance-only-start-on-litert-lm-and-add-this-abi-check-48h2
- ML Kit GenAI APIs (Gemini Nano on Android; device list, quotas, foreground rule): https://developers.google.com/ml-kit/genai
- Gemini Nano on Android: https://developer.android.com/ai/gemini-nano
- ML Kit GenAI and LiteRT-LM artifacts and their Kotlin metadata versions: Google Maven (`com.google.mlkit:genai-*`, `com.google.ai.edge.litertlm:litertlm-android`), checked Nov 2026
- LiteRT-LM model cards (sizes, runtime versions, benchmarks, licences): https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm, https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm, https://huggingface.co/litert-community/Qwen3-1.7B, https://huggingface.co/litert-community/Qwen3-0.6B
- Razr Fold specifications (Snapdragon 8 Gen 5, 16 GB): https://www.techspot.com/news/111525-motorola-razr-fold-debuts-snapdragon-8-gen-5.html
- Android `SpeechRecognizer` (on-device recognizer, `EXTRA_AUDIO_SOURCE`, segmented sessions): https://developer.android.com/reference/android/speech/SpeechRecognizer
- EmbeddingGemma 2 ONNX model card (Apache-2.0, prefixes, text-only loading, MRL): https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
- Model repositories and licences (Hugging Face API, sizes checked Nov 2026):
  https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX, https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX,
  https://huggingface.co/onnx-community/Qwen3-4B-Instruct-2507-ONNX, https://huggingface.co/onnx-community/granite-4.0-350m-ONNX-web,
  https://huggingface.co/onnx-community/granite-4.0-1b-ONNX-web, https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX,
  https://huggingface.co/Xenova/all-MiniLM-L6-v2, https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX,
  https://huggingface.co/onnx-community/moonshine-base-ONNX, https://huggingface.co/onnx-community/whisper-base
- Moonshine model cards (MIT): https://huggingface.co/UsefulSensors/moonshine-tiny, https://huggingface.co/UsefulSensors/moonshine-base;
  ONNX builds: https://huggingface.co/onnx-community/moonshine-tiny-ONNX, https://huggingface.co/onnx-community/moonshine-base-ONNX
- Whisper model cards: https://huggingface.co/openai/whisper-base (Apache-2.0), https://huggingface.co/openai/whisper-large-v3-turbo (MIT);
  ONNX builds: https://huggingface.co/onnx-community/whisper-base, https://huggingface.co/onnx-community/whisper-large-v3-turbo
- Moonshine Streaming (MIT): https://huggingface.co/moonshine-ai/moonshine-streaming-tiny
- Cohere Transcribe 03-2026 (Apache-2.0, ONNX sizes): https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX
- Distil-Whisper small.en (MIT): https://huggingface.co/distil-whisper/distil-small.en
- Granite 4.0 1B Speech: https://huggingface.co/onnx-community/granite-4.0-1b-speech-ONNX; Voxtral Mini 4B Realtime: https://huggingface.co/onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX
- Nemotron ASR streaming licence: https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b
- Moonshine web demo (transformers.js, in-browser): https://huggingface.co/spaces/webml-community/moonshine-web
- Browser-side small-model comparison (May 2026): https://callsphere.ai/blog/llm-comparison-browser-side-llm-webgpu-small-models-may-2026.md
- Local LLM CORS settings (Ollama `OLLAMA_ORIGINS`, LM Studio, llama.cpp `--cors`): https://pooya.blog/use-local-llm/docs/guides/cors-setup
- LM Studio server settings: https://lmstudio.ai/docs/developer/core/server/settings
- Foundry Local REST reference (dynamic port, OpenAI-compatible endpoints): https://learn.microsoft.com/en-us/azure/foundry-local/reference/reference-rest
- Foundry Local port setting: https://ravichaganti.com/blog/local-model-serving-using-foundry-local/
