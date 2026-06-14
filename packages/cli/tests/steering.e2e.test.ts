import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSession } from '@harnext/core';
import { createAgentSession } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInteractiveMode } from '../src/modes/interactive/interactive-mode.js';

/**
 * End-to-end steering: drives the *whole* interactive REPL — a real
 * AgentSession (with a gated fake stream so we can freeze the agent mid-run),
 * the real sticky textarea over a fake TTY, and the real pi-agent-core loop —
 * and asserts the gray-queue → commit-on-injection → esc-to-edit flow that the
 * feature is built on. The fake stream lets a turn block until the test
 * releases it, which is the only way to submit a steering message while the
 * agent is genuinely "busy".
 */
type FakeStdin = EventEmitter & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode: (v: boolean) => void;
  resume: () => void;
  unref: () => void;
};

function makeFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.unref = () => {};
  return stdin;
}

function type(stdin: FakeStdin, text: string) {
  for (const ch of text) stdin.emit('keypress', ch, { name: ch, sequence: ch });
}
function press(stdin: FakeStdin, name: string, opts: { ctrl?: boolean } = {}) {
  stdin.emit('keypress', undefined, { name, ...opts });
}
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

const MODEL_ID = 'claude-sonnet-4-6';

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

describe('steering (e2e through the real REPL + agent loop)', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalColumns: number | undefined;
  let originalRows: number | undefined;
  let harnextHome: string;
  const originalHarnextHome = process.env.HARNEXT_HOME;

  // Gating: each turn the fake stream is asked for, we stash a releaser; the
  // test waits until the turn has started, then releases it to let that turn
  // produce its `done` event.
  let turnsStarted: number;
  let releasers: Array<() => void>;
  let session: AgentSession;

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
  function releaseTurn(n: number) {
    releasers[n - 1]();
  }

  beforeEach(async () => {
    harnextHome = mkdtempSync(join(tmpdir(), 'harnext-steer-e2e-'));
    process.env.HARNEXT_HOME = harnextHome;

    originalStdin = process.stdin;
    stdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });

    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    originalColumns = process.stdout.columns;
    originalRows = process.stdout.rows;
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });

    const created = await createAgentSession({
      provider: 'anthropic',
      modelId: MODEL_ID,
      mcpDisabled: true,
      quiet: true,
      compaction: false,
      skills: [], // skip seed/discovery — keeps the session minimal & isolated
    });
    session = created.session;
    installFakeStream();
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true });
    await session.dispose();
    if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = originalHarnextHome;
    rmSync(harnextHome, { recursive: true, force: true });
  });

  it('queues a mid-run submit as a gray line, then commits it when the agent injects it', async () => {
    const done = runInteractiveMode(session, { provider: 'anthropic', model: MODEL_ID });

    // Start a run; turn 1 blocks on its gate, so the agent stays busy.
    type(stdin, 'start the task');
    press(stdin, 'return');
    await waitForTurn(1);

    // Submit while busy → queued (gray), NOT committed to the scrollback yet.
    const beforeQueue = writes.length;
    type(stdin, 'also handle errors');
    press(stdin, 'return');
    await flush();
    const queuedFrame = stripAnsi(writes.slice(beforeQueue).join(''));
    expect(queuedFrame).toContain('⋯'); // gray "queued" marker
    expect(queuedFrame).toContain('also handle errors');
    expect(queuedFrame).toContain('esc to edit');
    // Pending, not yet part of the transcript: no committed user echo for it.
    expect(queuedFrame).not.toContain('❯ also handle errors');
    expect(session.agent.hasQueuedMessages()).toBe(true);

    // Let turn 1 finish: the loop drains the steer, injects it (commit), and
    // begins turn 2 (which blocks on its own gate).
    const beforeCommit = writes.length;
    releaseTurn(1);
    await waitForTurn(2);
    const committed = stripAnsi(writes.slice(beforeCommit).join(''));
    expect(committed).toContain('❯ also handle errors'); // now a real user message
    expect(session.agent.hasQueuedMessages()).toBe(false); // drained from the queue

    // Finish the run and exit cleanly.
    releaseTurn(2);
    await flush(8);
    press(stdin, 'c', { ctrl: true });
    await done;

    // The injected steer landed in the real transcript as a user message.
    const userTexts = session.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    expect(userTexts.some((t) => t.includes('also handle errors'))).toBe(true);
  });

  it('Esc peels a queued steer back into the input for editing, then re-queues the edit', async () => {
    const done = runInteractiveMode(session, { provider: 'anthropic', model: MODEL_ID });

    type(stdin, 'start the task');
    press(stdin, 'return');
    await waitForTurn(1);

    // Queue a steer, then Esc on the (now empty) input to pull it back.
    type(stdin, 'also handle errors');
    press(stdin, 'return');
    await flush();
    expect(session.agent.hasQueuedMessages()).toBe(true);

    const beforeEsc = writes.length;
    press(stdin, 'escape');
    await flush();
    const afterEsc = stripAnsi(writes.slice(beforeEsc).join(''));
    // Dequeued: runtime queue cleared and the text is back in the input line.
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(afterEsc).toContain('also handle errors');

    // Edit the recalled text and submit it again → re-queued as a fresh steer.
    type(stdin, ' urgently');
    const beforeRequeue = writes.length;
    press(stdin, 'return');
    await flush();
    const requeued = stripAnsi(writes.slice(beforeRequeue).join(''));
    expect(requeued).toContain('⋯');
    expect(requeued).toContain('also handle errors urgently');
    expect(session.agent.hasQueuedMessages()).toBe(true);

    // Drain it and exit.
    releaseTurn(1);
    await waitForTurn(2);
    releaseTurn(2);
    await flush(8);
    press(stdin, 'c', { ctrl: true });
    await done;
  });
});
