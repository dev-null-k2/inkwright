/**
 * On-device models Inkstone can download and run in the browser / WebView with transformers.js
 * (ONNX Runtime Web, WebGPU with a WASM fallback). Chosen for docs/LOCAL_AI.md: every model here
 * has a licence that allows shipping in a commercial app (Apache-2.0 or MIT), an ONNX build
 * published on Hugging Face, and a size that suits its device tier. Sizes are the exact bytes of
 * the files downloaded for each variant (checked against the Hugging Face API in Nov 2026); the
 * downloader re-reads them live and shows those.
 */

/** `asr`: speech to text (recordings, live transcripts, dictation). */
export type LocalModelRole = 'chat' | 'embed' | 'asr';
export type LocalDevice = 'webgpu' | 'wasm';

/** How the worker loads a model with transformers.js. */
export type LocalLoader =
  /** AutoTokenizer + AutoModelForCausalLM, chat template, streamed generation. */
  | 'causal-lm'
  /** The feature-extraction pipeline (BERT-style encoders). */
  | 'feature-extraction'
  /** A multimodal embedding model loaded text-only (vision/audio encoders left out of the config). */
  | 'text-embedding-multimodal'
  /** The automatic-speech-recognition pipeline (encoder–decoder: Whisper, Moonshine). */
  | 'speech-to-text';

export interface LocalModelVariant {
  device: LocalDevice;
  /** transformers.js dtype: q4f16 needs the WebGPU `shader-f16` feature. */
  dtype: 'q4f16' | 'q4' | 'int8' | 'quantized' | 'fp16' | 'fp32';
  /** Total download in bytes (model + tokenizer + config). */
  bytes: number;
  /**
   * Per-ONNX-file dtypes for encoder–decoder models (`onnxModules`), e.g. a full-precision audio
   * encoder with a 4-bit decoder, as transformers.js recommends for Whisper on WebGPU. Modules not
   * listed use `dtype`, which also names the variant.
   */
  moduleDtypes?: Readonly<Record<string, LocalModelVariant['dtype']>>;
}

export interface LocalAsrConfig {
  family: 'whisper' | 'moonshine';
  /** The model returns its own timestamps within a window (Whisper). */
  timestamps: boolean;
  /** Longest audio it takes in one call, ms (Whisper's 30 s context). */
  maxWindowMs: number;
}

export interface LocalEmbeddingConfig {
  /** Output size after optional Matryoshka truncation. */
  dims: number;
  /** Truncate to `dims` and re-normalize (Matryoshka models). */
  truncate?: boolean;
  pooling: 'mean' | 'cls';
  /** Turns a search query into the model's expected input. */
  query: (q: string) => string;
  /** Turns a passage (and its note title) into the model's expected input. */
  document: (text: string, title?: string) => string;
}

export interface LocalModelSpec {
  id: string;
  role: LocalModelRole;
  label: string;
  /** Hugging Face repository with the ONNX weights. */
  repo: string;
  /** File base name inside `onnx/` (model, decoder_model_merged, …). */
  onnxBase: string;
  /** Several ONNX files (encoder–decoder models); `onnxBase` is then the first of them. */
  onnxModules?: readonly string[];
  loader: LocalLoader;
  licence: string;
  licenceUrl: string;
  /** One line for settings: what it is good at. */
  blurb: string;
  /** Parameter count for display. */
  params: string;
  languages: 'multilingual' | 'english';
  variants: LocalModelVariant[];
  /** Chat models: context length we budget prompts against (tokens). */
  contextTokens?: number;
  /** Chat models: the chat template takes `enable_thinking` (Qwen3 hybrid thinking). */
  thinkingToggle?: boolean;
  embed?: LocalEmbeddingConfig;
  asr?: LocalAsrConfig;
}

const egQuery = (q: string) => `task: search result | query: ${q}`;
const egDoc = (t: string, title?: string) => `title: ${title?.trim() || 'none'} | text: ${t}`;
const plain = (s: string) => s;

export const LOCAL_MODELS: readonly LocalModelSpec[] = [
  // ---- Embeddings -------------------------------------------------------------------------------
  {
    id: 'embeddinggemma-2', role: 'embed', label: 'EmbeddingGemma 2', repo: 'onnx-community/embeddinggemma-2-ONNX', onnxBase: 'model',
    loader: 'text-embedding-multimodal', licence: 'Apache-2.0', licenceUrl: 'https://ai.google.dev/gemma/docs/gemma_4_license',
    blurb: 'Best small search model: 100+ languages, long passages.', params: '270M (text)', languages: 'multilingual',
    variants: [{ device: 'webgpu', dtype: 'q4f16', bytes: 189_539_831 }, { device: 'wasm', dtype: 'q4', bytes: 206_701_611 }],
    embed: { dims: 256, truncate: true, pooling: 'mean', query: egQuery, document: egDoc },
  },
  {
    id: 'granite-embedding-97m', role: 'embed', label: 'Granite Embedding 97M', repo: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX', onnxBase: 'model',
    loader: 'feature-extraction', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    blurb: 'Light and multilingual; good on older phones.', params: '97M', languages: 'multilingual',
    variants: [{ device: 'webgpu', dtype: 'int8', bytes: 123_174_716 }, { device: 'wasm', dtype: 'int8', bytes: 123_174_716 }],
    embed: { dims: 384, pooling: 'cls', query: plain, document: (t, title) => (title ? `${title}\n${t}` : t) },
  },
  {
    id: 'minilm-l6', role: 'embed', label: 'MiniLM L6', repo: 'Xenova/all-MiniLM-L6-v2', onnxBase: 'model',
    loader: 'feature-extraction', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    blurb: 'Tiny and fast, English only.', params: '23M', languages: 'english',
    variants: [{ device: 'webgpu', dtype: 'quantized', bytes: 23_916_680 }, { device: 'wasm', dtype: 'quantized', bytes: 23_916_680 }],
    embed: { dims: 384, pooling: 'mean', query: plain, document: (t, title) => (title ? `${title}\n${t}` : t) },
  },
  // ---- Chat -------------------------------------------------------------------------------------
  {
    id: 'qwen3-4b-2507', role: 'chat', label: 'Qwen3 4B Instruct', repo: 'onnx-community/Qwen3-4B-Instruct-2507-ONNX', onnxBase: 'model',
    loader: 'causal-lm', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    blurb: 'Most capable; for computers with a good GPU and 16 GB of memory.', params: '4B', languages: 'multilingual', contextTokens: 8192,
    variants: [{ device: 'webgpu', dtype: 'q4f16', bytes: 2_898_698_557 }],
  },
  {
    id: 'qwen3-1.7b', role: 'chat', label: 'Qwen3 1.7B', repo: 'onnx-community/Qwen3-1.7B-ONNX', onnxBase: 'model',
    loader: 'causal-lm', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    blurb: 'Balanced: good answers about your notes on most laptops and recent phones.', params: '1.7B', languages: 'multilingual', contextTokens: 8192, thinkingToggle: true,
    variants: [{ device: 'webgpu', dtype: 'q4f16', bytes: 1_439_651_791 }, { device: 'wasm', dtype: 'q4', bytes: 2_160_795_554 }],
  },
  {
    id: 'qwen3-0.6b', role: 'chat', label: 'Qwen3 0.6B', repo: 'onnx-community/Qwen3-0.6B-ONNX', onnxBase: 'model',
    loader: 'causal-lm', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    blurb: 'Small and quick; short answers.', params: '0.6B', languages: 'multilingual', contextTokens: 8192, thinkingToggle: true,
    variants: [{ device: 'webgpu', dtype: 'q4f16', bytes: 583_372_412 }, { device: 'wasm', dtype: 'q4', bytes: 932_679_247 }],
  },
  {
    id: 'granite-4.0-1b', role: 'chat', label: 'Granite 4.0 1B', repo: 'onnx-community/granite-4.0-1b-ONNX-web', onnxBase: 'model',
    loader: 'causal-lm', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    blurb: 'Trained for grounded answers and tool use.', params: '1B', languages: 'multilingual', contextTokens: 8192,
    variants: [{ device: 'webgpu', dtype: 'q4f16', bytes: 1_254_174_750 }, { device: 'wasm', dtype: 'q4', bytes: 1_788_229_921 }],
  },
  {
    id: 'granite-4.0-350m', role: 'chat', label: 'Granite 4.0 350M', repo: 'onnx-community/granite-4.0-350m-ONNX-web', onnxBase: 'model',
    loader: 'causal-lm', licence: 'Apache-2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    blurb: 'Smallest; runs on the CPU of almost any device.', params: '350M', languages: 'multilingual', contextTokens: 4096,
    variants: [{ device: 'webgpu', dtype: 'q4f16', bytes: 357_179_055 }, { device: 'wasm', dtype: 'q4', bytes: 582_606_856 }],
  },
  // ---- Speech to text ----------------------------------------------------------------------------
  // Moonshine (Useful Sensors, MIT; English) computes in proportion to the audio's length instead of
  // padding every window to 30 s like Whisper, so it is the fastest choice for live English
  // transcripts. Whisper (OpenAI, Apache-2.0 / MIT) covers ~100 languages and returns timestamps.
  {
    id: 'moonshine-tiny', role: 'asr', label: 'Moonshine Tiny', repo: 'onnx-community/moonshine-tiny-ONNX', onnxBase: 'encoder_model', onnxModules: ['encoder_model', 'decoder_model_merged'],
    loader: 'speech-to-text', licence: 'MIT', licenceUrl: 'https://huggingface.co/UsefulSensors/moonshine-tiny',
    blurb: 'Fast English transcripts on any device.', params: '27M', languages: 'english',
    variants: [
      { device: 'webgpu', dtype: 'q4', moduleDtypes: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, bytes: 79_431_703 },
      { device: 'wasm', dtype: 'quantized', bytes: 32_079_635 },
    ],
    asr: { family: 'moonshine', timestamps: false, maxWindowMs: 30_000 },
  },
  {
    id: 'moonshine-base', role: 'asr', label: 'Moonshine Base', repo: 'onnx-community/moonshine-base-ONNX', onnxBase: 'encoder_model', onnxModules: ['encoder_model', 'decoder_model_merged'],
    loader: 'speech-to-text', licence: 'MIT', licenceUrl: 'https://huggingface.co/UsefulSensors/moonshine-base',
    blurb: 'More accurate English transcripts; still light.', params: '61M', languages: 'english',
    variants: [
      { device: 'webgpu', dtype: 'q4', moduleDtypes: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, bytes: 157_499_298 },
      { device: 'wasm', dtype: 'quantized', bytes: 66_910_622 },
    ],
    asr: { family: 'moonshine', timestamps: false, maxWindowMs: 30_000 },
  },
  {
    id: 'whisper-base', role: 'asr', label: 'Whisper Base', repo: 'onnx-community/whisper-base', onnxBase: 'encoder_model', onnxModules: ['encoder_model', 'decoder_model_merged'],
    loader: 'speech-to-text', licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/openai/whisper-base',
    blurb: 'Transcribes about 100 languages, with timestamps.', params: '74M', languages: 'multilingual',
    variants: [
      { device: 'webgpu', dtype: 'q4', moduleDtypes: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, bytes: 208_876_857 },
      { device: 'wasm', dtype: 'quantized', bytes: 79_700_989 },
    ],
    asr: { family: 'whisper', timestamps: true, maxWindowMs: 30_000 },
  },
  {
    id: 'whisper-large-v3-turbo', role: 'asr', label: 'Whisper Large v3 Turbo', repo: 'onnx-community/whisper-large-v3-turbo', onnxBase: 'encoder_model', onnxModules: ['encoder_model', 'decoder_model_merged'],
    loader: 'speech-to-text', licence: 'MIT', licenceUrl: 'https://huggingface.co/openai/whisper-large-v3-turbo',
    blurb: 'Most accurate, any language; for computers with a good GPU.', params: '809M', languages: 'multilingual',
    variants: [
      { device: 'webgpu', dtype: 'q4f16', bytes: 566_284_958 },
      { device: 'webgpu', dtype: 'q4', bytes: 761_895_860 },
    ],
    asr: { family: 'whisper', timestamps: true, maxWindowMs: 30_000 },
  },
];

export function getLocalModel(id: string | null | undefined): LocalModelSpec | undefined {
  return id ? LOCAL_MODELS.find((m) => m.id === id) : undefined;
}

export function localModelsFor(role: LocalModelRole): LocalModelSpec[] {
  return LOCAL_MODELS.filter((m) => m.role === role);
}

/** Root files a variant needs besides its ONNX weights (when the repository has them). */
export const MODEL_SIDE_FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'special_tokens_map.json', 'added_tokens.json', 'preprocessor_config.json'] as const;

const DTYPE_SUFFIX: Record<LocalModelVariant['dtype'], string> = { fp32: '', fp16: '_fp16', q4f16: '_q4f16', q4: '_q4', int8: '_int8', quantized: '_quantized' };

export interface RepoFile {
  path: string;
  size: number;
}

/**
 * The files to download for a variant, from a repository listing (`/api/models/<repo>/tree`):
 * the ONNX graph, its external-data shards, and the tokenizer/config side files present.
 */
export function variantFiles(spec: LocalModelSpec, variant: LocalModelVariant, tree: readonly RepoFile[]): RepoFile[] {
  const weights: RepoFile[] = [];
  for (const module of spec.onnxModules ?? [spec.onnxBase]) {
    const base = `onnx/${module}${DTYPE_SUFFIX[variant.moduleDtypes?.[module] ?? variant.dtype]}.onnx`;
    const files = tree.filter((f) => f.path === base || (f.path.startsWith(`${base}_data`) && /^_data(_\d+)?$/.test(f.path.slice(base.length))));
    if (!files.some((f) => f.path === base)) throw new Error(`${spec.label}: ${base} is missing from ${spec.repo}.`);
    weights.push(...files);
  }
  const side = tree.filter((f) => (MODEL_SIDE_FILES as readonly string[]).includes(f.path));
  return [...side, ...weights.sort((a, b) => a.path.localeCompare(b.path))];
}

/** Human-readable size: "1.4 GB", "190 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}
