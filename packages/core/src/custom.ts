import type { Model } from '@earendil-works/pi-ai';

/**
 * Generalizes the Ollama pattern (ollama.ts) to any user-supplied
 * OpenAI-compatible endpoint (vLLM, llama.cpp, LiteLLM, LM Studio). `compat` is
 * set explicitly because pi-ai can't infer flags from an unknown host, and the
 * API key is injected via sdk streamFn because pi-ai's getEnvApiKey doesn't
 * know the `custom` provider.
 */

/**
 * Normalize a user-provided base URL: trim + strip trailing slashes, then
 * append `/v1` only when the URL has no path (pathname is `/` or empty). So
 * `http://host:8000` → `http://host:8000/v1`; `http://host:8000/v1` and
 * non-standard mounts like `http://proxy/openai` are kept verbatim. Uses
 * `new URL()` → throws on malformed input.
 */
export function normalizeCustomBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  const hasPath = url.pathname !== '/' && url.pathname !== '';
  return hasPath ? trimmed : `${trimmed}/v1`;
}

/**
 * Build a pi-ai Model for a user-supplied OpenAI-compatible endpoint. Same
 * shape as `buildOllamaModel`, with `provider: 'custom'`.
 */
export function buildCustomModel(modelId: string, baseUrl: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: `${modelId} (custom)`,
    api: 'openai-completions',
    provider: 'custom',
    baseUrl: normalizeCustomBaseUrl(baseUrl),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}
