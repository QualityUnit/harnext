export interface ProviderInfo {
  id: string;
  name: string;
  /** Env var holding the API key. Empty for providers that don't use an API key (e.g. ollama). */
  envVar: string;
  defaultModel: string;
  /** True for local inference servers (ollama, etc.) — no API key, configured via baseUrl. */
  local?: boolean;
  /** Default base URL for local providers. */
  defaultBaseUrl?: string;
}

/**
 * Providers that support simple API key auth, plus local-inference providers.
 * Ordered by general popularity / relevance for coding agents.
 */
export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-6' },
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', defaultModel: 'gpt-5.3-codex' },
  { id: 'google', name: 'Google Gemini', envVar: 'GEMINI_API_KEY', defaultModel: 'gemini-3-flash-preview' },
  { id: 'xai', name: 'xAI (Grok)', envVar: 'XAI_API_KEY', defaultModel: 'grok-3' },
  { id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', defaultModel: 'anthropic/claude-sonnet-4' },
  { id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile' },
  { id: 'mistral', name: 'Mistral', envVar: 'MISTRAL_API_KEY', defaultModel: 'mistral-large-latest' },
  { id: 'cerebras', name: 'Cerebras', envVar: 'CEREBRAS_API_KEY', defaultModel: 'qwen-3-235b-a22b-instruct-2507' },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    envVar: '',
    defaultModel: 'llama3.1',
    local: true,
    defaultBaseUrl: 'http://localhost:11434',
  },
];

export function getProviderById(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Set the env var for a provider so pi-ai's getEnvApiKey() picks it up.
 * No-op for local providers.
 */
export function setProviderEnv(provider: ProviderInfo, key: string): void {
  if (!provider.envVar) return;
  process.env[provider.envVar] = key;
}
