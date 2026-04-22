import type { AgentEvent } from '@mariozechner/pi-agent-core';

import type { AgentSession } from '@harnext/core';
import { toolStart } from './interactive/render.js';

export interface PrintModeOptions {
  initialMessage: string;
}

/**
 * Non-interactive mode: send a single prompt, print the result, exit.
 */
export async function runPrintMode(
  session: AgentSession,
  options: PrintModeOptions,
): Promise<number> {
  let lastAssistantText = '';
  let hasError = false;
  const pendingToolArgs: Map<string, Record<string, unknown>> = new Map();

  session.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_end':
        if (event.message.role === 'assistant') {
          const textParts = event.message.content.filter(
            (c: { type: string }) => c.type === 'text',
          );
          lastAssistantText = textParts
            .map((c: { type: string; text?: string }) => (c as { text: string }).text)
            .join('');
        }
        break;
      case 'tool_execution_start':
        pendingToolArgs.set(event.toolCallId, event.args);
        process.stderr.write('\n' + toolStart(event.toolName, event.args) + '\n');
        break;
      case 'tool_execution_end':
        pendingToolArgs.delete(event.toolCallId);
        if (event.isError) hasError = true;
        break;
    }
  });

  try {
    await session.prompt(options.initialMessage);
  } catch {
    hasError = true;
  } finally {
    await session.dispose();
  }

  if (lastAssistantText) {
    process.stdout.write(lastAssistantText + '\n');
  }

  return hasError ? 1 : 0;
}
