import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  buildOpenRouterModel,
  listOpenRouterModels,
} from '../src/openrouter.js';
import { getProviderById, PROVIDERS } from '../src/providers.js';

describe('buildOpenRouterModel', () => {
  it('points at openrouter.ai/api/v1 with provider=openrouter', () => {
    const m = buildOpenRouterModel('deepseek/deepseek-v4-pro');
    expect(m.id).toBe('deepseek/deepseek-v4-pro');
    expect(m.api).toBe('openai-completions');
    expect(m.provider).toBe('openrouter');
    expect(m.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('passes the model id through verbatim (vendor/model namespace)', () => {
    expect(buildOpenRouterModel('anthropic/claude-sonnet-4.6').id).toBe('anthropic/claude-sonnet-4.6');
    expect(buildOpenRouterModel('openai/gpt-5.3-codex').id).toBe('openai/gpt-5.3-codex');
  });

  it('uses conservative defaults when no summary is supplied (SDK resolution path)', () => {
    const m = buildOpenRouterModel('some/new-model');
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(['text']);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(16384);
  });

  it('carries over metadata from a live summary', () => {
    const m = buildOpenRouterModel('deepseek/deepseek-v4-flash', {
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek: DeepSeek V4 Flash',
      contextLength: 1048576,
      maxCompletionTokens: 131072,
      promptCost: 0.0983,
      completionCost: 0.1966,
      cacheReadCost: 0.0197,
      reasoning: true,
      tools: true,
      inputModalities: ['text'],
    });
    expect(m.name).toBe('DeepSeek: DeepSeek V4 Flash');
    expect(m.contextWindow).toBe(1048576);
    expect(m.maxTokens).toBe(131072);
    expect(m.reasoning).toBe(true);
    expect(m.cost).toEqual({ input: 0.0983, output: 0.1966, cacheRead: 0.0197, cacheWrite: 0 });
  });

  it('keeps only known input modalities (text/image)', () => {
    const m = buildOpenRouterModel('x/y', {
      id: 'x/y',
      inputModalities: ['text', 'image', 'audio'],
    });
    expect(m.input).toEqual(['text', 'image']);
  });

  it('disables compat flags pi-ai cannot infer for OpenRouter', () => {
    const m = buildOpenRouterModel('any/model');
    expect(m.compat?.supportsDeveloperRole).toBe(false);
    expect(m.compat?.supportsReasoningEffort).toBe(false);
  });

  it('exports a default model id and base URL', () => {
    expect(OPENROUTER_DEFAULT_MODEL).toBe('anthropic/claude-sonnet-4.6');
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
});

describe('listOpenRouterModels', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches the public /v1/models endpoint (no auth header)', async () => {
    let capturedUrl = '';
    let capturedAuth: string | undefined = 'sentinel';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await listOpenRouterModels();
    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(capturedAuth).toBeUndefined();
  });

  it('maps fields and converts per-token pricing to per-million-tokens', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'deepseek/deepseek-v4-pro',
              name: 'DeepSeek: DeepSeek V4 Pro',
              context_length: 1048576,
              pricing: { prompt: '0.000000435', completion: '0.00000087', input_cache_read: '0.000000003625' },
              top_provider: { max_completion_tokens: 384000 },
              supported_parameters: ['reasoning', 'tools'],
              architecture: { input_modalities: ['text'] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const models = await listOpenRouterModels();
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.id).toBe('deepseek/deepseek-v4-pro');
    expect(m.contextLength).toBe(1048576);
    expect(m.maxCompletionTokens).toBe(384000);
    // 0.000000435 USD/token * 1e6 = 0.435 USD per million tokens.
    expect(m.promptCost).toBeCloseTo(0.435, 6);
    expect(m.completionCost).toBeCloseTo(0.87, 6);
    expect(m.cacheReadCost).toBeCloseTo(0.003625, 6);
    expect(m.reasoning).toBe(true);
    expect(m.tools).toBe(true);
  });

  it('treats free/zero pricing as undefined (no "$0" in the picker)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'free/model', pricing: { prompt: '0', completion: '0' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const [m] = await listOpenRouterModels();
    expect(m.promptCost).toBeUndefined();
    expect(m.completionCost).toBeUndefined();
  });

  it('sorts by id and skips entries missing an id', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'zzz/model' },
            { id: '' }, // empty id
            {}, // no id
            { id: 'aaa/model' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const models = await listOpenRouterModels();
    expect(models.map((m) => m.id)).toEqual(['aaa/model', 'zzz/model']);
  });

  it('throws on non-2xx responses with status + body excerpt', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Service unavailable', { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(listOpenRouterModels()).rejects.toThrow(/503/);
    await expect(listOpenRouterModels()).rejects.toThrow(/Service unavailable/);
  });

  it('returns an empty array when data is empty or absent', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;
    expect(await listOpenRouterModels()).toEqual([]);
  });
});

describe('PROVIDERS registry — openrouter entry', () => {
  it('registers OpenRouter with the right env var, default model, and customResolution flag', () => {
    const openrouter = getProviderById('openrouter');
    expect(openrouter).toBeDefined();
    expect(openrouter!.envVar).toBe('OPENROUTER_API_KEY');
    expect(openrouter!.defaultModel).toBe('anthropic/claude-sonnet-4.6');
    expect(openrouter!.defaultBaseUrl).toBe('https://openrouter.ai/api/v1');
    // Hosted (not local) — needs an API key.
    expect(openrouter!.local).toBeUndefined();
    // customResolution signals sdk.ts that the live catalog may carry ids the
    // static registry doesn't know, which harnext builds by hand.
    expect(openrouter!.customResolution).toBe(true);
  });

  it('orders openrouter before ollama (the local provider)', () => {
    const ids = PROVIDERS.map((p) => p.id);
    const orIdx = ids.indexOf('openrouter');
    const ollamaIdx = ids.indexOf('ollama');
    expect(orIdx).toBeGreaterThan(-1);
    expect(orIdx).toBeLessThan(ollamaIdx);
  });
});
