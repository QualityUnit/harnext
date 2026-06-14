import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';
import type { BackgroundShell, BackgroundShellManager } from '../background-shells.js';

const killShellSchema = Type.Object({
  shell_id: Type.String({ description: 'Id of the background shell to stop (e.g. "bash_1")' }),
});

export type KillShellToolInput = Static<typeof killShellSchema>;

export interface KillShellToolDetails {
  shell_id: string;
  status: BackgroundShell['status'] | 'unknown';
}

export function createKillShellTool(
  backgroundShells: BackgroundShellManager,
): AgentTool<typeof killShellSchema, KillShellToolDetails> {
  return {
    name: 'kill_shell',
    label: 'kill shell',
    description:
      'Stop a background shell started with bash run_in_background. Sends SIGTERM (then SIGKILL ' +
      'after a grace period). Use bash_output afterwards to confirm it stopped.',
    parameters: killShellSchema,
    async execute(_toolCallId, params) {
      const shell = backgroundShells.kill(params.shell_id);
      if (!shell) {
        return {
          content: [
            { type: 'text', text: `No background shell with id "${params.shell_id}".` },
          ],
          details: { shell_id: params.shell_id, status: 'unknown' },
        };
      }

      // kill() returns synchronously; a still-running shell has not processed
      // the signal yet, so report intent rather than a final status.
      const text =
        shell.status === 'running'
          ? `Sent SIGTERM to \`${shell.id}\`. It will stop shortly — use bash_output to confirm.`
          : `Shell \`${shell.id}\` was already ${shell.status}.`;
      return {
        content: [{ type: 'text', text }],
        details: { shell_id: shell.id, status: shell.status },
      };
    },
  };
}
