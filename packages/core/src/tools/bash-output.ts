import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';
import type { BackgroundShell, BackgroundShellManager } from '../background-shells.js';

const bashOutputSchema = Type.Object({
  bash_id: Type.String({ description: 'Id of the background shell (e.g. "bash_1")' }),
  filter: Type.Optional(
    Type.String({
      description: 'Optional regular expression; only output lines matching it are returned.',
    }),
  ),
});

export type BashOutputToolInput = Static<typeof bashOutputSchema>;

export interface BashOutputToolDetails {
  status: BackgroundShell['status'];
  exitCode: number | null;
}

/** Human-readable status line for a background shell. */
export function formatStatus(shell: BackgroundShell): string {
  switch (shell.status) {
    case 'running':
      return shell.pid !== undefined ? `running (pid ${shell.pid})` : 'running';
    case 'completed':
      return `completed (exit ${shell.exitCode ?? 0})`;
    case 'failed':
      return shell.exitCode === null ? 'failed' : `failed (exit ${shell.exitCode})`;
    case 'killed':
      return 'killed';
  }
}

/** Whole seconds a shell has been (or was) running. */
export function runtimeSeconds(shell: BackgroundShell): number {
  return Math.round(((shell.endedAt ?? Date.now()) - shell.startedAt) / 1000);
}

export function createBashOutputTool(
  backgroundShells: BackgroundShellManager,
): AgentTool<typeof bashOutputSchema, BashOutputToolDetails> {
  return {
    name: 'bash_output',
    label: 'bash output',
    description:
      'Read new output from a background shell started with bash run_in_background. Returns ' +
      'only the output produced since your last read (the cursor advances), plus the shell ' +
      'status and exit code. Pass a `filter` regex to keep only matching lines.',
    parameters: bashOutputSchema,
    async execute(_toolCallId, params) {
      const result = backgroundShells.readOutput(params.bash_id, { filter: params.filter });
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: `No background shell with id "${params.bash_id}". Use the list of running shells or start one with bash run_in_background.`,
            },
          ],
          details: { status: 'failed', exitCode: null },
        };
      }

      const { shell, newOutput, truncated } = result;
      const header = `[${shell.id}] ${formatStatus(shell)} · ${runtimeSeconds(shell)}s`;
      const body = newOutput.length > 0 ? newOutput : '(no new output)';
      const note = truncated ? '\n[earlier output truncated]' : '';
      return {
        content: [{ type: 'text', text: `${header}\n${body}${note}` }],
        details: { status: shell.status, exitCode: shell.exitCode },
      };
    },
  };
}
