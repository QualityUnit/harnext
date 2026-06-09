import type { Model } from '@mariozechner/pi-ai';

/**
 * OpenRouter (openrouter.ai) is an OpenAI-compatible aggregator that fronts
 * hundreds of models from many vendors under `vendor/model-name` ids. pi-ai
 * ships a *static* snapshot of the catalog in its model registry, so models
 * released after that snapshot (e.g. `deepseek/deepseek-v4-pro`) are missing.
 *
 * To stay current we fetch the live catalog from OpenRouter's public
 * `/v1/models` endpoint (no API key required) and build a
 * `Model<'openai-completions'>` by hand for any id the registry doesn't know.
 * Known ids still go through pi-ai's registry (see sdk.ts) so they keep their
 * curated metadata.
 *
 * API reference: https://openrouter.ai/docs/api-reference/list-available-models
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Curated default surfaced before the user picks from the live list. */
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

export interface OpenRouterModelSummary {
  id: string;
  /** Human-readable name (`DeepSeek: DeepSeek V4 Pro`). */
  name?: string;
  /** Max context window in tokens. */
  contextLength?: number;
  /** Max output tokens the top provider allows. */
  maxCompletionTokens?: number;
  /** USD per *million* input tokens (pi-ai's cost unit). */
  promptCost?: number;
  /** USD per *million* output tokens. */
  completionCost?: number;
  /** USD per *million* cached input tokens. */
  cacheReadCost?: number;
  /** True when the model exposes a `reasoning` parameter. */
  reasoning?: boolean;
  /** True when the model supports tool/function calling. */
  tools?: boolean;
  /** Input modalities (`text`, `image`, …). */
  inputModalities?: string[];
}

/**
 * OpenRouter prices are decimal strings in USD *per token*; pi-ai's `cost`
 * fields are USD *per million tokens*. Convert and drop anything that isn't a
 * positive finite number (free models, malformed entries) to `undefined` so
 * callers can omit the field rather than show "$0".
 */
function toPerMillion(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const perToken = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(perToken) || perToken <= 0) return undefined;
  return perToken * 1_000_000;
}

interface RawOpenRouterModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
}

/**
 * Fetch the live OpenRouter catalog. The endpoint is public (no auth), so this
 * works during onboarding before any key is entered.
 *
 * Throws on any non-2xx response so the caller can surface a clear error — an
 * empty array would silently read as "no models" and mask network issues.
 */
export async function listOpenRouterModels(): Promise<OpenRouterModelSummary[]> {
  const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Failed to list OpenRouter models: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    );
  }
  const json = (await res.json()) as { data?: RawOpenRouterModel[] };
  const entries = json.data ?? [];
  const summaries: OpenRouterModelSummary[] = [];
  for (const e of entries) {
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    const params = e.supported_parameters ?? [];
    summaries.push({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : undefined,
      contextLength: typeof e.context_length === 'number' ? e.context_length : undefined,
      maxCompletionTokens:
        typeof e.top_provider?.max_completion_tokens === 'number'
          ? e.top_provider.max_completion_tokens
          : undefined,
      promptCost: toPerMillion(e.pricing?.prompt),
      completionCost: toPerMillion(e.pricing?.completion),
      cacheReadCost: toPerMillion(e.pricing?.input_cache_read),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      tools: params.includes('tools'),
      inputModalities: e.architecture?.input_modalities,
    });
  }
  // Sort by id so vendors group together and models are easy to scan/find.
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return summaries;
}

/**
 * Build a pi-ai Model for an OpenRouter model id. The id is passed through
 * verbatim — OpenRouter routes `vendor/model-name` ids straight into the
 * chat-completions request body.
 *
 * When a `summary` from {@link listOpenRouterModels} is supplied, its metadata
 * (context window, pricing, reasoning) is carried over; otherwise conservative
 * defaults are used so the model is still usable from just an id (the SDK
 * resolution path, which doesn't hit the network).
 */
export function buildOpenRouterModel(
  modelId: string,
  summary?: OpenRouterModelSummary,
): Model<'openai-completions'> {
  const inputModalities = summary?.inputModalities?.filter(
    (m): m is 'text' | 'image' => m === 'text' || m === 'image',
  );
  return {
    id: modelId,
    name: summary?.name ?? `${modelId} (OpenRouter)`,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: summary?.reasoning ?? false,
    input: inputModalities && inputModalities.length > 0 ? inputModalities : ['text'],
    cost: {
      input: summary?.promptCost ?? 0,
      output: summary?.completionCost ?? 0,
      cacheRead: summary?.cacheReadCost ?? 0,
      cacheWrite: 0,
    },
    contextWindow: summary?.contextLength ?? 128000,
    maxTokens: summary?.maxCompletionTokens ?? 16384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}
