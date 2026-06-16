/**
 * Integration test for issue #57: a mid-session `/model` switch must survive
 * into `--resume`. Previously the persisted session-meta froze the model at
 * creation time (the provider default, e.g. openrouter's qwen), so resuming
 * reverted to it.
 *
 * Exercises the real seam end-to-end:
 *   createAgentSession → session.model (live getter)
 *   setModel (agent.state.model swap) → recorder.flush → session-store meta
 *   resolveResumeTarget (the --resume picker source) reads the switched model
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAgentSession, loadSession } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { attachSessionRecorder } from '../src/cli/session-recorder.js';
import { resolveResumeTarget } from '../src/cli/resume.js';

let harnextHome: string;
const originalHome = process.env.HARNEXT_HOME;
const CWD = process.cwd();

beforeEach(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-resume-model-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHome;
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
    model: 'claude-x',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: ts,
  } as AgentMessage;
}

describe('resumed model persistence (issue #57)', () => {
  it('session.model reflects a live /model switch (not the creation-time model)', async () => {
    const { session } = await createAgentSession({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      mcpDisabled: true,
      quiet: true,
    });
    expect(session.model.id).toBe('claude-sonnet-4-6');

    // What the /model command does: swap the live model on agent.state.
    session.agent.state.model = { ...session.model, id: 'claude-opus-4-8' };
    expect(session.model.id).toBe('claude-opus-4-8');

    await session.dispose();
  });

  it('persists the switched model so --resume restores it', async () => {
    const { session, sessionId } = await createAgentSession({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      mcpDisabled: true,
      quiet: true,
      sessionId: 'resume-57',
    });
    const recorder = attachSessionRecorder(session, {
      cwd: CWD,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });

    // First turn, recorded under the creation-time model.
    session.agent.state.messages = [user('start'), assistant('ok')];
    recorder.flush();
    expect(loadSession(sessionId, CWD)?.model).toBe('claude-sonnet-4-6');

    // User switches model mid-session, then another turn happens.
    session.agent.state.model = { ...session.model, id: 'claude-opus-4-8' };
    session.agent.state.messages = [user('start'), assistant('ok'), user('more', 3), assistant('done', 4)];
    recorder.flush();

    // On disk + via the --resume picker resolver, the switched model wins.
    const stored = loadSession(sessionId, CWD);
    expect(stored?.model).toBe('claude-opus-4-8');
    expect(stored?.messages).toHaveLength(4);

    const target = resolveResumeTarget(CWD, sessionId);
    expect(target?.model).toBe('claude-opus-4-8');

    // Mirror main.ts precedence: no --provider/--model flags ⇒ prefer the
    // stored session's (now correct) model rather than the provider default.
    const preferStored = !!target;
    const resolvedModel = preferStored ? target!.model : undefined;
    expect(resolvedModel).toBe('claude-opus-4-8');

    await session.dispose();
  });
});
