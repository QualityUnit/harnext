import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSession } from '@harnext/core';
import { createAgentSession } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInteractiveMode } from '../src/modes/interactive/interactive-mode.js';

/**
 * End-to-end /loop: drives the *whole* interactive REPL — a real AgentSession
 * (gated fake stream), the real sticky textarea over a fake TTY, and the real
 * 1s loop ticker — and asserts the core UX: a `/loop` started in-session wakes
 * the agent *visibly in the same conversation*, then can be stopped with Esc.
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

describe('/loop (e2e through the real REPL + 1s ticker)', () => {
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

  // Real-time wait so the 1s loop ticker can actually fire.
  async function waitForTurnRealtime(n: number, timeoutMs = 3000) {
    const start = Date.now();
    while (turnsStarted < n && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (turnsStarted < n) throw new Error(`turn ${n} never started (got ${turnsStarted})`);
  }
  function releaseTurn(n: number) {
    releasers[n - 1]();
  }

  beforeEach(async () => {
    harnextHome = mkdtempSync(join(tmpdir(), 'harnext-loop-e2e-'));
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

  it('wakes the agent in-session on a fixed loop, then stops on Esc', async () => {
    const done = runInteractiveMode(session, { provider: 'anthropic', model: MODEL_ID });

    // Start a fixed loop. The first tick is due immediately; the ticker fires it
    // on its next pass (~1s) as a visible turn — no user keystroke involved.
    const beforeStart = writes.length;
    type(stdin, '/loop 5s run the check');
    press(stdin, 'return');
    await flush();
    const startFrame = stripAnsi(writes.slice(beforeStart).join(''));
    expect(startFrame).toContain('loop started');
    expect(startFrame).toContain('every 5s'); // fixed cadence

    // The ticker fires turn 1 on its own.
    const beforeTick = writes.length;
    await waitForTurnRealtime(1);
    const tickFrame = stripAnsi(writes.slice(beforeTick).join(''));
    expect(tickFrame).toContain('loop tick #1'); // the wake-up header, in this session

    // Let the tick complete; fixed mode reschedules and says when.
    releaseTurn(1);
    await flush(8);
    const afterTick = stripAnsi(writes.slice(beforeTick).join(''));
    expect(afterTick).toContain('next wake in');

    // The looped prompt landed in the *same* conversation as a real user turn.
    const userTexts = session.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    expect(userTexts.some((t) => t.includes('run the check'))).toBe(true);

    // Esc on the empty prompt stops the loop.
    const beforeStop = writes.length;
    press(stdin, 'escape');
    await flush();
    const stopFrame = stripAnsi(writes.slice(beforeStop).join(''));
    expect(stopFrame).toContain('loop stopped');

    press(stdin, 'd', { ctrl: true });
    await done;
  });

  it('registers the always-on `loop` tool, and the agent can start a loop with it', async () => {
    const done = runInteractiveMode(session, { provider: 'anthropic', model: MODEL_ID });
    await flush();

    const loopTool = session.agent.state.tools.find((t) => t.name === 'loop');
    expect(loopTool).toBeDefined();

    // Drive the tool the way the agent would: start a fixed loop.
    const beforeStart = writes.length;
    const res = await loopTool!.execute('id', {
      command: 'start',
      interval: '5s',
      prompt: 'reply with only the word TICK',
    });
    expect((res.details as { ok: boolean }).ok).toBe(true);
    const startFrame = stripAnsi(writes.slice(beforeStart).join(''));
    expect(startFrame).toContain('loop started'); // the user sees it in-session

    // The agent-initiated loop wakes the agent on the next idle tick.
    await waitForTurnRealtime(1);
    releaseTurn(1);
    await flush(8);

    // status via the tool reflects the live loop.
    const status = await loopTool!.execute('id', { command: 'status' });
    expect(status.content[0].text.toLowerCase()).toContain('loop');

    // stop via the tool.
    const stop = await loopTool!.execute('id', { command: 'stop' });
    expect((stop.details as { ok: boolean }).ok).toBe(true);

    press(stdin, 'd', { ctrl: true });
    await done;
  });

  it('exposes schedule_wakeup/end_loop only while a self-paced loop runs', async () => {
    const done = runInteractiveMode(session, { provider: 'anthropic', model: MODEL_ID });

    const toolNames = () => session.agent.state.tools.map((t) => t.name);
    expect(toolNames()).not.toContain('schedule_wakeup');

    // Self-paced loop (no interval) → the scheduling tools appear.
    type(stdin, '/loop keep watching CI');
    press(stdin, 'return');
    await flush();
    expect(toolNames()).toContain('schedule_wakeup');
    expect(toolNames()).toContain('end_loop');

    // Drive its first (gated) tick. With the fake stream the model never calls
    // schedule_wakeup, so the dynamic loop finishes implicitly after one tick —
    // and the scheduling tools are torn back off the live tool list.
    const beforeTick = writes.length;
    await waitForTurnRealtime(1);
    releaseTurn(1);
    await flush(8);
    const afterTick = stripAnsi(writes.slice(beforeTick).join(''));
    expect(afterTick).toContain('loop ended');
    expect(toolNames()).not.toContain('schedule_wakeup');
    expect(toolNames()).not.toContain('end_loop');

    press(stdin, 'd', { ctrl: true });
    await done;
  });
});
