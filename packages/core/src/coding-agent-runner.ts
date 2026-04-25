/**
 * Drives an external coding-agent CLI (claude-code, codex) as a one-shot
 * subprocess and maps the result into a shape parallel to the in-process
 * harnext runtime so callers can treat them uniformly.
 *
 * The binary, model flag, and argv shape come from {@link CodingAgentSpec};
 * the spawner is injected so tests can stub it without touching real CLIs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CodingAgentSpec } from './coding-agents.js';

/**
 * Snapshot of a single relevant event emitted during one agent run. We
 * intentionally flatten so a persisted log file is readable without
 * pulling in pi-agent-core types on the reader side.
 */
export interface AgentRunLogEvent {
  ts: string;
  type:
    | 'message_start'
    | 'message_end'
    | 'tool_execution_start'
    | 'tool_execution_end'
    | 'turn_end';
  /** Free-form so we can carry upstream message roles (incl. "toolResult") without a type crosscut. */
  role?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
}

export interface AgentRunResult {
  exit: number;
  durationMs: number;
  output: string;
  error?: string;
  /** Optional structured transcript of the run, when the runner produces one. */
  events?: AgentRunLogEvent[];
}

/**
 * Historical 30-minute cap retained for back-compat with tests that pin
 * to a specific timeout. Not applied by default — concurrency is now
 * handled by GitHub Actions' per-job locking when stages run in
 * workflows, so we no longer enforce a wall-clock kill on the agent
 * subprocess. Callers that genuinely need a ceiling can pass `timeoutMs`
 * explicitly.
 */
export const DEFAULT_EXTERNAL_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunExternalCodingAgentOptions {
  /** Working directory for the spawned process (the worktree path). */
  cwd: string;
  /**
   * Model id passed via the agent's `modelFlag`. Required for external
   * agents — the setup wizard guarantees a value when codingAgent !== 'harnext'.
   */
  modelId: string;
  /**
   * Optional upper bound on the agent's turn count. Forwarded to
   * `claude-code` as `--max-turns <N>`; ignored by agents without an
   * equivalent flag (codex). Setup-time callers (code analysis,
   * workflow generation) should pass a high value so the agent can
   * research the repo thoroughly; runtime pipeline stages should leave
   * it undefined and trust the agent's default.
   */
  maxTurns?: number;
  /**
   * Optional wall-clock SIGTERM deadline for the child. When unset (or
   * zero), the child runs as long as it needs. Tests that exercise the
   * timeout path still pass a small explicit value.
   */
  timeoutMs?: number;
  /** Override for tests. Defaults to node:child_process `spawn`. */
  spawner?: ExternalAgentSpawner;
  /** Abort the run from the outside (e.g. tick-wide cancellation). */
  signal?: AbortSignal;
  /**
   * Invoked for every complete line the agent emits on stdout/stderr,
   * *as it happens*. Lets callers stream agent activity back to the user
   * without waiting for the process to exit. `stream` distinguishes stdout
   * (usually the primary transcript) from stderr (usually progress /
   * warnings). Lines have trailing newlines stripped.
   *
   * Safe to throw from — errors from the callback are swallowed so a
   * misbehaving UI never kills the agent run.
   */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

/** Minimal subset of ChildProcess we need — lets tests stub cleanly. */
export type ExternalAgentSpawner = (
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface BuildExternalAgentArgvOptions {
  /**
   * Upper bound on the agent's turn count. Appended to claude-code as
   * `--max-turns <N>`; ignored for agents without a matching flag.
   * Must be a finite positive integer or it's silently dropped so
   * bad inputs don't fail the whole spawn.
   */
  maxTurns?: number;
}

/** Build the argv for a given external agent. Exported so tests can assert on it. */
export function buildExternalAgentArgv(
  spec: CodingAgentSpec,
  prompt: string,
  modelId: string,
  options: BuildExternalAgentArgvOptions = {},
): { binary: string; args: string[] } {
  if (!spec.binary || !spec.modelFlag) {
    throw new Error(`agent "${spec.id}" is not an external CLI agent`);
  }
  const maxTurns =
    Number.isInteger(options.maxTurns) && (options.maxTurns as number) > 0
      ? (options.maxTurns as number)
      : undefined;
  switch (spec.id) {
    case 'claude-code': {
      // `claude -p "<prompt>" --model <modelId> [--max-turns <N>] --dangerously-skip-permissions`
      const args = ['-p', prompt, spec.modelFlag, modelId];
      if (maxTurns !== undefined) args.push('--max-turns', String(maxTurns));
      args.push('--dangerously-skip-permissions');
      return { binary: spec.binary, args };
    }
    case 'codex':
      // `codex exec --model <modelId> --dangerously-bypass-approvals-and-sandbox "<prompt>"`
      // codex has no equivalent of --max-turns; the flag is silently dropped.
      return {
        binary: spec.binary,
        args: [
          'exec',
          spec.modelFlag,
          modelId,
          '--dangerously-bypass-approvals-and-sandbox',
          prompt,
        ],
      };
    default:
      throw new Error(`no argv mapping for coding agent "${spec.id}"`);
  }
}

/**
 * Run an external coding agent against a prompt and return a uniform
 * result shape. stdout is treated as the agent's assistant output; stderr
 * is folded into `error` when the exit code is non-zero.
 */
export async function runExternalCodingAgent(
  spec: CodingAgentSpec,
  prompt: string,
  opts: RunExternalCodingAgentOptions,
): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const timeoutMs =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
  const spawner = opts.spawner ?? (spawn as unknown as ExternalAgentSpawner);

  const { binary, args } = buildExternalAgentArgv(spec, prompt, opts.modelId, {
    maxTurns: opts.maxTurns,
  });

  return new Promise<AgentRunResult>((resolve) => {
    const ts = () => new Date().toISOString();
    const events: AgentRunLogEvent[] = [
      { ts: ts(), type: 'message_start', role: 'user' },
      { ts: ts(), type: 'message_end', role: 'user', text: prompt },
      { ts: ts(), type: 'message_start', role: 'assistant' },
    ];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawner(binary, args, {
        cwd: opts.cwd,
        env: { ...process.env },
      });
      // Close stdin immediately. claude-code (and some other agents)
      // wait up to a few seconds for stdin data before proceeding when
      // stdin is piped-but-empty, emitting a "no stdin data received"
      // warning on stderr. We pass the prompt via argv, so there's
      // never anything to send — signal EOF right away.
      try {
        child.stdin?.end();
      } catch {
        // best effort; if stdin was already closed, ignore
      }
    } catch (err) {
      resolve({
        exit: 1,
        durationMs: Date.now() - startedAt,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        events,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;

    // `timeoutMs === 0` → no timer at all. We still declare `timer` as
    // optional so the close/error handlers can call `clearTimeout` on it
    // unconditionally; clearTimeout on undefined is a no-op.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, timeoutMs)
        : undefined;

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Buffered capture drives the returned `output`; the line-splitter is
    // a separate per-stream cursor that fires `onLine` for each complete
    // line as it arrives. A partial trailing line is flushed on 'close'.
    const stdoutLineBuf: string[] = [''];
    const stderrLineBuf: string[] = [''];

    const emitLines = (
      buf: { s: string[] },
      stream: 'stdout' | 'stderr',
      chunk: string,
    ) => {
      if (!opts.onLine) return;
      const combined = buf.s[0] + chunk;
      const parts = combined.split('\n');
      buf.s[0] = parts.pop() ?? '';
      for (const line of parts) {
        try {
          opts.onLine(line, stream);
        } catch {
          // never let a UI callback kill the run
        }
      }
    };
    const stdoutCursor = { s: stdoutLineBuf };
    const stderrCursor = { s: stderrLineBuf };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      emitLines(stdoutCursor, 'stdout', chunk.toString('utf-8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      emitLines(stderrCursor, 'stderr', chunk.toString('utf-8'));
    });

    const flushPartial = () => {
      if (!opts.onLine) return;
      if (stdoutCursor.s[0].length > 0) {
        try {
          opts.onLine(stdoutCursor.s[0], 'stdout');
        } catch {
          // ignore
        }
        stdoutCursor.s[0] = '';
      }
      if (stderrCursor.s[0].length > 0) {
        try {
          opts.onLine(stderrCursor.s[0], 'stderr');
        } catch {
          // ignore
        }
        stderrCursor.s[0] = '';
      }
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const output = Buffer.concat(stdoutChunks).toString('utf-8');
      events.push({ ts: ts(), type: 'message_end', role: 'assistant', text: output });
      resolve({
        exit: 1,
        durationMs: Date.now() - startedAt,
        output,
        error: `failed to spawn "${binary}": ${err.message}${stderr ? `\n${stderr}` : ''}`,
        events,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      flushPartial();

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      events.push({ ts: ts(), type: 'message_end', role: 'assistant', text: stdout });

      if (aborted) {
        resolve({
          exit: 1,
          durationMs: Date.now() - startedAt,
          output: stdout,
          error: `${spec.id} run aborted${stderr ? `\n${stderr}` : ''}`,
          events,
        });
        return;
      }
      if (timedOut) {
        resolve({
          exit: 1,
          durationMs: Date.now() - startedAt,
          output: stdout,
          error: `${spec.id} run timed out after ${Math.round(timeoutMs / 1000)}s${stderr ? `\n${stderr}` : ''}`,
          events,
        });
        return;
      }

      const exit = code ?? 1;
      resolve({
        exit,
        durationMs: Date.now() - startedAt,
        output: stdout,
        error: exit !== 0 ? stderr || `${spec.id} exited with code ${exit}` : undefined,
        events,
      });
    });
  });
}
