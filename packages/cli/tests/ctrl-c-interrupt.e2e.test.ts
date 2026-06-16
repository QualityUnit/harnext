import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSession } from '@harnext/core';
import { createAgentSession } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInteractiveMode } from '../src/modes/interactive/interactive-mode.js';

/**
 * End-to-end (real REPL + agent loop) for issue #71: while the agent is
 * generating, the first Ctrl+C interrupts the run (the conversation stays
 * open); a second Ctrl+C exits. A gated fake stream keeps the agent "busy" so
 * the interrupt has something to abort.
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

describe('Ctrl+C interrupt-first (e2e through the REPL + agent loop)', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalColumns: number | undefined;
  let originalRows: number | undefined;
  let harnextHome: string;
  const originalHarnextHome = process.env.HARNEXT_HOME;
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

  beforeEach(async () => {
    harnextHome = mkdtempSync(join(tmpdir(), 'harnext-ctrlc-e2e-'));
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
      skills: [],
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

  it('first Ctrl+C interrupts the run and stays in the conversation; second exits', async () => {
    const done = runInteractiveMode(session, { provider: 'anthropic', model: MODEL_ID });

    type(stdin, 'start a long task');
    press(stdin, 'return');
    await waitForTurn(1);

    // First Ctrl+C → interrupt the in-flight run; the REPL must NOT exit.
    const beforeInterrupt = writes.length;
    press(stdin, 'c', { ctrl: true });
    await flush();
    const afterInterrupt = stripAnsi(writes.slice(beforeInterrupt).join(''));
    expect(afterInterrupt).toContain('Interrupted'); // run aborted
    expect(afterInterrupt.toLowerCase()).toContain('press ctrl+c again to exit');

    // The conversation is still alive: the run-mode promise hasn't resolved.
    let exited = false;
    void done.then(() => {
      exited = true;
    });
    await flush(6);
    expect(exited).toBe(false);

    // Second Ctrl+C (within the window) exits cleanly.
    press(stdin, 'c', { ctrl: true });
    await done; // resolves → REPL exited
    expect(exited).toBe(true);
  });
});
