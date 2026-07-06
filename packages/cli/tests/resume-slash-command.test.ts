/**
 * Issue #64: `/resume` must be available inside the interactive REPL, mirroring
 * `harnext --resume`. Unit-tests that the command is registered/matchable, and
 * integration-tests that invoking it seeds the picked session's transcript into
 * the live agent (the picker itself is mocked — it owns raw-mode stdin).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createSessionWriter } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../src/cli/resume.js', () => ({ runResumePicker: vi.fn() }));

import { runResumePicker } from '../src/cli/resume.js';
import { SLASH_COMMANDS, findSlashCommand } from '../src/modes/interactive/interactive-mode.js';

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
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: ts,
  } as AgentMessage;
}

/** Minimal fake agent capturing reset/abort and the seeded message array. */
function fakeCtx() {
  const calls = { aborted: 0, reset: 0 };
  const agent = {
    state: { messages: [] as AgentMessage[] },
    abort: () => {
      calls.aborted++;
    },
    reset: () => {
      calls.reset++;
    },
  };
  return { ctx: { session: { sessionId: 'current-1', agent } }, agent, calls };
}

const resumeCmd = SLASH_COMMANDS.find((c) => c.name === '/resume')!;

describe('/resume slash command registration (issue #64)', () => {
  it('is registered with a description', () => {
    expect(resumeCmd).toBeDefined();
    expect(resumeCmd.description.toLowerCase()).toContain('resume');
  });

  it('matches exactly via findSlashCommand', () => {
    const match = findSlashCommand('/resume');
    expect(match?.cmd.name).toBe('/resume');
    expect(match?.args).toBe('');
  });

  it('does not accept trailing args (plain command)', () => {
    expect(resumeCmd.acceptsArgs).toBeFalsy();
    // With no acceptsArgs, "/resume foo" should not match the command.
    expect(findSlashCommand('/resume foo')).toBeUndefined();
  });
});

describe('/resume action — seeds the picked session', () => {
  let home: string;
  const original = process.env.HARNEXT_HOME;
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-resume-cmd-'));
    process.env.HARNEXT_HOME = home;
    (runResumePicker as Mock).mockReset();
    stdoutSpy.mockClear();
    logSpy.mockClear();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('loads the chosen transcript into the live agent', async () => {
    const cwd = process.cwd();
    const messages = [user('earlier prompt'), assistant('earlier reply')];
    createSessionWriter({ cwd, sessionId: 'prior-session', provider: 'anthropic', model: 'claude-x' }).record(
      messages,
    );
    (runResumePicker as Mock).mockResolvedValue({ sessionId: 'prior-session', cwd, model: 'claude-x' });

    const { ctx, agent, calls } = fakeCtx();
    const keepRunning = await resumeCmd.action(ctx as never, '');

    expect(keepRunning).toBe(true);
    expect(calls.aborted).toBe(1);
    expect(calls.reset).toBe(1);
    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages[0]).toMatchObject({ role: 'user', content: 'earlier prompt' });
    expect(agent.state.messages[1]).toMatchObject({ role: 'assistant' });
  });

  it('does nothing when the picker is cancelled', async () => {
    (runResumePicker as Mock).mockResolvedValue(undefined);
    const { ctx, agent, calls } = fakeCtx();

    const keepRunning = await resumeCmd.action(ctx as never, '');

    expect(keepRunning).toBe(true);
    expect(agent.state.messages).toEqual([]);
    expect(calls.reset).toBe(0);
    expect(calls.aborted).toBe(0);
  });

  it('warns and leaves the agent untouched if the session has no messages', async () => {
    (runResumePicker as Mock).mockResolvedValue({ sessionId: 'missing-session', cwd: process.cwd() });
    const { ctx, agent, calls } = fakeCtx();

    const keepRunning = await resumeCmd.action(ctx as never, '');

    expect(keepRunning).toBe(true);
    expect(agent.state.messages).toEqual([]);
    expect(calls.reset).toBe(0);
  });
});
