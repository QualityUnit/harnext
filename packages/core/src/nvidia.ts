import type { Model } from '@earendil-works/pi-ai';

/**
 * NVIDIA NIM (build.nvidia.com) is OpenAI-compatible — same chat-completions
 * shape, custom base URL, custom model namespace (`vendor/model-name`).
 * pi-ai's model registry doesn't enumerate NIM models, so we build a
 * `Model<'openai-completions'>` by hand the same way ollama.ts does, and
 * thread NVIDIA_API_KEY through the streamFn since pi-ai's getEnvApiKey
 * doesn't recognize the `nvidia` provider id.
 *
 * API reference: https://docs.api.nvidia.com/nim/reference/llm-apis
 */
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * Curated default model id used when the user hasn't picked one yet.
 * Surfaces in the wizard as the placeholder; the user can override via the
 * model picker (which fetches the live list from `/v1/models`).
 */
/**
 * NVIDIA NIM advertises some models in `/v1/models` whose chat-completions
 * endpoints stall with no response (e.g. `deepseek-v4-pro`, `deepseek-v4-flash`).
 * Pick a model whose streaming endpoint is verified working so first-run users
 * don't get stuck in an infinite loading state.
 */
export const NVIDIA_DEFAULT_MODEL = 'moonshotai/kimi-k2.5';

export interface NvidiaModelSummary {
  id: string;
  /** Owner namespace (`deepseek-ai`, `meta`, `nvidia`, `mistralai`, …). */
  ownedBy?: string;
}

/**
 * Build a pi-ai Model for an NVIDIA NIM model id. The model id is
 * passed through unchanged — NIM uses `vendor/model-name` ids that the
 * OpenAI client routes verbatim into the chat-completions request body.
 *
 * `cost` is zero because NVIDIA's per-token pricing is not declared in
 * pi-ai's static registry; treat the cost dashboard at build.nvidia.com
 * as authoritative until upstream support lands.
 */
export function buildNvidiaModel(modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: `${modelId} (NVIDIA NIM)`,
    api: 'openai-completions',
    provider: 'nvidia',
    baseUrl: NVIDIA_BASE_URL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

/**
 * List the NIM models the supplied API key can call. Hits the standard
 * OpenAI-compatible `/v1/models` endpoint. Returns ids in the order NIM
 * returns them (newest-first, in practice).
 *
 * Throws on any non-2xx response so the caller can surface a clear error
 * to the user — an empty array would silently look like "no models" and
 * mask auth/network issues.
 */
export async function listNvidiaModels(apiKey: string): Promise<NvidiaModelSummary[]> {
  const res = await fetch(`${NVIDIA_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to list NVIDIA NIM models: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string; owned_by?: string }> };
  const entries = data.data ?? [];
  const summaries: NvidiaModelSummary[] = [];
  for (const e of entries) {
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    summaries.push({ id: e.id, ownedBy: typeof e.owned_by === 'string' ? e.owned_by : undefined });
  }
  return summaries;
}
