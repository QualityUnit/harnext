import type { Model } from '@mariozechner/pi-ai';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

export interface OllamaModelSummary {
  id: string;
  contextWindow?: number;
}

/**
 * Normalize a user-provided base URL: strip trailing slash and `/v1` suffix,
 * so callers get the "root" ollama URL (e.g. http://localhost:11434).
 */
export function normalizeOllamaBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (url.endsWith('/v1')) url = url.slice(0, -3);
  return url;
}

/**
 * Build a pi-ai Model for an Ollama model id. Uses the OpenAI-compatible
 * endpoint at `${baseUrl}/v1` with compat flags appropriate for Ollama.
 */
export function buildOllamaModel(modelId: string, baseUrl: string): Model<'openai-completions'> {
  const root = normalizeOllamaBaseUrl(baseUrl);
  return {
    id: modelId,
    name: `${modelId} (Ollama)`,
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl: `${root}/v1`,
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

/**
 * Query the Ollama server for installed models via its native `/api/tags` endpoint.
 */
export async function listOllamaModels(baseUrl: string): Promise<OllamaModelSummary[]> {
  const root = normalizeOllamaBaseUrl(baseUrl);
  const res = await fetch(`${root}/api/tags`);
  if (!res.ok) {
    throw new Error(`Failed to list Ollama models: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name: string; details?: unknown }> };
  const models = data.models ?? [];
  return models.map((m) => ({ id: m.name }));
}
