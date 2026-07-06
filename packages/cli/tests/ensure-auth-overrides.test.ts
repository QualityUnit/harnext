import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureAuth } from '../src/cli/onboarding.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;

beforeEach(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-ensure-auth-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterEach(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

describe('ensureAuth — CLI overrides', () => {
  it('short-circuits on a base-url override without persisting anything', async () => {
    const result = await ensureAuth('custom', 'my-finetune', {
      baseUrl: 'http://x:8000/v1',
    });
    expect(result).toEqual({ provider: 'custom', model: 'my-finetune' });
    expect(existsSync(join(harnextHome, 'agent', 'auth.json'))).toBe(false);
  });

  it('sets the provider env var from an api-key override, returning the pair unchanged', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      const result = await ensureAuth('openai', 'gpt-x', { apiKey: 'sk-test' });
      expect(process.env.OPENAI_API_KEY).toBe('sk-test');
      expect(result).toEqual({ provider: 'openai', model: 'gpt-x' });
      expect(existsSync(join(harnextHome, 'agent', 'auth.json'))).toBe(false);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});
