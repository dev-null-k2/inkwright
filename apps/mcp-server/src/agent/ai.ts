/**
 * The AI the server's own agent uses (A2A, `run_routine`, summarize/transcribe tasks, the
 * always-on runner). It is configured for the server — not borrowed from the app, whose API keys
 * live encrypted in the browser — with any provider @inkstone/ai supports: OpenAI and the
 * OpenAI-compatible family (OpenRouter, Groq, Mistral, …, a custom URL), Anthropic, Gemini, or a
 * local Ollama / LM Studio. Keys come from environment variables (or the 0600 config file), never
 * from command-line arguments, so they don't show up in `ps` or service files.
 */
import { createProvider, getProviderInfo, guessModelCapabilities, type FetchLike, type Provider } from '@inkstone/ai';

export interface AgentAIConfig {
  /** Provider id from @inkstone/ai's registry: openai, anthropic, gemini, ollama, custom, … */
  provider: string;
  model?: string;
  baseUrl?: string;
  /** Inline key (config file only). Prefer `apiKeyEnv`. */
  apiKey?: string;
  /** Environment variable holding the key (default: the provider's usual one). */
  apiKeyEnv?: string;
  /** Override the vision guess (page images, handwriting transcription). */
  vision?: boolean;
}

export interface AgentAI {
  provider: Provider;
  model: string;
  /** "Anthropic (Claude) · claude-sonnet-4-5" */
  label: string;
  vision: boolean;
}

/** The environment variable each provider's key is usually in. */
export const DEFAULT_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  custom: 'INKSTONE_AI_API_KEY',
};

/** Resolves the API key: inline, the named variable, INKSTONE_AI_API_KEY, then the provider default. */
export function resolveApiKey(cfg: AgentAIConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (cfg.apiKey) return cfg.apiKey;
  if (cfg.apiKeyEnv) return env[cfg.apiKeyEnv] || undefined;
  return env.INKSTONE_AI_API_KEY || env[DEFAULT_KEY_ENV[cfg.provider] ?? ''] || (cfg.provider === 'gemini' ? env.GOOGLE_API_KEY : undefined) || undefined;
}

/** Builds the provider; throws a plain-language error when something is missing. */
export function createAgentAI(cfg: AgentAIConfig, env: NodeJS.ProcessEnv = process.env, fetch?: FetchLike): AgentAI {
  const info = getProviderInfo(cfg.provider);
  if (!info) throw new Error(`Unknown AI provider "${cfg.provider}". Use one of: openai, anthropic, gemini, ollama, lmstudio, openrouter, groq, mistral, xai, deepseek, together, fireworks, perplexity, cerebras, azure-openai, custom.`);
  const apiKey = resolveApiKey(cfg, env);
  if (info.needsKey && !apiKey) {
    const v = cfg.apiKeyEnv ?? DEFAULT_KEY_ENV[cfg.provider] ?? 'INKSTONE_AI_API_KEY';
    throw new Error(`${info.label} needs an API key. Set ${v} (or INKSTONE_AI_API_KEY) in the environment.`);
  }
  const model = cfg.model?.trim() || info.defaultModel;
  if (!model) throw new Error(`Choose a model for ${info.label} with --ai-model.`);
  const provider = createProvider({ providerId: info.id, apiKey, baseUrl: cfg.baseUrl, fetch, appName: 'Inkstone agent' });
  const vision = cfg.vision ?? (info.capabilities.vision && guessModelCapabilities(model).vision);
  return { provider, model, label: `${info.label} · ${model}`, vision };
}
