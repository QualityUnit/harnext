import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  buildExternalAgentArgv,
  runExternalCodingAgent,
  type ExternalAgentSpawner,
} from '../src/coding-agent-runner.js';
import { getCodingAgentSpec } from '../src/coding-agents.js';

/** Build a fake child process that emits the given stdout/stderr/exit shape. */
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  errorBeforeClose?: Error;
  delayMs?: number;
}): ChildProcessWithoutNullStreams & {
  killSignal?: NodeJS.Signals | number;
} {
  const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & {
    killSignal?: NodeJS.Signals | number;
  };
  const stdout = Readable.from(opts.stdout ? [Buffer.from(opts.stdout)] : []);
  const stderr = Readable.from(opts.stderr ? [Buffer.from(opts.stderr)] : []);
  (emitter as unknown as { stdout: Readable }).stdout = stdout;
  (emitter as unknown as { stderr: Readable }).stderr = stderr;
  emitter.kill = ((signal?: NodeJS.Signals | number) => {
    emitter.killSignal = signal;
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];

  const finalize = () => {
    if (opts.errorBeforeClose) {
      emitter.emit('error', opts.errorBeforeClose);
      return;
    }
    emitter.emit('close', opts.exitCode ?? 0);
  };
  if (opts.delayMs && opts.delayMs > 0) {
    setTimeout(finalize, opts.delayMs);
  } else {
    setImmediate(finalize);
  }
  return emitter;
}

describe('buildExternalAgentArgv', () => {
  it('builds claude-code argv with prompt, model, and dangerous-skip-permissions', () => {
    const spec = getCodingAgentSpec('claude-code');
    const argv = buildExternalAgentArgv(spec, 'hello', 'claude-sonnet-4-6');
    expect(argv.binary).toBe('claude');
    expect(argv.args).toEqual([
      '-p',
      'hello',
      '--model',
      'claude-sonnet-4-6',
      '--dangerously-skip-permissions',
    ]);
  });

  it('builds codex argv with exec, model, and bypass flag', () => {
    const spec = getCodingAgentSpec('codex');
    const argv = buildExternalAgentArgv(spec, 'hello', 'gpt-5.4');
    expect(argv.binary).toBe('codex');
    expect(argv.args).toEqual([
      'exec',
      '--model',
      'gpt-5.4',
      '--dangerously-bypass-approvals-and-sandbox',
      'hello',
    ]);
  });

  it('throws for harnext (no external binary)', () => {
    expect(() => buildExternalAgentArgv(getCodingAgentSpec('harnext'), 'hi', 'm')).toThrow();
  });

  it('appends --max-turns to claude-code argv when maxTurns is provided', () => {
    const spec = getCodingAgentSpec('claude-code');
    const argv = buildExternalAgentArgv(spec, 'hello', 'claude-sonnet-4-6', {
      maxTurns: 150,
    });
    expect(argv.args).toEqual([
      '-p',
      'hello',
      '--model',
      'claude-sonnet-4-6',
      '--max-turns',
      '150',
      '--dangerously-skip-permissions',
    ]);
  });

  it('drops invalid maxTurns values silently (zero, NaN, negative, non-integer)', () => {
    // A bad maxTurns value must not break the spawn. Guarding it here
    // (rather than throwing) means a misconfigured caller still gets a
    // working claude-code run with the agent's default budget.
    const spec = getCodingAgentSpec('claude-code');
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const argv = buildExternalAgentArgv(spec, 'hi', 'm', { maxTurns: bad });
      expect(argv.args).not.toContain('--max-turns');
    }
  });

  it('ignores maxTurns for codex (no equivalent flag)', () => {
    const spec = getCodingAgentSpec('codex');
    const argv = buildExternalAgentArgv(spec, 'hello', 'gpt-5.4', { maxTurns: 150 });
    // Codex argv stays exactly as before — no --max-turns, no silent
    // injection of a claude-style flag.
    expect(argv.args).toEqual([
      'exec',
      '--model',
      'gpt-5.4',
      '--dangerously-bypass-approvals-and-sandbox',
      'hello',
    ]);
  });
});

describe('runExternalCodingAgent', () => {
  const claude = getCodingAgentSpec('claude-code');

  it('returns stdout as output on exit 0', async () => {
    let capturedBinary = '';
    let capturedArgs: string[] = [];
    let capturedCwd = '';
    const spawner: ExternalAgentSpawner = (binary, args, options) => {
      capturedBinary = binary;
      capturedArgs = [...args];
      capturedCwd = options.cwd;
      return makeFakeChild({ stdout: 'all done', exitCode: 0 });
    };
    const result = await runExternalCodingAgent(claude, 'do the thing', {
      cwd: '/tmp/wt',
      modelId: 'claude-sonnet-4-6',
      spawner,
    });
    expect(capturedBinary).toBe('claude');
    expect(capturedArgs[0]).toBe('-p');
    expect(capturedArgs[1]).toBe('do the thing');
    expect(capturedCwd).toBe('/tmp/wt');
    expect(result.exit).toBe(0);
    expect(result.output).toBe('all done');
    expect(result.error).toBeUndefined();
    // Events carry the prompt + assistant output so the run log is reconstructible.
    const end = result.events?.find((e) => e.type === 'message_end' && e.role === 'assistant');
    expect(end?.text).toBe('all done');
  });

  it('returns stderr as error on non-zero exit', async () => {
    const spawner: ExternalAgentSpawner = () =>
      makeFakeChild({ stdout: '', stderr: 'boom', exitCode: 2 });
    const result = await runExternalCodingAgent(claude, 'p', {
      cwd: '/tmp',
      modelId: 'm',
      spawner,
    });
    expect(result.exit).toBe(2);
    expect(result.error).toContain('boom');
  });

  it('handles ENOENT-style spawn errors', async () => {
    const spawner: ExternalAgentSpawner = () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    };
    const result = await runExternalCodingAgent(claude, 'p', {
      cwd: '/tmp',
      modelId: 'm',
      spawner,
    });
    expect(result.exit).toBe(1);
    expect(result.error).toMatch(/ENOENT/);
  });

  it('captures child error events', async () => {
    const spawner: ExternalAgentSpawner = () =>
      makeFakeChild({ errorBeforeClose: new Error('pipe closed') });
    const result = await runExternalCodingAgent(claude, 'p', {
      cwd: '/tmp',
      modelId: 'm',
      spawner,
    });
    expect(result.exit).toBe(1);
    expect(result.error).toContain('pipe closed');
  });

  it('kills the child and reports timeout when timeoutMs elapses', async () => {
    let killedWith: NodeJS.Signals | number | undefined;
    const spawner: ExternalAgentSpawner = () => {
      const child = makeFakeChild({ exitCode: 0, delayMs: 200 });
      const originalKill = child.kill;
      child.kill = ((signal?: NodeJS.Signals | number) => {
        killedWith = signal;
        // Finalize the child as if SIGTERM caused an immediate exit.
        setImmediate(() => (child as unknown as EventEmitter).emit('close', 143));
        return originalKill.call(child, signal);
      }) as ChildProcessWithoutNullStreams['kill'];
      return child;
    };
    const result = await runExternalCodingAgent(claude, 'p', {
      cwd: '/tmp',
      modelId: 'm',
      spawner,
      timeoutMs: 20,
    });
    expect(killedWith).toBe('SIGTERM');
    expect(result.exit).toBe(1);
    expect(result.error).toMatch(/timed out/);
  });

  it('does NOT kill the child when timeoutMs is unset (lock is the serializer)', async () => {
    // Regression: flowhunt's verify tick ran for ~30 min, hit the old
    // 30-min default cap, got SIGTERM'd after it had already posted the
    // PASS comment, and the resulting exit=1 prevented the label
    // transition. Fix: timeout is opt-in now — no `timeoutMs` ⇒ no
    // timer. The poller's lockfile prevents overlapping ticks from
    // running concurrently, so we don't need a wall-clock kill to
    // enforce mutual exclusion.
    let killCount = 0;
    const spawner: ExternalAgentSpawner = () => {
      const child = makeFakeChild({ stdout: 'done', exitCode: 0, delayMs: 40 });
      const originalKill = child.kill;
      child.kill = ((signal?: NodeJS.Signals | number) => {
        killCount += 1;
        return originalKill.call(child, signal);
      }) as ChildProcessWithoutNullStreams['kill'];
      return child;
    };
    const result = await runExternalCodingAgent(claude, 'p', {
      cwd: '/tmp',
      modelId: 'm',
      spawner,
      // timeoutMs intentionally omitted
    });
    expect(result.exit).toBe(0);
    expect(result.error).toBeUndefined();
    expect(killCount).toBe(0);
  });

  it('treats timeoutMs=0 as disabled (same as unset)', async () => {
    let killCount = 0;
    const spawner: ExternalAgentSpawner = () => {
      const child = makeFakeChild({ stdout: 'done', exitCode: 0, delayMs: 40 });
      const originalKill = child.kill;
      child.kill = ((signal?: NodeJS.Signals | number) => {
        killCount += 1;
        return originalKill.call(child, signal);
      }) as ChildProcessWithoutNullStreams['kill'];
      return child;
    };
    const result = await runExternalCodingAgent(claude, 'p', {
      cwd: '/tmp',
      modelId: 'm',
      spawner,
      timeoutMs: 0,
    });
    expect(result.exit).toBe(0);
    expect(killCount).toBe(0);
  });
});
