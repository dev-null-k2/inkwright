import { AIError } from '../errors.ts';
import { joinUrl } from '../http.ts';
import { DEFAULT_CAPABILITIES, type HttpOptions, type Provider, type ProviderCapabilities } from '../types.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai.ts';
import { withPromptTools } from './prompt-tools.ts';

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'xai'
  | 'deepseek'
  | 'together'
  | 'fireworks'
  | 'perplexity'
  | 'cerebras'
  | 'azure-openai'
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'foundry-local'
  | 'custom';

/** Static metadata the settings UI renders (provider picker, key field, model suggestions). */
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** Pre-filled base URL ('' when the user must supply one). */
  defaultBaseUrl: string;
  /** The user must enter a base URL (Azure resource endpoint, custom servers). */
  needsBaseUrl: boolean;
  needsKey: boolean;
  /** Where to create an API key (or download the app, for local servers). */
  keyUrl?: string;
  /** Suggested model ids. Editable in the UI — providers rename models often. */
  models: string[];
  defaultModel: string;
  capabilities: ProviderCapabilities;
  /** Runs on the user's machine/LAN. */
  local?: boolean;
  /** One-line hint shown under the provider in settings. */
  hint?: string;
}

const caps = (c: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({ ...DEFAULT_CAPABILITIES, ...c });

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai-compatible', defaultBaseUrl: 'https://api.openai.com/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    defaultModel: 'gpt-5-mini', capabilities: caps(),
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-5-5', capabilities: caps({ json: false }),
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-3-pro-preview'],
    defaultModel: 'gemini-2.5-flash', capabilities: caps(), hint: 'Free tier available; great at reading handwriting.',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', defaultBaseUrl: 'https://openrouter.ai/api/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    models: ['anthropic/claude-sonnet-5.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat', 'qwen/qwen-2.5-72b-instruct'],
    defaultModel: 'google/gemini-2.5-flash', capabilities: caps(), hint: 'One key for hundreds of models from every major lab.',
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai-compatible', defaultBaseUrl: 'https://api.groq.com/openai/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b', 'llama-3.1-8b-instant'],
    defaultModel: 'llama-3.3-70b-versatile', capabilities: caps(), hint: 'Very fast open models.',
  },
  {
    id: 'mistral', label: 'Mistral', kind: 'openai-compatible', defaultBaseUrl: 'https://api.mistral.ai/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'pixtral-large-latest', 'ministral-8b-latest'],
    defaultModel: 'mistral-small-latest', capabilities: caps(),
  },
  {
    id: 'xai', label: 'xAI (Grok)', kind: 'openai-compatible', defaultBaseUrl: 'https://api.x.ai/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://console.x.ai',
    models: ['grok-4', 'grok-3', 'grok-3-mini', 'grok-2-vision-1212'],
    defaultModel: 'grok-3-mini', capabilities: caps(),
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai-compatible', defaultBaseUrl: 'https://api.deepseek.com/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat', capabilities: caps({ vision: false }),
  },
  {
    id: 'together', label: 'Together AI', kind: 'openai-compatible', defaultBaseUrl: 'https://api.together.xyz/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', capabilities: caps(),
  },
  {
    id: 'fireworks', label: 'Fireworks AI', kind: 'openai-compatible', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://fireworks.ai/account/api-keys',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/deepseek-v3', 'accounts/fireworks/models/qwen2p5-vl-32b-instruct'],
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', capabilities: caps(),
  },
  {
    id: 'perplexity', label: 'Perplexity', kind: 'openai-compatible', defaultBaseUrl: 'https://api.perplexity.ai', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://www.perplexity.ai/settings/api',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'],
    defaultModel: 'sonar', capabilities: caps({ tools: false, listModels: false, json: false }),
    hint: 'Web-grounded answers. No native tool calling (the agent uses a text protocol).',
  },
  {
    id: 'cerebras', label: 'Cerebras', kind: 'openai-compatible', defaultBaseUrl: 'https://api.cerebras.ai/v1', needsBaseUrl: false, needsKey: true,
    keyUrl: 'https://cloud.cerebras.ai',
    models: ['llama-3.3-70b', 'gpt-oss-120b', 'qwen-3-32b', 'llama3.1-8b'],
    defaultModel: 'llama-3.3-70b', capabilities: caps({ vision: false }),
  },
  {
    id: 'azure-openai', label: 'Azure OpenAI', kind: 'openai-compatible', defaultBaseUrl: '', needsBaseUrl: true, needsKey: true,
    keyUrl: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    defaultModel: 'gpt-4o-mini', capabilities: caps({ listModels: false }),
    hint: 'Base URL is your resource endpoint (https://NAME.openai.azure.com); the model is your deployment name.',
  },
  {
    id: 'ollama', label: 'Ollama (local)', kind: 'openai-compatible', defaultBaseUrl: 'http://localhost:11434/v1', needsBaseUrl: false, needsKey: false,
    keyUrl: 'https://ollama.com/download',
    models: ['llama3.2', 'llama3.2-vision', 'qwen3', 'qwen2.5', 'gemma3', 'mistral-small3.1'],
    defaultModel: 'llama3.2', capabilities: caps(), local: true,
    hint: 'Runs on your computer. For the web app start it with OLLAMA_ORIGINS=* so the browser may connect.',
  },
  {
    id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai-compatible', defaultBaseUrl: 'http://localhost:1234/v1', needsBaseUrl: false, needsKey: false,
    keyUrl: 'https://lmstudio.ai',
    models: [], defaultModel: '', capabilities: caps(), local: true,
    hint: 'Start the local server in LM Studio (enable CORS for the web app) and pick a loaded model.',
  },
  {
    id: 'llamacpp', label: 'llama.cpp server (local)', kind: 'openai-compatible', defaultBaseUrl: 'http://localhost:8080/v1', needsBaseUrl: false, needsKey: false,
    keyUrl: 'https://github.com/ggml-org/llama.cpp',
    models: [], defaultModel: '', capabilities: caps({ vision: false }), local: true,
    hint: 'Start llama-server with --cors "*" so the web app may connect.',
  },
  {
    id: 'foundry-local', label: 'Foundry Local (Windows/macOS)', kind: 'openai-compatible', defaultBaseUrl: 'http://localhost:5272/v1', needsBaseUrl: false, needsKey: false,
    keyUrl: 'https://github.com/microsoft/Foundry-Local',
    models: [], defaultModel: '', capabilities: caps({ vision: false }), local: true,
    hint: 'Fix its port with "foundry service set --port 5272" so Inkstone can find it.',
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'openai-compatible', defaultBaseUrl: '', needsBaseUrl: true, needsKey: false,
    models: [], defaultModel: '', capabilities: caps(),
    hint: 'Any server that speaks the OpenAI Chat Completions API (vLLM, llama.cpp, LiteLLM, Jan, …).',
  },
];

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface ProviderConfig extends HttpOptions {
  providerId: ProviderId | (string & {});
  apiKey?: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  /** Azure `api-version` query parameter (default 2024-10-21). */
  azureApiVersion?: string;
  /** Use the text tool-calling protocol even when the API has native tools (weak local models). */
  promptTools?: boolean;
  /** OpenRouter attribution (defaults: https://inkstone.app / Inkstone). */
  appUrl?: string;
  appName?: string;
}

export const AZURE_DEFAULT_API_VERSION = '2024-10-21';

const REASONING_MODEL = /^(o\d|gpt-5(?!.*chat))/i;

/** Builds a ready-to-use Provider from what the settings screen stores. */
export function createProvider(config: ProviderConfig): Provider {
  const info = getProviderInfo(config.providerId);
  if (!info) throw new AIError({ code: 'unsupported', provider: config.providerId, message: `Unknown AI provider "${config.providerId}".` });
  const baseUrl = (config.baseUrl?.trim() || info.defaultBaseUrl).replace(/\/+$/, '');
  if (!baseUrl) throw new AIError({ code: 'bad_request', provider: info.id, message: `${info.label} needs a base URL. Add it in Settings → AI.` });
  if (info.needsKey && !config.apiKey) throw new AIError({ code: 'auth', provider: info.id, message: `Add your ${info.label} API key in Settings → AI.` });
  const http: HttpOptions = { fetch: config.fetch, maxRetries: config.maxRetries, retryBaseMs: config.retryBaseMs };
  let provider: Provider;
  if (info.kind === 'anthropic') {
    provider = new AnthropicProvider({ ...http, id: info.id, label: info.label, apiKey: config.apiKey, baseUrl, headers: config.extraHeaders });
  } else if (info.kind === 'gemini') {
    provider = new GeminiProvider({ ...http, id: info.id, label: info.label, apiKey: config.apiKey, baseUrl, headers: config.extraHeaders });
  } else {
    const oc: OpenAICompatibleConfig = { ...http, id: info.id, label: info.label, baseUrl, apiKey: config.apiKey, headers: config.extraHeaders, capabilities: info.capabilities };
    switch (info.id) {
      case 'openai':
        oc.maxTokensField = 'max_completion_tokens';
        oc.omitTemperature = (m) => REASONING_MODEL.test(m);
        break;
      case 'openrouter':
        oc.headers = { 'HTTP-Referer': config.appUrl ?? 'https://inkstone.app', 'X-Title': config.appName ?? 'Inkstone', ...config.extraHeaders };
        break;
      case 'mistral':
      case 'perplexity':
        oc.streamUsage = false;
        break;
      case 'azure-openai': {
        oc.auth = 'api-key';
        oc.query = { 'api-version': config.azureApiVersion ?? AZURE_DEFAULT_API_VERSION };
        oc.maxTokensField = 'max_completion_tokens';
        oc.omitTemperature = (m) => REASONING_MODEL.test(m);
        oc.modelsUrl = null;
        // Either the resource endpoint (deployment = model) or a full deployment URL.
        oc.chatUrl = (model) =>
          /\/deployments\/[^/]+/.test(baseUrl)
            ? joinUrl(baseUrl.replace(/\/chat\/completions$/, ''), 'chat/completions')
            : joinUrl(baseUrl.replace(/\/openai$/, ''), `openai/deployments/${encodeURIComponent(model)}/chat/completions`);
        break;
      }
      case 'ollama':
      case 'lmstudio':
      case 'llamacpp':
      case 'foundry-local':
      case 'custom':
        if (!config.apiKey) oc.auth = 'none';
        break;
    }
    provider = new OpenAICompatibleProvider(oc);
  }
  if (config.promptTools || !provider.capabilities.tools) provider = withPromptTools(provider);
  return provider;
}

/** Best-effort guess at a model's abilities from its name (for UI badges; not authoritative). */
export function guessModelCapabilities(model: string): { vision: boolean; reasoning: boolean } {
  const m = model.toLowerCase();
  const vision = /(gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|vision|pixtral|llava|llama-4|llama4|gemma-?3|qwen.*vl|grok-(2-vision|4)|mistral-(medium|small)|minicpm-v|moondream)/.test(m) && !/(gpt-oss|embed|whisper|tts)/.test(m);
  const reasoning = /(^o\d|\/o\d|gpt-5|reasoner|reasoning|r1|thinking|qwq|gpt-oss|opus|sonnet-(4|5))/.test(m);
  return { vision, reasoning };
}
