import { createInterface } from 'node:readline';

import type { AgentEvent } from '@earendil-works/pi-agent-core';

import type { AgentSession } from '@harnext/core';
import type { OutputFormat } from '../cli/args.js';
import { errorBlock, toolStart } from './interactive/render.js';
import {
  UsageAccumulator,
  buildAssistantEnvelope,
  buildInitEnvelope,
  buildResultEnvelope,
  buildToolResultEnvelope,
  extractText,
  extractUserTextFromStreamJsonLine,
  type ResultSubtype,
} from './sdk-output.js';

export interface PrintModeOptions {
  /** The single prompt for one-shot mode. Unused by the streaming-input mode. */
  initialMessage?: string;
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
  let errorText = '';

  session.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_end':
        if (event.message.role === 'assistant') {
          lastAssistantText = extractText(event.message.content);
          const msg = event.message as { stopReason?: string; errorMessage?: string };
          if (msg.stopReason === 'error') {
            hasError = true;
            if (msg.errorMessage) errorText = msg.errorMessage;
          }
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
    await session.prompt(options.initialMessage ?? '');
  } catch (err) {
    hasError = true;
    errorText = err instanceof Error ? err.message : String(err);
  } finally {
    await session.dispose();
  }

  // A run can fail without throwing — the LLM/transport error is surfaced on
  // state rather than as a thrown exception.
  if (session.state.errorMessage) {
    hasError = true;
    if (!errorText) errorText = session.state.errorMessage;
  }

  if (lastAssistantText) {
    process.stdout.write(lastAssistantText + '\n');
  }
  // Errors go to stderr in themed red so stdout stays clean for piping.
  if (hasError) {
    process.stderr.write(errorBlock(errorText) + '\n');
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
    await session.prompt(options.initialMessage ?? '');
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

/**
 * Streaming-input mode (Claude SDK `--input-format stream-json`): read NDJSON
 * user messages from `input` incrementally and keep the session alive across
 * turns. The first message starts a run; messages that arrive **while the agent
 * is generating** are injected as steering messages into the live run; messages
 * that arrive while idle start the next turn (continuing the same transcript).
 * The session ends when `input` closes and the current run is idle.
 *
 * This is the headless counterpart to the interactive REPL's steering: it lets
 * a programmatic driver redirect the agent mid-run without waiting for it to
 * finish. Output mirrors the one-shot modes, but per run: stream-json emits an
 * init envelope once then assistant/tool/result envelopes; json emits a result
 * envelope per run; text prints each run's final assistant text.
 */
export async function runStreamingPrintMode(
  session: AgentSession,
  options: PrintModeOptions,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<number> {
  const format = options.outputFormat ?? 'text';
  const stream = format === 'stream-json';
  const machine = stream || format === 'json';
  const writeLine = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  if (stream) {
    writeLine(buildInitEnvelope(session, options.cwd ?? process.cwd(), options.permissionMode));
  }

  // Per-run output state. Only one run is ever active at a time (mid-run input
  // steers rather than starting a new run), so these are reset by beginRun and
  // read by finishRun without overlap.
  let usageAcc = new UsageAccumulator();
  let lastAssistantText = '';
  let runErrored = false;
  let runErrorText = '';
  let turnsAtStart = 0;
  let runStart = 0;
  // Set once if any run ends in a hard execution error — drives the exit code.
  let anyError = false;

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
          if (message.stopReason === 'error') {
            runErrored = true;
            if (message.errorMessage) runErrorText = message.errorMessage;
          }
          if (stream) writeLine(buildAssistantEnvelope(event.message, session.sessionId));
        }
        break;
      case 'tool_execution_start':
        if (format === 'text') {
          process.stderr.write('\n' + toolStart(event.toolName, event.args) + '\n');
        }
        break;
      case 'tool_execution_end':
        if (event.isError) runErrored = true;
        if (stream) {
          writeLine(
            buildToolResultEnvelope(event.toolCallId, event.result, event.isError, session.sessionId),
          );
        }
        break;
    }
  });

  // Emit the per-run result once a run goes idle.
  const finishRun = (): void => {
    const stateError = session.state.errorMessage;
    if (stateError && !session.maxTurnsReached) {
      runErrored = true;
      if (!runErrorText) runErrorText = stateError;
    }
    const subtype: ResultSubtype = session.maxTurnsReached
      ? 'error_max_turns'
      : runErrored
        ? 'error_during_execution'
        : 'success';
    if (subtype === 'error_during_execution') anyError = true;

    if (machine) {
      const { usage, cost } = usageAcc.totals;
      writeLine(
        buildResultEnvelope({
          subtype,
          resultText: lastAssistantText || (runErrored ? runErrorText : ''),
          sessionId: session.sessionId,
          numTurns: session.turnCount - turnsAtStart,
          durationMs: Date.now() - runStart,
          usage,
          totalCostUsd: cost,
        }),
      );
    } else {
      if (lastAssistantText) process.stdout.write(lastAssistantText + '\n');
      if (runErrored) process.stderr.write(errorBlock(runErrorText) + '\n');
    }
  };

  const beginRun = (text: string): Promise<void> => {
    usageAcc = new UsageAccumulator();
    lastAssistantText = '';
    runErrored = false;
    runErrorText = '';
    turnsAtStart = session.turnCount;
    runStart = Date.now();
    return session
      .prompt(text)
      .catch((err) => {
        runErrored = true;
        runErrorText = err instanceof Error ? err.message : String(err);
      })
      .finally(() => finishRun());
  };

  let activeRun: Promise<void> | null = null;
  const rl = createInterface({ input, terminal: false });
  try {
    for await (const line of rl) {
      const text = extractUserTextFromStreamJsonLine(line);
      if (text == null) continue;
      if (activeRun) {
        // The agent is generating — steer the live run rather than blocking.
        session.agent.steer({ role: 'user', content: text, timestamp: Date.now() });
      } else {
        // Idle — start (or continue) the conversation with a fresh run. Don't
        // await: keep reading so the next line can steer this run.
        activeRun = beginRun(text).finally(() => {
          activeRun = null;
        });
      }
    }
    // Input closed — let the final run drain before tearing down.
    if (activeRun) await activeRun;
  } finally {
    rl.close();
    await session.dispose();
  }

  return anyError ? 1 : 0;
}
