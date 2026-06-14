import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSession } from '../src/agent-session.js';
import { BackgroundShellManager, type BackgroundShell } from '../src/background-shells.js';
import {
  HostCommandExecutor,
  type ChildProcessLike,
  type CommandExecutor,
  type ExecutorSpawnOptions,
} from '../src/command-executor.js';
import { createBashTool } from '../src/tools/bash.js';

// A real directory the host executor can spawn into.
const cwd = process.cwd();

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

/** A fully synthetic child that emits `output` then closes with `code`. */
function fakeChild(output: string, code = 0): ChildProcessLike {
  const emitter = new EventEmitter();
  const stdout = Readable.from(output ? [Buffer.from(output)] : []);
  const stderr = Readable.from([]);
  let endedStreams = 0;
  const maybeClose = () => {
    if (++endedStreams === 2) setImmediate(() => emitter.emit('close', code));
  };
  stdout.on('end', maybeClose);
  stderr.on('end', maybeClose);
  return {
    stdout,
    stderr,
    pid: 4242,
    kill: () => true,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      emitter.on(event, cb);
      return undefined;
    },
  };
}

/** Records every spawn so tests can assert on routing, cwd, and env. */
class RecordingExecutor implements CommandExecutor {
  calls: Array<{ command: string; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  disposed = 0;
  constructor(
    private readonly output = '',
    private readonly code = 0,
  ) {}
  spawn(command: string, opts: ExecutorSpawnOptions): ChildProcessLike {
    this.calls.push({ command, cwd: opts.cwd, env: opts.env });
    return fakeChild(this.output, this.code);
  }
  dispose(): void {
    this.disposed++;
  }
}

/** Drain a child's stdout/stderr into a single string. */
function collect(child: ChildProcessLike): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function waitForExit(mgr: BackgroundShellManager, id: string, timeoutMs = 8000): Promise<BackgroundShell> {
  return new Promise((resolve, reject) => {
    const current = mgr.get(id);
    if (current && current.status !== 'running') {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${id}`));
    }, timeoutMs);
    const off = mgr.on('exit', (shell) => {
      if (shell.id !== id) return;
      clearTimeout(timer);
      off();
      resolve(shell);
    });
  });
}

describe('bash routes through the injected executor', () => {
  it('runs foreground commands via the executor using execCwd and host-env-free spawn', async () => {
    const exec = new RecordingExecutor('hello-from-executor\n');
    const bash = createBashTool('/host/path', { executor: exec, execCwd: '/work' });
    const result = await bash.execute('1', { command: 'echo hi' });

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].command).toBe('echo hi');
    // The executor's working dir is execCwd (the container path), not the host
    // file-tool cwd.
    expect(exec.calls[0].cwd).toBe('/work');
    // bash does not force the host env onto the executor — the executor owns it.
    expect(exec.calls[0].env).toBeUndefined();
    expect(textOf(result)).toContain('hello-from-executor');
  });

  it('falls back to cwd for execution when execCwd is unset', async () => {
    const exec = new RecordingExecutor();
    const bash = createBashTool('/host/path', { executor: exec });
    await bash.execute('1', { command: 'true' });
    expect(exec.calls[0].cwd).toBe('/host/path');
  });

  it('surfaces a non-zero exit from the executor', async () => {
    const exec = new RecordingExecutor('boom\n', 2);
    const bash = createBashTool(cwd, { executor: exec });
    await expect(bash.execute('1', { command: 'false' })).rejects.toThrow('exited with code 2');
  });
});

describe('BackgroundShellManager routes through the injected executor', () => {
  const original = process.env.HARNEXT_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-exec-'));
    process.env.HARNEXT_HOME = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('starts background shells through the executor with execCwd', async () => {
    const exec = new RecordingExecutor('bg-line\n');
    const mgr = new BackgroundShellManager(cwd, { executor: exec, execCwd: '/work' });
    const shell = mgr.start('echo bg');

    expect(exec.calls[0].command).toBe('echo bg');
    expect(exec.calls[0].cwd).toBe('/work');

    const finished = await waitForExit(mgr, shell.id);
    expect(finished.status).toBe('completed');
    expect(mgr.readOutput(shell.id)?.newOutput).toContain('bg-line');
    mgr.disposeAll();
  });

  it('records a failed shell when the executor throws synchronously', async () => {
    const throwing: CommandExecutor = {
      spawn() {
        throw new Error('sandbox unavailable');
      },
    };
    const mgr = new BackgroundShellManager(cwd, { executor: throwing });
    const shell = mgr.start('echo nope');
    expect(shell.status).toBe('failed');
    expect(mgr.readOutput(shell.id)?.newOutput).toContain('sandbox unavailable');
    mgr.disposeAll();
  });
});

describe('HostCommandExecutor (default behavior)', () => {
  it('runs a real command through the host shell', async () => {
    const result = await createBashTool(cwd).execute('1', { command: 'echo real-host' });
    expect(textOf(result)).toContain('real-host');
  });

  it('rejects when the working directory does not exist', async () => {
    const bash = createBashTool('/no/such/dir/definitely-missing');
    await expect(bash.execute('1', { command: 'echo x' })).rejects.toThrow(
      'Working directory does not exist',
    );
  });

  it('aborting a foreground command kills it via the executor', async () => {
    const bash = createBashTool(cwd);
    const ac = new AbortController();
    const p = bash.execute('1', { command: 'sleep 30' }, ac.signal);
    setImmediate(() => ac.abort());
    await expect(p).rejects.toThrow('Command aborted');
  });

  it('defaults to the host env when no env is supplied', async () => {
    process.env.HARNEXT_EXEC_TEST_PASS = 'present';
    try {
      const child = new HostCommandExecutor().spawn('printf "%s" "$HARNEXT_EXEC_TEST_PASS"', {
        cwd,
      });
      expect(await collect(child)).toBe('present');
    } finally {
      delete process.env.HARNEXT_EXEC_TEST_PASS;
    }
  });

  it('does not leak host env when an explicit env is supplied', async () => {
    process.env.HARNEXT_EXEC_TEST_LEAK = 'leaked';
    try {
      const child = new HostCommandExecutor().spawn(
        'printf "%s" "${HARNEXT_EXEC_TEST_LEAK:-clean}"',
        { cwd, env: { PATH: process.env.PATH } },
      );
      // The host var is invisible because the caller-supplied env replaced it.
      expect(await collect(child)).toBe('clean');
    } finally {
      delete process.env.HARNEXT_EXEC_TEST_LEAK;
    }
  });
});

describe('AgentSession.dispose tears down the executor', () => {
  it('awaits executor.dispose()', async () => {
    const exec = new RecordingExecutor();
    const session = new AgentSession({} as never, {
      model: {} as never,
      systemPrompt: '',
      tools: [],
      thinkingLevel: 'off',
      skills: [],
      executor: exec,
    });
    await session.dispose();
    expect(exec.disposed).toBe(1);
  });
});
