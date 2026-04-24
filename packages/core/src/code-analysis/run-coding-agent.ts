/**
 * Dispatch a prompt to the user's chosen coding agent (harnext
 * in-process, or an external CLI like claude-code / codex) and return
 * its trailing assistant text.
 *
 * Shared by every code-analysis sub-stage (tech-stack, risk-contract,
 * check-scripts, project-skills, stage-prompts). `workflow-generator.ts`
 * still has its own inline version today — migrating that is a
 * separate cleanup outside the code-analysis rollout.
 */

import { getCodingAgentSpec, type CodingAgentId } from '../coding-agents.js';
import {
  runExternalCodingAgent,
  type ExternalAgentSpawner,
} from '../coding-agent-runner.js';
import { createAgentSession } from '../sdk.js';

/**
 * Turn budget for every setup-time agent invocation (tech-stack,
 * risk-contract, check-scripts, project-skills, stage-prompts,
 * workflow-generator). Deliberately generous — these runs are where
 * the agent is supposed to read the whole repo, enumerate endpoints,
 * follow manifests, and ground every output in real files. A low turn
 * cap produces shallow skills (launch-commands only, no endpoint tour)
 * which is exactly the failure we want to avoid.
 *
 * Runtime pipeline stages (github-poller) do NOT use this constant —
 * they inherit claude-code's default cap so a runaway turn count on a
 * live issue can't blow the budget.
 */
export const CODE_ANALYSIS_MAX_TURNS = 150;

export interface RunCodingAgentOptions {
  cwd: string;
  codingAgent: CodingAgentId;
  /** Required for external agents; ignored (but accepted) for harnext. */
  codingAgentModel?: string;
  prompt: string;
  /**
   * Optional upper bound on the agent's turn count. Setup-time stages
   * (tech-stack, risk-contract, check-scripts, project-skills,
   * stage-prompts, workflow-generator) pass a high value so the agent
   * can research the repo thoroughly before writing anything — init
   * skills should enumerate manifests, endpoints, and entry points,
   * not just dump launch commands. Agents without a matching flag
   * (codex, harnext) ignore this.
   */
  maxTurns?: number;
  /** Test hook for external-agent spawning. */
  spawner?: ExternalAgentSpawner;
  /**
   * Test hook for the harnext in-process path. When supplied, the helper
   * calls this instead of `createAgentSession` so unit tests don't need a
   * real provider key.
   */
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
  /**
   * Invoked with a short human-readable activity line every time the
   * underlying agent does something (emits an assistant message, starts
   * a tool call, prints to stderr, etc.). Lets callers stream progress
   * back to the user so a 30–120s run doesn't look frozen.
   *
   * Callback errors are swallowed — a misbehaving UI must never kill
   * the agent run.
   */
  onActivity?: (line: string) => void;
}

export interface RunCodingAgentResult {
  /** Trailing assistant text from the run. Empty string if nothing captured. */
  output: string;
  /** Populated on spawn failure, timeout, or non-zero exit. */
  error?: string;
}

/** Emit a "still running" heartbeat every N seconds when the agent goes silent. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Don't heartbeat right after a genuine activity line — wait at least this long. */
const HEARTBEAT_QUIET_AFTER_MS = 8_000;

export async function runCodingAgent(
  opts: RunCodingAgentOptions,
): Promise<RunCodingAgentResult> {
  // Track the last time ANY activity was emitted (real or heartbeat) so
  // the heartbeat only fires during genuine silence. Some agents
  // (claude-code in `-p` mode) run 30–120s without any chatter;
  // without a heartbeat the user can't tell the process from a hang.
  let lastActivityAt = Date.now();
  const startedAt = lastActivityAt;

  const activity = (line: string): void => {
    lastActivityAt = Date.now();
    if (!opts.onActivity) return;
    try {
      opts.onActivity(line);
    } catch {
      // never let a UI callback kill the agent run
    }
  };

  const heartbeat = setInterval(() => {
    if (!opts.onActivity) return;
    if (Date.now() - lastActivityAt < HEARTBEAT_QUIET_AFTER_MS) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    try {
      opts.onActivity(`still running… (${elapsed}s elapsed)`);
    } catch {
      // swallow
    }
    lastActivityAt = Date.now();
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for the heartbeat.
  heartbeat.unref();

  try {
    if (opts.codingAgent === 'harnext') {
      if (opts.runHarnextAgent) {
        try {
          return { output: await opts.runHarnextAgent(opts.prompt, opts.cwd) };
        } catch (err) {
          return { output: '', error: err instanceof Error ? err.message : String(err) };
        }
      }
      return await runHarnextSession(opts.prompt, opts.cwd, activity);
    }

    const spec = getCodingAgentSpec(opts.codingAgent);
    if (!opts.codingAgentModel) {
      return {
        output: '',
        error: `coding agent "${spec.id}" requires a model id`,
      };
    }
    const result = await runExternalCodingAgent(spec, opts.prompt, {
      cwd: opts.cwd,
      modelId: opts.codingAgentModel,
      maxTurns: opts.maxTurns,
      spawner: opts.spawner,
      onLine: (line, stream) => {
        // Forward every non-empty line. The external CLI is the authority
        // on what's worth emitting; we don't filter by stream since
        // different agents use stdout/stderr differently.
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          activity(stream === 'stderr' ? `stderr: ${trimmed}` : trimmed);
        }
      },
    });
    return {
      output: result.output,
      error: result.exit !== 0 ? result.error ?? `agent exited ${result.exit}` : undefined,
    };
  } finally {
    clearInterval(heartbeat);
  }
}

async function runHarnextSession(
  prompt: string,
  cwd: string,
  activity: (line: string) => void,
): Promise<RunCodingAgentResult> {
  try {
    const { session } = await createAgentSession({ cwd, quiet: true });
    let lastText = '';
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        const arg = previewToolArgs(event.args);
        activity(`tool: ${event.toolName}${arg ? `(${arg})` : ''}`);
        return;
      }
      if (event.type === 'tool_execution_end') {
        if (event.isError) {
          activity(`tool: ${event.toolName} → error`);
        }
        return;
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const content = event.message.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .map((c) =>
              c &&
              typeof c === 'object' &&
              'text' in c &&
              typeof (c as { text: unknown }).text === 'string'
                ? (c as { text: string }).text
                : '',
            )
            .filter(Boolean)
            .join('');
        }
        if (text.length > 0) {
          lastText = text;
          // Surface the first non-empty line so the user sees the agent
          // is producing output, without spamming long assistant turns.
          const firstLine = text.split('\n').find((l) => l.trim().length > 0);
          if (firstLine) activity(firstLine.trim());
        }
      }
    });
    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
      await session.dispose();
    }
    return { output: lastText };
  } catch (err) {
    return { output: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One-liner preview of tool args for activity streaming. Shows the first
 * string-valued field so e.g. `Read({file_path: "/foo"})` comes out
 * readable instead of spilling a JSON blob into the terminal.
 */
function previewToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (typeof v === 'string' && v.length > 0) {
      const val = v.length > 80 ? v.slice(0, 77) + '…' : v;
      return `${k}: ${val}`;
    }
  }
  return entries.length > 0 ? `${entries[0][0]}: …` : '';
}
