import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentSession, createSessionWriter } from '../src/index.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;

beforeEach(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-sdk-resume-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterEach(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

function user(text: string, ts = 1): AgentMessage {
  return { role: 'user', content: text, timestamp: ts } as AgentMessage;
}
function assistant(text: string, ts = 2): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: ts,
  } as AgentMessage;
}

const base = {
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  mcpDisabled: true,
  quiet: true,
} as const;

describe('createAgentSession — client-supplied history', () => {
  it('seeds initialMessages directly and reports resumed', async () => {
    const initialMessages = [user('remember X = 42'), assistant('Noted, X is 42.')];
    const { session, resumed, sessionId } = await createAgentSession({
      ...base,
      sessionId: 'client-controlled-id',
      initialMessages,
    });
    expect(resumed).toBe(true);
    expect(sessionId).toBe('client-controlled-id'); // caller controls the id
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({ role: 'user', content: 'remember X = 42' });
    await session.dispose();
  });

  it('initialMessages take precedence over resumeSessionId', async () => {
    // A different transcript exists in the store under this id…
    createSessionWriter({ cwd: process.cwd(), sessionId: 'stored-id' }).record([
      user('stored prompt'),
      assistant('stored reply'),
    ]);
    // …but the caller-supplied history wins.
    const { session, resumed } = await createAgentSession({
      ...base,
      resumeSessionId: 'stored-id',
      initialMessages: [user('client prompt')],
    });
    expect(resumed).toBe(true);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({ content: 'client prompt' });
    await session.dispose();
  });

  it('resumeSessionId still loads from the store when no initialMessages given', async () => {
    createSessionWriter({ cwd: process.cwd(), sessionId: 'stored-id' }).record([
      user('stored prompt'),
      assistant('stored reply'),
    ]);
    const { session, resumed, sessionId } = await createAgentSession({
      ...base,
      resumeSessionId: 'stored-id',
    });
    expect(resumed).toBe(true);
    expect(sessionId).toBe('stored-id');
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    await session.dispose();
  });

  it('is a fresh session (resumed=false) with no seed source', async () => {
    const { session, resumed } = await createAgentSession({ ...base });
    expect(resumed).toBe(false);
    expect(session.messages).toHaveLength(0);
    await session.dispose();
  });

  it('treats an empty initialMessages array as no seed', async () => {
    const { session, resumed } = await createAgentSession({ ...base, initialMessages: [] });
    expect(resumed).toBe(false);
    expect(session.messages).toHaveLength(0);
    await session.dispose();
  });
});
