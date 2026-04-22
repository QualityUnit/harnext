/**
 * Drives an external coding-agent CLI (claude-code, codex) as a one-shot
 * subprocess and maps the result into the shape the GitHub poller already
 * expects from the in-process harnext runtime.
 *
 * The binary, model flag, and argv shape come from {@link CodingAgentSpec};
 * the spawner is injected so tests can stub it without touching real CLIs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CodingAgentSpec } from './coding-agents.js';
import type { AgentRunLogEvent, AgentRunResult } from './github-poller.js';

/** 30 minutes — long enough for implementer stages, short enough to catch hangs. */
export const DEFAULT_EXTERNAL_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunExternalCodingAgentOptions {
  /** Working directory for the spawned process (the worktree path). */
  cwd: string;
  /**
   * Model id passed via the agent's `modelFlag`. Required for external
   * agents — the setup wizard guarantees a value when codingAgent !== 'harnext'.
   */
  modelId: string;
  /** Defaults to {@link DEFAULT_EXTERNAL_AGENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Override for tests. Defaults to node:child_process `spawn`. */
  spawner?: ExternalAgentSpawner;
  /** Abort the run from the outside (e.g. tick-wide cancellation). */
  signal?: AbortSignal;
}

/** Minimal subset of ChildProcess we need — lets tests stub cleanly. */
export type ExternalAgentSpawner = (
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

/** Build the argv for a given external agent. Exported so tests can assert on it. */
export function buildExternalAgentArgv(
  spec: CodingAgentSpec,
  prompt: string,
  modelId: string,
): { binary: string; args: string[] } {
  if (!spec.binary || !spec.modelFlag) {
    throw new Error(`agent "${spec.id}" is not an external CLI agent`);
  }
  switch (spec.id) {
    case 'claude-code':
      // `claude -p "<prompt>" --model <modelId> --dangerously-skip-permissions`
      return {
        binary: spec.binary,
        args: ['-p', prompt, spec.modelFlag, modelId, '--dangerously-skip-permissions'],
      };
    case 'codex':
      // `codex exec --model <modelId> --dangerously-bypass-approvals-and-sandbox "<prompt>"`
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
 * Run an external coding agent against a prompt and return the poller-shaped
 * result. stdout is treated as the agent's assistant output; stderr is
 * folded into `error` when the exit code is non-zero.
 */
export async function runExternalCodingAgent(
  spec: CodingAgentSpec,
  prompt: string,
  opts: RunExternalCodingAgentOptions,
): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXTERNAL_AGENT_TIMEOUT_MS;
  const spawner = opts.spawner ?? (spawn as unknown as ExternalAgentSpawner);

  const { binary, args } = buildExternalAgentArgv(spec, prompt, opts.modelId);

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

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

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

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

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
