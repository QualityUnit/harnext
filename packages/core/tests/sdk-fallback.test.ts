/**
 * Integration coverage for issue #51: the `fallback` option must plumb through
 * `createAgentSession` and resolve a fallback `Model` (primary provider by
 * default), without disturbing a no-fallback session. The retry *behavior*
 * itself is unit-tested against a stubbed streamFn in `model-fallback.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentSession } from '../src/index.js';

let harnextHome: string;
const originalHome = process.env.HARNEXT_HOME;

beforeEach(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-sdk-fallback-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

const base = {
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  mcpDisabled: true,
  quiet: true,
} as const;

describe('createAgentSession — fallback option (#51)', () => {
  it('creates a session with a same-provider fallback model', async () => {
    const { session } = await createAgentSession({
      ...base,
      fallback: { modelId: 'claude-sonnet-4-6' },
    });
    // Primary model is unchanged; the fallback is captured in the streamFn.
    expect(session.model.id).toBe('claude-sonnet-4-6');
    await session.dispose();
  });

  it('still works with no fallback configured (pass-through)', async () => {
    const { session } = await createAgentSession({ ...base });
    expect(session.model.id).toBe('claude-sonnet-4-6');
    await session.dispose();
  });

  it('throws if the fallback model id is unknown (resolved eagerly)', async () => {
    await expect(
      createAgentSession({ ...base, fallback: { modelId: 'no-such-model-xyz' } }),
    ).rejects.toThrow(/Unknown model/);
  });
});
