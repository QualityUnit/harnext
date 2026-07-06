import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentSession, saveProviderConfig } from '../src/index.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;

beforeEach(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-sdk-model-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterEach(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

const base = { mcpDisabled: true, quiet: true } as const;

describe('createAgentSession — custom provider model resolution', () => {
  it('builds a custom model from options.baseUrl', async () => {
    const { session } = await createAgentSession({
      ...base,
      provider: 'custom',
      modelId: 'my-finetune',
      baseUrl: 'http://localhost:8000/v1',
    });
    const model = session.agent.state.model;
    expect(model.provider).toBe('custom');
    expect(model.id).toBe('my-finetune');
    expect(model.baseUrl).toBe('http://localhost:8000/v1');
    await session.dispose();
  });

  it('falls back to the stored auth.json baseUrl when no options.baseUrl', async () => {
    saveProviderConfig('custom', { baseUrl: 'http://gpu-box:8000' });
    const { session } = await createAgentSession({
      ...base,
      provider: 'custom',
      modelId: 'my-finetune',
    });
    expect(session.agent.state.model.baseUrl).toBe('http://gpu-box:8000/v1');
    await session.dispose();
  });

  it('rejects custom without any baseUrl', async () => {
    await expect(
      createAgentSession({ ...base, provider: 'custom', modelId: 'my-finetune' }),
    ).rejects.toThrow(/base URL/i);
  });

  it('rejects custom without a model id', async () => {
    await expect(
      createAgentSession({ ...base, provider: 'custom', baseUrl: 'http://localhost:8000/v1' }),
    ).rejects.toThrow(/model id/i);
  });

  it('lets options.baseUrl override the stored Ollama URL', async () => {
    const { session } = await createAgentSession({
      ...base,
      provider: 'ollama',
      modelId: 'llama3.1',
      baseUrl: 'http://gpu-box:11434',
    });
    expect(session.agent.state.model.baseUrl).toBe('http://gpu-box:11434/v1');
    await session.dispose();
  });
});
