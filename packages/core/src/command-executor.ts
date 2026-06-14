import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';

/**
 * Minimal child-process surface the `bash` tool and `BackgroundShellManager`
 * depend on. Decoupling the tools from `node:child_process` lets a caller route
 * command execution somewhere other than the host — e.g. `docker exec` into a
 * per-worktree sandbox — without re-implementing truncation, timeout, abort,
 * streaming, or background semantics. Mirrors the `ExternalAgentSpawner` seam in
 * `coding-agent-runner.ts`.
 */
export interface ChildProcessLike {
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export interface ExecutorSpawnOptions {
  /**
   * Directory the command runs in. For the default host executor this is a real
   * filesystem path. A sandbox executor may treat it as a container-side path
   * (the bind-mount target) — distinct from the host path the `read`/`edit`/
   * `write` tools use. See `execCwd` on `CreateAgentSessionOptions`.
   */
  cwd: string;
  /**
   * Environment for the child. When omitted the executor owns construction: the
   * host executor falls back to `process.env`; a sandbox executor should build a
   * clean environment so the host's does not leak into the container.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Abort the running command. The executor is responsible for killing its
   * process when the signal fires (it knows how — a host SIGTERM, a
   * `docker exec` kill, etc.).
   */
  signal?: AbortSignal;
}

/**
 * Where shell commands execute. Inject via `createAgentSession({ executor })`
 * to sandbox execution while keeping `read`/`edit`/`write` on the host. Both the
 * `bash` tool (foreground) and `BackgroundShellManager` (background) route
 * through the same executor, so a single implementation covers every command.
 */
export interface CommandExecutor {
  /** Run `command`, returning a process-like handle. */
  spawn(command: string, opts: ExecutorSpawnOptions): ChildProcessLike;
  /**
   * Optional teardown, awaited from `AgentSession.dispose()`. Lets a sandbox
   * executor stop/remove its container (or otherwise release resources)
   * deterministically when the session ends.
   */
  dispose?(): void | Promise<void>;
}

function getShellConfig(): { shell: string; args: string[] } {
  const shell = process.env.SHELL || '/bin/bash';
  return { shell, args: ['-c'] };
}

/**
 * Default executor: runs `command` through the host shell with
 * `node:child_process.spawn`, reproducing harnext's pre-executor behavior
 * exactly — host `process.env`, `$SHELL -c <command>`, piped stdio, and SIGTERM
 * on abort. Stateless, so the shared {@link hostCommandExecutor} instance is
 * safe to reuse across sessions.
 */
export class HostCommandExecutor implements CommandExecutor {
  spawn(command: string, opts: ExecutorSpawnOptions): ChildProcessLike {
    if (!existsSync(opts.cwd)) {
      throw new Error(`Working directory does not exist: ${opts.cwd}`);
    }
    const { shell, args } = getShellConfig();
    const child = spawn(shell, [...args, command], {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (opts.signal) {
      const signal = opts.signal;
      const onAbort = () => child.kill('SIGTERM');
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', () => signal.removeEventListener('abort', onAbort));
      }
    }

    return child;
  }
}

/** Shared default executor instance — stateless, reusable across sessions. */
export const hostCommandExecutor: CommandExecutor = new HostCommandExecutor();
