import { LOCAL_MODELS, getLocalModel, type LocalDevice, type LocalModelRole, type LocalModelSpec, type LocalModelVariant } from './catalog.ts';

/**
 * What this device can do for on-device AI. Read once from WebGPU adapter limits and the
 * navigator; everything is optional because browsers expose different subsets (Safari and Firefox
 * have no `deviceMemory`, Chrome caps it at 8).
 */
export interface HardwareInfo {
  webgpu: boolean;
  /** WebGPU `shader-f16`: half-precision weights (q4f16) run, which are smaller and faster. */
  shaderF16: boolean;
  /** Largest single GPU buffer, bytes (0 without WebGPU). Discrete GPUs / Apple Silicon report ~4 GB. */
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  /** A software (CPU) WebGPU adapter: treat as no GPU. */
  fallbackAdapter: boolean;
  gpu?: { vendor?: string; architecture?: string; description?: string };
  /** `navigator.deviceMemory` in GB, when exposed. */
  memoryGB?: number;
  cores: number;
  mobile: boolean;
  os: 'android' | 'ios' | 'mac' | 'windows' | 'linux' | 'chromeos' | 'other';
  /** SharedArrayBuffer is allowed, so the WASM backend can use several threads. */
  crossOriginIsolated: boolean;
}

/** The subset of `navigator` (or a worker's navigator) the detector reads. Injected for tests. */
export interface NavigatorLike {
  gpu?: { requestAdapter(opts?: unknown): Promise<any> };
  deviceMemory?: number;
  hardwareConcurrency?: number;
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean; platform?: string };
}

export function detectOs(nav: NavigatorLike): HardwareInfo['os'] {
  const ua = nav.userAgent ?? '';
  const platform = nav.userAgentData?.platform ?? '';
  if (/Android/i.test(ua) || platform === 'Android') return 'android';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)) return 'ios';
  if (/CrOS/.test(ua) || platform === 'Chrome OS') return 'chromeos';
  if (/Macintosh|Mac OS X/.test(ua) || platform === 'macOS') return 'mac';
  if (/Windows/.test(ua) || platform === 'Windows') return 'windows';
  if (/Linux/.test(ua) || platform === 'Linux') return 'linux';
  return 'other';
}

/** Reads WebGPU adapter limits and device hints. Never throws. */
export async function detectHardware(nav: NavigatorLike = (globalThis as any).navigator ?? {}, opts: { crossOriginIsolated?: boolean } = {}): Promise<HardwareInfo> {
  const os = detectOs(nav);
  const mobile = nav.userAgentData?.mobile ?? (os === 'android' || os === 'ios');
  const info: HardwareInfo = {
    webgpu: false,
    shaderF16: false,
    maxBufferSize: 0,
    maxStorageBufferBindingSize: 0,
    fallbackAdapter: false,
    memoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    cores: nav.hardwareConcurrency ?? 4,
    mobile,
    os,
    crossOriginIsolated: opts.crossOriginIsolated ?? !!(globalThis as any).crossOriginIsolated,
  };
  try {
    const adapter = await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      info.webgpu = true;
      info.shaderF16 = !!adapter.features?.has?.('shader-f16');
      info.maxBufferSize = Number(adapter.limits?.maxBufferSize ?? 0);
      info.maxStorageBufferBindingSize = Number(adapter.limits?.maxStorageBufferBindingSize ?? 0);
      const ai = adapter.info ?? {};
      info.fallbackAdapter = !!(adapter.isFallbackAdapter ?? ai.isFallbackAdapter);
      info.gpu = { vendor: ai.vendor || undefined, architecture: ai.architecture || undefined, description: ai.description || undefined };
      if (info.fallbackAdapter) info.webgpu = false;
    }
  } catch {
    /* WebGPU blocked or crashed: WASM it is. */
  }
  return info;
}

export type DeviceTier = 'cpu' | 'gpu-small' | 'gpu' | 'gpu-large';

export interface ModelChoice {
  spec: LocalModelSpec;
  variant: LocalModelVariant;
}

export interface LocalRecommendation {
  tier: DeviceTier;
  /** Null when the device is too small for a useful chat model (search still works). */
  chat: ModelChoice | null;
  embed: ModelChoice;
  /** Plain-language reason shown in settings. */
  why: string;
}

/** Memory the browser will let us use, in GB, when the browser does not say. */
function assumedMemory(hw: HardwareInfo): number {
  if (hw.memoryGB != null) return hw.memoryGB;
  if (hw.os === 'ios') return 3; // WebKit kills tabs well below the device's RAM.
  if (hw.os === 'mac') return 8;
  return hw.mobile ? 4 : 8;
}

export function deviceTier(hw: HardwareInfo): DeviceTier {
  const mem = assumedMemory(hw);
  if (!hw.webgpu) return 'cpu';
  if (hw.os === 'ios' || mem < 4) return 'gpu-small';
  if (!hw.mobile && mem >= 8 && hw.shaderF16 && hw.maxBufferSize >= 4_000_000_000) return 'gpu-large';
  if (hw.mobile && mem < 8) return 'gpu-small';
  return 'gpu';
}

/**
 * The variant of a model to run here: WebGPU when available (half precision when the GPU has
 * shader-f16, otherwise 4-bit with float32 maths), else the CPU/WASM build. Null when the model
 * has no build this device can run.
 */
export function pickVariant(spec: LocalModelSpec, hw: Pick<HardwareInfo, 'webgpu' | 'shaderF16'>): (LocalModelVariant & { device: LocalDevice }) | null {
  if (hw.webgpu) {
    const gpu = spec.variants.find((v) => v.device === 'webgpu' && (hw.shaderF16 || (v.dtype !== 'q4f16' && v.dtype !== 'fp16')));
    if (gpu) return gpu;
    const cpuBuild = spec.variants.find((v) => v.device === 'wasm');
    if (cpuBuild) return { ...cpuBuild, device: 'webgpu' }; // same weights, run on the GPU
    return null;
  }
  return spec.variants.find((v) => v.device === 'wasm') ?? null;
}

const TIER_CHAT: Record<DeviceTier, string | null> = { cpu: 'granite-4.0-350m', 'gpu-small': 'qwen3-0.6b', gpu: 'qwen3-1.7b', 'gpu-large': 'qwen3-4b-2507' };
const TIER_EMBED: Record<DeviceTier, string> = { cpu: 'granite-embedding-97m', 'gpu-small': 'embeddinggemma-2', gpu: 'embeddinggemma-2', 'gpu-large': 'embeddinggemma-2' };

/** Default models for this device. */
export function recommendLocal(hw: HardwareInfo): LocalRecommendation {
  const tier = deviceTier(hw);
  const mem = assumedMemory(hw);
  const choose = (id: string | null): ModelChoice | null => {
    const spec = getLocalModel(id);
    const variant = spec && pickVariant(spec, hw);
    return spec && variant ? { spec, variant } : null;
  };
  const embed = choose(TIER_EMBED[tier]) ?? choose('minilm-l6')!;
  // Below ~3 GB a chat model would push the app out of memory; search still runs.
  const chat = tier === 'cpu' && mem < 3 ? null : choose(TIER_CHAT[tier]);
  const gpuName = hw.gpu?.description || [hw.gpu?.vendor, hw.gpu?.architecture].filter(Boolean).join(' ');
  const why =
    tier === 'cpu'
      ? 'No GPU access for web apps here, so models run on the processor. Answers are slower; search is unaffected.'
      : tier === 'gpu-large'
        ? `Runs on your graphics chip${gpuName ? ` (${gpuName})` : ''} with plenty of memory, so the most capable model fits.`
        : tier === 'gpu'
          ? `Runs on your graphics chip${gpuName ? ` (${gpuName})` : ''}.`
          : 'Runs on your graphics chip; a compact model keeps memory use low on this device.';
  return { tier, chat, embed, why };
}

/** Every model of a role this device can run, best first for its tier. */
export function runnableModels(hw: HardwareInfo, role: LocalModelRole): ModelChoice[] {
  return LOCAL_MODELS.filter((m) => m.role === role)
    .map((spec) => ({ spec, variant: pickVariant(spec, hw) }))
    .filter((c): c is ModelChoice => !!c.variant);
}

/**
 * The speech-to-text model for this device and language. English speech gets Moonshine, which
 * costs time in proportion to the audio instead of always padding to 30 s, so live transcripts keep
 * up even on a phone's CPU; other languages get Whisper. Big GPUs get Whisper Large v3 Turbo, the
 * most accurate model that runs in a browser. Null when nothing fits.
 */
export function recommendAsr(hw: HardwareInfo, language = 'en'): ModelChoice | null {
  const tier = deviceTier(hw);
  const english = /^en\b/i.test(language) || !language;
  const order: string[] =
    tier === 'gpu-large' ? ['whisper-large-v3-turbo', english ? 'moonshine-base' : 'whisper-base']
      : tier === 'cpu' ? (english ? ['moonshine-tiny', 'whisper-base'] : ['whisper-base'])
        : english ? ['moonshine-base', 'whisper-base'] : ['whisper-base'];
  for (const id of order) {
    const spec = getLocalModel(id);
    const variant = spec && pickVariant(spec, hw);
    if (spec && variant) return { spec, variant };
  }
  return null;
}
