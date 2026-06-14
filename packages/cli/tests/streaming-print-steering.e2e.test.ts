import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { AgentSession } from '@harnext/core';
import { createAgentSession } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runStreamingPrintMode } from '../src/modes/print-mode.js';

/**
 * End-to-end headless steering: drives `runStreamingPrintMode` (the
 * `--input-format stream-json` path) with a real AgentSession + a gated fake
 * stream and a live PassThrough stdin. Proves that a user message written
 * *while the agent is generating* is injected as a steering message into the
 * live run — the headless counterpart to the interactive REPL's steering.
 */
const MODEL_ID = 'claude-sonnet-4-6';

const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

function makeAssistant(text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: MODEL_ID,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
  };
}

describe('headless streaming steering (e2e)', () => {
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let harnextHome: string;
  const originalHarnextHome = process.env.HARNEXT_HOME;
  let session: AgentSession;

  // Gating: each requested turn stashes a releaser; the test waits for a turn
  // to start, then releases it to let that turn emit its `done` event.
  let turnsStarted: number;
  let releasers: Array<() => void>;

  function installFakeStream() {
    turnsStarted = 0;
    releasers = [];
    let turn = 0;
    const fakeStreamFn = () => {
      const final = makeAssistant(`reply ${++turn}`);
      let release!: () => void;
      const gate = new Promise<void>((res) => {
        release = res;
      });
      releasers.push(release);
      turnsStarted++;
      return {
        async *[Symbol.asyncIterator]() {
          await gate;
          yield { type: 'done', reason: 'stop', message: final };
        },
        result: async () => final,
      };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.agent.streamFn = fakeStreamFn as any;
  }

  async function waitForTurn(n: number) {
    for (let i = 0; i < 200 && turnsStarted < n; i++) await flush(1);
    if (turnsStarted < n) throw new Error(`turn ${n} never started (got ${turnsStarted})`);
  }
  const releaseTurn = (n: number) => releasers[n - 1]();

  function envelopes(): any[] {
    return writes
      .join('')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  beforeEach(async () => {
    harnextHome = mkdtempSync(join(tmpdir(), 'harnext-stream-steer-'));
    process.env.HARNEXT_HOME = harnextHome;
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    const created = await createAgentSession({
      provider: 'anthropic',
      modelId: MODEL_ID,
      mcpDisabled: true,
      quiet: true,
      compaction: false,
      skills: [],
    });
    session = created.session;
    installFakeStream();
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    try {
      await session.dispose(); // idempotent; the mode already disposed
    } catch {
      /* ignore */
    }
    if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = originalHarnextHome;
    rmSync(harnextHome, { recursive: true, force: true });
  });

  it('steers the live run with a message written mid-generation, then ends on EOF', async () => {
    const input = new PassThrough();
    const done = runStreamingPrintMode(
      session,
      { outputFormat: 'stream-json', cwd: process.cwd(), permissionMode: 'bypassPermissions' },
      input,
    );

    // First message starts the run; turn 1 blocks on its gate (agent busy).
    input.write(userLine('start the task'));
    await waitForTurn(1);

    // A message arriving mid-run is steered into the live run, not a new run.
    input.write(userLine('also handle errors'));
    await flush();
    expect(session.agent.hasQueuedMessages()).toBe(true);

    // Release turn 1 → the loop drains + injects the steer → turn 2 begins.
    releaseTurn(1);
    await waitForTurn(2);
    expect(session.agent.hasQueuedMessages()).toBe(false);

    // Finish, close stdin, and let the mode tear down.
    releaseTurn(2);
    input.end();
    const exitCode = await done;

    // The steered message landed in the real transcript, mid-run, as a user msg.
    const userTexts = session.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    expect(userTexts.some((t) => t.includes('start the task'))).toBe(true);
    expect(userTexts.some((t) => t.includes('also handle errors'))).toBe(true);

    // Envelopes: one init, assistant turns, and a terminal success result.
    const envs = envelopes();
    expect(envs[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(envs.some((e) => e.type === 'assistant')).toBe(true);
    const result = envs.find((e) => e.type === 'result');
    expect(result).toMatchObject({ subtype: 'success', is_error: false });
    expect(exitCode).toBe(0);
  });

  it('treats a message that arrives while idle as the next turn (continues the session)', async () => {
    const input = new PassThrough();
    const done = runStreamingPrintMode(
      session,
      { outputFormat: 'stream-json', cwd: process.cwd() },
      input,
    );

    // First run.
    input.write(userLine('first question'));
    await waitForTurn(1);
    releaseTurn(1);
    await flush(6); // run 1 goes idle, first result emitted

    // A new message after idle starts a second run on the same transcript.
    input.write(userLine('second question'));
    await waitForTurn(2);
    releaseTurn(2);
    input.end();
    const exitCode = await done;

    const results = envelopes().filter((e) => e.type === 'result');
    expect(results).toHaveLength(2); // one result per run
    expect(results.every((r) => r.subtype === 'success')).toBe(true);

    const userTexts = session.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    expect(userTexts.some((t) => t.includes('first question'))).toBe(true);
    expect(userTexts.some((t) => t.includes('second question'))).toBe(true);
    expect(exitCode).toBe(0);
  });
});
