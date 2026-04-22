import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from './truncate.js';

const bashSchema = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }),
  ),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  exitCode: number | null;
}

function getShellConfig(): { shell: string; args: string[] } {
  const shell = process.env.SHELL || '/bin/bash';
  return { shell, args: ['-c'] };
}

export function createBashTool(cwd: string): AgentTool<typeof bashSchema, BashToolDetails> {
  return {
    name: 'bash',
    label: 'bash',
    description: `Execute a bash command in the working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    parameters: bashSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const { command, timeout } = params;
      if (onUpdate) {
        onUpdate({ content: [], details: { exitCode: null } });
      }
      return new Promise((resolve, reject) => {
        if (!existsSync(cwd)) {
          reject(new Error(`Working directory does not exist: ${cwd}`));
          return;
        }
        const { shell, args } = getShellConfig();
        const child = spawn(shell, [...args, command], {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

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

        const onAbort = () => child.kill('SIGTERM');
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener('abort', onAbort);

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
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      });
    },
  };
}

export const bashTool = createBashTool(process.cwd());
