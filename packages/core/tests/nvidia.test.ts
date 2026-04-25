import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NVIDIA_BASE_URL,
  NVIDIA_DEFAULT_MODEL,
  buildNvidiaModel,
  listNvidiaModels,
} from '../src/nvidia.js';
import { getProviderById, PROVIDERS } from '../src/providers.js';

describe('buildNvidiaModel', () => {
  it('points at integrate.api.nvidia.com/v1 with provider=nvidia', () => {
    const m = buildNvidiaModel('deepseek-ai/deepseek-v4-pro');
    expect(m.id).toBe('deepseek-ai/deepseek-v4-pro');
    expect(m.api).toBe('openai-completions');
    expect(m.provider).toBe('nvidia');
    expect(m.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('passes the model id through verbatim (vendor/model namespace)', () => {
    // NIM ids are slash-namespaced. The OpenAI client routes them into the
    // request body as-is; we must not re-encode or strip the vendor prefix.
    expect(buildNvidiaModel('meta/llama-3.3-70b-instruct').id).toBe('meta/llama-3.3-70b-instruct');
    expect(buildNvidiaModel('nvidia/nemotron-nano-12b-v2').id).toBe('nvidia/nemotron-nano-12b-v2');
  });

  it('disables compat flags pi-ai cannot infer for NIM', () => {
    const m = buildNvidiaModel('any/model');
    expect(m.compat?.supportsDeveloperRole).toBe(false);
    expect(m.compat?.supportsReasoningEffort).toBe(false);
  });

  it('zeroes the cost (NIM pricing is not in pi-ai\'s registry)', () => {
    const m = buildNvidiaModel('any/model');
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('exports a default model id matching the wizard\'s onboarding placeholder', () => {
    expect(NVIDIA_DEFAULT_MODEL).toBe('deepseek-ai/deepseek-v4-pro');
    expect(NVIDIA_BASE_URL).toBe('https://integrate.api.nvidia.com/v1');
  });
});

describe('listNvidiaModels', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses the OpenAI-compatible /v1/models response', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'deepseek-ai/deepseek-v4-pro', object: 'model', owned_by: 'deepseek-ai' },
            { id: 'meta/llama-3.3-70b-instruct', object: 'model', owned_by: 'meta' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const models = await listNvidiaModels('test-key-abc');
    expect(capturedUrl).toBe('https://integrate.api.nvidia.com/v1/models');
    expect(capturedAuth).toBe('Bearer test-key-abc');
    expect(models).toEqual([
      { id: 'deepseek-ai/deepseek-v4-pro', ownedBy: 'deepseek-ai' },
      { id: 'meta/llama-3.3-70b-instruct', ownedBy: 'meta' },
    ]);
  });

  it('throws on non-2xx responses with status + body excerpt', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Invalid token', { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(listNvidiaModels('bad-key')).rejects.toThrow(/401/);
    await expect(listNvidiaModels('bad-key')).rejects.toThrow(/Invalid token/);
  });

  it('skips entries that are missing an id (defensive against future API drift)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'good/model', object: 'model' },
            { object: 'model' }, // no id
            { id: '', object: 'model' }, // empty id
            { id: 'other/model' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const models = await listNvidiaModels('k');
    expect(models.map((m) => m.id)).toEqual(['good/model', 'other/model']);
  });

  it('returns an empty array when data is empty or absent', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;
    expect(await listNvidiaModels('k')).toEqual([]);
  });
});

describe('PROVIDERS registry — nvidia entry', () => {
  it('registers NVIDIA NIM with the right env var, default model, and customResolution flag', () => {
    const nvidia = getProviderById('nvidia');
    expect(nvidia).toBeDefined();
    expect(nvidia!.envVar).toBe('NVIDIA_API_KEY');
    expect(nvidia!.defaultModel).toBe('deepseek-ai/deepseek-v4-pro');
    expect(nvidia!.defaultBaseUrl).toBe('https://integrate.api.nvidia.com/v1');
    // Hosted (not local) — NVIDIA needs an API key, unlike ollama.
    expect(nvidia!.local).toBeUndefined();
    // customResolution is the signal to sdk.ts that the model isn't in
    // pi-ai's static registry and harnext must build one by hand.
    expect(nvidia!.customResolution).toBe(true);
  });

  it('orders nvidia after the API-key providers but before ollama (the local one)', () => {
    // Tiny ergonomics check: discoverability matters in the onboarding
    // picker, and the convention is "hosted with key first, local last."
    const ids = PROVIDERS.map((p) => p.id);
    const nvIdx = ids.indexOf('nvidia');
    const ollamaIdx = ids.indexOf('ollama');
    expect(nvIdx).toBeGreaterThan(-1);
    expect(ollamaIdx).toBeGreaterThan(-1);
    expect(nvIdx).toBeLessThan(ollamaIdx);
  });
});
