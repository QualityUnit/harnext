import { describe, expect, it } from 'vitest';

import { buildCustomModel, normalizeCustomBaseUrl } from '../src/custom.js';
import { getProviderById, PROVIDERS } from '../src/providers.js';

describe('buildCustomModel', () => {
  it('builds an openai-completions model with provider=custom', () => {
    const m = buildCustomModel('my-finetune', 'http://localhost:8000/v1');
    expect(m.id).toBe('my-finetune');
    expect(m.api).toBe('openai-completions');
    expect(m.provider).toBe('custom');
    expect(m.baseUrl).toBe('http://localhost:8000/v1');
    expect(m.name).toBe('my-finetune (custom)');
  });

  it('zeroes the cost (unknown endpoint has no pricing metadata)', () => {
    const m = buildCustomModel('any-model', 'http://host:8000');
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('disables compat flags pi-ai cannot infer for an unknown host', () => {
    const m = buildCustomModel('any-model', 'http://host:8000');
    expect(m.compat?.supportsDeveloperRole).toBe(false);
    expect(m.compat?.supportsReasoningEffort).toBe(false);
  });
});

describe('normalizeCustomBaseUrl', () => {
  it('appends /v1 when the URL has no path', () => {
    expect(normalizeCustomBaseUrl('http://host:8000')).toBe('http://host:8000/v1');
  });

  it('keeps an explicit /v1 unchanged (the documented example)', () => {
    expect(normalizeCustomBaseUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1');
  });

  it('keeps a non-standard mount path verbatim', () => {
    expect(normalizeCustomBaseUrl('http://proxy/openai')).toBe('http://proxy/openai');
  });

  it('strips trailing slashes', () => {
    expect(normalizeCustomBaseUrl('http://host:8000/v1/')).toBe('http://host:8000/v1');
    expect(normalizeCustomBaseUrl('http://host:8000/')).toBe('http://host:8000/v1');
  });

  it('throws on malformed input', () => {
    expect(() => normalizeCustomBaseUrl('not-a-url')).toThrow();
  });
});

describe('PROVIDERS registry — custom entry', () => {
  it('registers custom as hidden/local/customResolution with empty envVar and defaultModel', () => {
    const custom = getProviderById('custom');
    expect(custom).toBeDefined();
    expect(custom!.envVar).toBe('');
    expect(custom!.defaultModel).toBe('');
    expect(custom!.local).toBe(true);
    expect(custom!.customResolution).toBe(true);
    expect(custom!.hidden).toBe(true);
  });

  it('is ordered last (after ollama)', () => {
    expect(PROVIDERS[PROVIDERS.length - 1].id).toBe('custom');
  });
});
