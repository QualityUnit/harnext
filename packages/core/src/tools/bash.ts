import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';
import type { BackgroundShellManager } from '../background-shells.js';
import {
  hostCommandExecutor,
  type ChildProcessLike,
  type CommandExecutor,
} from '../command-executor.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from './truncate.js';

const bashSchema = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        'Run the command in the background and return immediately with a shell id ' +
        'instead of blocking. Use for long-running processes (dev servers, watch ' +
        'builds, long installs/tests). Poll output with the bash_output tool and stop ' +
        'it with kill_shell. Do not background quick commands.',
    }),
  ),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  exitCode: number | null;
  /** Set when the command was started in the background; the shell id to poll. */
  backgroundId?: string;
}

export interface BashToolOptions {
  /** Where commands run. Defaults to the host shell executor. */
  executor?: CommandExecutor;
  /**
   * Manager for `run_in_background` shells. Omit to disable backgrounding — the
   * tool then refuses background requests with an explanation rather than
   * silently running them in the (blocking) foreground.
   */
  backgroundShells?: BackgroundShellManager;
  /**
   * Directory the executor runs commands in, when it differs from the file-tool
   * `cwd` — e.g. a container bind-mount target. Defaults to `cwd`.
   */
  execCwd?: string;
}

export function createBashTool(
  cwd: string,
  options: BashToolOptions = {},
): AgentTool<typeof bashSchema, BashToolDetails> {
  const executor = options.executor ?? hostCommandExecutor;
  const backgroundShells = options.backgroundShells;
  const execCwd = options.execCwd ?? cwd;
  return {
    name: 'bash',
    label: 'bash',
    description: `Execute a bash command in the working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Set run_in_background to start a long-running process (dev server, watch build) without blocking; it returns a shell id you poll with bash_output and stop with kill_shell.`,
    parameters: bashSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const { command, timeout, run_in_background } = params;

      // Background path: hand the command to the session-scoped manager and
      // return immediately. When backgrounding is unavailable, say so rather
      // than silently degrading to a blocking foreground run — that is the worst
      // outcome for the long-running commands background mode exists for.
      if (run_in_background) {
        if (!backgroundShells) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Background execution is not available in this session (it may be ' +
                  'disabled via HARNEXT_DISABLE_BACKGROUND_TASKS=1). The command was NOT ' +
                  'run. Re-issue it without run_in_background to run it in the foreground ' +
                  '(use a timeout for long-running processes).',
              },
            ],
            details: { exitCode: null },
          };
        }
        const shell = backgroundShells.start(command);
        return {
          content: [
            {
              type: 'text',
              text:
                `Started background shell \`${shell.id}\`` +
                (shell.pid !== undefined ? ` (pid ${shell.pid})` : '') +
                `.\nUse the bash_output tool with bash_id "${shell.id}" to read its ` +
                `output, and kill_shell to stop it.`,
            },
          ],
          details: { exitCode: null, backgroundId: shell.id },
        };
      }

      if (onUpdate) {
        onUpdate({ content: [], details: { exitCode: null } });
      }
      return new Promise((resolve, reject) => {
        // The executor owns cwd validation, env construction, the shell
        // invocation, and killing on abort. A synchronous failure here (e.g.
        // the host executor's missing-cwd guard) rejects the call.
        let child: ChildProcessLike;
        try {
          child = executor.spawn(command, { cwd: execCwd, signal });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, timeout * 1000);
        }

        const chunks: Buffer[] = [];

        const handleData = (data: Buffer) => {
          chunks.push(data);
          if (onUpdate) {
            const text = Buffer.concat(chunks).toString('utf-8');
            const truncation = truncateTail(text);
            onUpdate({
              content: [{ type: 'text', text: truncation.content || '' }],
              details: { exitCode: null },
            });
          }
        };

        child.stdout?.on('data', handleData);
        child.stderr?.on('data', handleData);

        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);

          const fullOutput = Buffer.concat(chunks).toString('utf-8');
          const truncation = truncateTail(fullOutput);

          if (signal?.aborted) {
            reject(new Error(fullOutput + '\n\nCommand aborted'));
            return;
          }
          if (timedOut) {
            reject(new Error(fullOutput + `\n\nCommand timed out after ${timeout} seconds`));
            return;
          }

          let outputText = truncation.content || '(no output)';
          if (truncation.truncated) {
            const startLine = truncation.totalLines - truncation.outputLines + 1;
            outputText += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}]`;
          }

          if (code !== 0 && code !== null) {
            outputText += `\n\nCommand exited with code ${code}`;
            reject(new Error(outputText));
          } else {
            resolve({
              content: [{ type: 'text', text: outputText }],
              details: { exitCode: code },
            });
          }
        });

        child.on('error', (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });
      });
    },
  };
}

export const bashTool = createBashTool(process.cwd());
