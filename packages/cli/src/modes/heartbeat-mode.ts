import type { AgentEvent } from '@mariozechner/pi-agent-core';

import type { AgentSession } from '@harnext/core';
import { appendHeartbeatTick } from '@harnext/core';

export interface HeartbeatModeOptions {
  cwd: string;
  name: string;
  prompt: string;
}

/**
 * One-shot mode invoked from cron. Mirrors print-mode, but writes a single
 * structured record to `<cwd>/.harnext/heartbeats/<name>.jsonl` instead of
 * printing to stdout — that's all cron would see anyway.
 */
export async function runHeartbeatMode(
  session: AgentSession,
  options: HeartbeatModeOptions,
): Promise<number> {
  const startedAt = Date.now();
  let lastAssistantText = '';
  let toolErrored = false;

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
      case 'tool_execution_end':
        if (event.isError) toolErrored = true;
        break;
    }
  });

  let errorMessage: string | undefined;
  let promptFailed = false;
  try {
    await session.prompt(options.prompt);
  } catch (err) {
    promptFailed = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const exit = promptFailed ? 1 : toolErrored ? 2 : 0;
  appendHeartbeatTick(options.cwd, options.name, {
    ts: new Date(startedAt).toISOString(),
    exit,
    durationMs: Date.now() - startedAt,
    prompt: options.prompt,
    output: lastAssistantText,
    ...(errorMessage ? { error: errorMessage } : {}),
  });
  return exit;
}
