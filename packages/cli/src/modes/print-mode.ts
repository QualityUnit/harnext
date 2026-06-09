import type { AgentEvent } from '@mariozechner/pi-agent-core';

import type { AgentSession } from '@harnext/core';
import type { OutputFormat } from '../cli/args.js';
import { toolStart } from './interactive/render.js';
import {
  UsageAccumulator,
  buildAssistantEnvelope,
  buildInitEnvelope,
  buildResultEnvelope,
  buildToolResultEnvelope,
  extractText,
  type ResultSubtype,
} from './sdk-output.js';

export interface PrintModeOptions {
  initialMessage: string;
  /** Output format: text (human), json (single result), or stream-json (NDJSON). */
  outputFormat?: OutputFormat;
  /** Working directory, surfaced in the stream-json init envelope. */
  cwd?: string;
  /** Permission mode, surfaced in the stream-json init envelope. */
  permissionMode?: string;
}

/**
 * Non-interactive mode: send a single prompt and emit the result in the
 * requested format, then exit.
 */
export async function runPrintMode(
  session: AgentSession,
  options: PrintModeOptions,
): Promise<number> {
  const format = options.outputFormat ?? 'text';
  if (format === 'text') {
    return runTextMode(session, options);
  }
  return runMachineMode(session, options, format === 'stream-json');
}

/** Human-readable mode: assistant text to stdout, tool calls to stderr. */
async function runTextMode(session: AgentSession, options: PrintModeOptions): Promise<number> {
  let lastAssistantText = '';
  let hasError = false;

  session.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_end':
        if (event.message.role === 'assistant') {
          lastAssistantText = extractText(event.message.content);
          if ((event.message as { stopReason?: string }).stopReason === 'error') hasError = true;
        }
        break;
      case 'tool_execution_start':
        process.stderr.write('\n' + toolStart(event.toolName, event.args) + '\n');
        break;
      case 'tool_execution_end':
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

  if (session.state.errorMessage) hasError = true;

  if (lastAssistantText) {
    process.stdout.write(lastAssistantText + '\n');
  }

  return hasError ? 1 : 0;
}

/**
 * Machine-readable mode mirroring the Claude Agent SDK:
 *  - stream-json: NDJSON of system/assistant/user/result envelopes.
 *  - json: a single terminal `result` envelope.
 */
async function runMachineMode(
  session: AgentSession,
  options: PrintModeOptions,
  stream: boolean,
): Promise<number> {
  const writeLine = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  const usageAcc = new UsageAccumulator();
  let lastAssistantText = '';
  let errored = false;
  let errorText = '';
  const start = Date.now();

  if (stream) {
    writeLine(buildInitEnvelope(session, options.cwd ?? process.cwd(), options.permissionMode));
  }

  session.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'message_end':
        if (event.message.role === 'assistant') {
          const message = event.message as {
            usage?: unknown;
            stopReason?: string;
            errorMessage?: string;
          };
          usageAcc.add(message.usage);
          const text = extractText(event.message.content);
          if (text) lastAssistantText = text;
          // The agent loop ends a failed turn with stopReason "error" rather
          // than throwing, so detect it here.
          if (message.stopReason === 'error') {
            errored = true;
            if (message.errorMessage) errorText = message.errorMessage;
          }
          if (stream) writeLine(buildAssistantEnvelope(event.message, session.sessionId));
        }
        break;
      case 'tool_execution_end':
        if (stream) {
          writeLine(
            buildToolResultEnvelope(event.toolCallId, event.result, event.isError, session.sessionId),
          );
        }
        break;
    }
  });

  try {
    await session.prompt(options.initialMessage);
  } catch (err) {
    errored = true;
    errorText = err instanceof Error ? err.message : String(err);
  } finally {
    await session.dispose();
  }

  // A run can fail without throwing (LLM/transport error surfaced on state).
  const stateError = session.state.errorMessage;
  if (stateError && !session.maxTurnsReached) {
    errored = true;
    if (!errorText) errorText = stateError;
  }

  const subtype: ResultSubtype = session.maxTurnsReached
    ? 'error_max_turns'
    : errored
      ? 'error_during_execution'
      : 'success';

  const { usage, cost } = usageAcc.totals;
  writeLine(
    buildResultEnvelope({
      subtype,
      resultText: lastAssistantText || (errored ? errorText : ''),
      sessionId: session.sessionId,
      numTurns: session.turnCount,
      durationMs: Date.now() - start,
      usage,
      totalCostUsd: cost,
    }),
  );

  // Mirror Claude: a run that completed (incl. hitting max_turns) exits 0;
  // only a hard execution error exits non-zero.
  return subtype === 'error_during_execution' ? 1 : 0;
}
