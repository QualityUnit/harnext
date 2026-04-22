import type { AgentEvent } from '@mariozechner/pi-agent-core';

import {
  acquireLock,
  appendGithubPollTick,
  createAgentSession,
  detectOpenedPr,
  fetchLatestReviewVerdict,
  fetchUpdatedIssues,
  getCodingAgentSpec,
  persistPointer,
  pruneAgentRunLogs,
  pruneStaleWorktrees,
  refetchItem,
  releaseLock,
  releaseWorktreeForItem,
  resolveWorktreeForItem,
  runExternalCodingAgent,
  runPollTick,
  transitionLabels,
  writeAgentRunLog,
  type AgentRunLogEvent,
  type AgentRunResult,
  type AgentSession,
  type CreateAgentSessionOptions,
  type GithubConnectionConfig,
  type GithubIssueItem,
  type WorktreeRecord,
} from '@harnext/core';

/** Keep tool output from ballooning the transcript — 8 KB per call is enough for triage. */
const TOOL_OUTPUT_MAX_CHARS = 8192;

function truncate(s: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

function stringifyToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return truncate(result);
  try {
    return truncate(JSON.stringify(result, null, 2));
  } catch {
    return truncate(String(result));
  }
}

/**
 * Flatten the message content into a plain text string. Upstream content can
 * be a raw string (user/toolResult) or an array of parts (assistant); we just
 * pull out any `.text` we can see.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
        return (c as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

/** Config the caller passes in instead of a single pre-built session. */
export type GithubPollSessionFactoryOptions = Pick<
  CreateAgentSessionOptions,
  'provider' | 'modelId' | 'thinkingLevel' | 'systemPrompt'
>;

export interface GithubPollModeOptions {
  cwd: string;
  config: GithubConnectionConfig;
  /**
   * Knobs for building per-item AgentSessions when `config.codingAgent` is
   * `harnext`. cwd is supplied internally (the worktree path for the current
   * item) so the caller doesn't set it. Ignored for external coding agents,
   * which spawn their own CLI per stage.
   */
  session?: GithubPollSessionFactoryOptions;
}

function isPr(item: GithubIssueItem): boolean {
  return !!item.pull_request;
}

/**
 * Cron-driven GitHub poller. Acquires a per-project lock, runs one tick that
 * may process multiple issues and chain YOLO stages, writes the updated
 * pointer back to github.json, and exits. Each issue gets its own git
 * worktree and a fresh AgentSession rooted in that worktree, so agent tool
 * calls never touch the user's live checkout.
 */
export async function runGithubPollMode(
  options: GithubPollModeOptions,
): Promise<number> {
  const { cwd, config } = options;
  const lock = acquireLock(cwd);
  if (!lock) {
    // Another tick is already running — skip without emitting an error.
    appendGithubPollTick(cwd, {
      ts: new Date().toISOString(),
      itemNumber: -1,
      itemKind: 'issue',
      stageId: '(skipped)',
      stageLabel: '',
      mode: 'yolo',
      exit: 0,
      durationMs: 0,
      output: 'another poller is holding the lock; skipping tick',
    });
    return 0;
  }

  // Which coding agent to dispatch to. `harnext` runs the pi-agent-core
  // in-process session; external ids spawn the agent's CLI binary per stage.
  const codingAgent = config.codingAgent;
  const externalSpec = codingAgent === 'harnext' ? undefined : getCodingAgentSpec(codingAgent);

  try {
    // Per-run capture buffers reset inside runAgent() before each invocation.
    let lastAssistantText = '';
    let toolErrored = false;
    let events: AgentRunLogEvent[] = [];

    // Current item's session + subscription handle (only used when codingAgent
    // is 'harnext'). For external agents we carry the worktree path instead,
    // since each stage run is a fresh spawn rather than a long-lived session.
    let currentSession: AgentSession | undefined;
    let currentUnsubscribe: (() => void) | undefined;
    let currentWorktreePath: string | undefined;

    const subscribe = (session: AgentSession): (() => void) =>
      session.subscribe(async (event: AgentEvent) => {
        const ts = new Date().toISOString();
        switch (event.type) {
          case 'message_start':
            events.push({ ts, type: 'message_start', role: event.message.role });
            break;
          case 'message_end': {
            const text = extractMessageText(event.message.content);
            if (event.message.role === 'assistant') lastAssistantText = text;
            events.push({ ts, type: 'message_end', role: event.message.role, text });
            break;
          }
          case 'tool_execution_start':
            events.push({
              ts,
              type: 'tool_execution_start',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              toolInput: event.args,
            });
            break;
          case 'tool_execution_end':
            if (event.isError) toolErrored = true;
            events.push({
              ts,
              type: 'tool_execution_end',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              toolOutput: stringifyToolResult(event.result),
              isError: event.isError,
            });
            break;
        }
      });

    const runAgent = async (prompt: string): Promise<AgentRunResult> => {
      if (externalSpec) {
        if (!currentWorktreePath) {
          return {
            exit: 1,
            durationMs: 0,
            output: '',
            error: 'no active worktree for item; resolveWorktree did not run',
          };
        }
        if (!config.codingAgentModel) {
          return {
            exit: 1,
            durationMs: 0,
            output: '',
            error: `coding agent "${externalSpec.id}" requires codingAgentModel in config`,
          };
        }
        return runExternalCodingAgent(externalSpec, prompt, {
          cwd: currentWorktreePath,
          modelId: config.codingAgentModel,
        });
      }

      lastAssistantText = '';
      toolErrored = false;
      events = [];
      const started = Date.now();
      if (!currentSession) {
        return {
          exit: 1,
          durationMs: 0,
          output: '',
          error: 'no active session for item; resolveWorktree did not run',
        };
      }
      try {
        await currentSession.prompt(prompt);
        return {
          exit: toolErrored ? 2 : 0,
          durationMs: Date.now() - started,
          output: lastAssistantText,
          events: [...events],
        };
      } catch (err) {
        return {
          exit: 1,
          durationMs: Date.now() - started,
          output: lastAssistantText,
          error: err instanceof Error ? err.message : String(err),
          events: [...events],
        };
      }
    };

    const resolveWorktree = async (item: GithubIssueItem): Promise<WorktreeRecord> => {
      const itemKind: 'issue' | 'pr' = isPr(item) ? 'pr' : 'issue';
      const record = await resolveWorktreeForItem({
        cwd,
        itemNumber: item.number,
        itemKind,
      });
      appendGithubPollTick(cwd, {
        ts: new Date().toISOString(),
        itemNumber: item.number,
        itemKind,
        stageId: '(worktree-ready)',
        stageLabel: '',
        mode: 'yolo',
        exit: 0,
        durationMs: 0,
        output: `worktree at ${record.path} (branch ${record.branch})`,
      });

      currentWorktreePath = record.path;

      if (!externalSpec) {
        if (!options.session) {
          throw new Error('harnext coding agent requires session options to be provided');
        }
        const { session, diagnostics } = await createAgentSession({
          provider: options.session.provider,
          modelId: options.session.modelId,
          thinkingLevel: options.session.thinkingLevel,
          systemPrompt: options.session.systemPrompt,
          cwd: record.path,
          quiet: true,
        });
        for (const d of diagnostics) {
          appendGithubPollTick(cwd, {
            ts: new Date().toISOString(),
            itemNumber: item.number,
            itemKind,
            stageId: `(${d.source}-${d.type})`,
            stageLabel: '',
            mode: 'yolo',
            exit: 0,
            durationMs: 0,
            output: `${d.message} (${d.path})`,
          });
        }
        currentSession = session;
        currentUnsubscribe = subscribe(session);
      }
      return record;
    };

    const releaseWorktree = async (item: GithubIssueItem): Promise<void> => {
      if (currentUnsubscribe) {
        try {
          currentUnsubscribe();
        } catch {
          // best-effort
        }
        currentUnsubscribe = undefined;
      }
      currentSession = undefined;
      currentWorktreePath = undefined;
      await releaseWorktreeForItem({ cwd, itemNumber: item.number });
      appendGithubPollTick(cwd, {
        ts: new Date().toISOString(),
        itemNumber: item.number,
        itemKind: isPr(item) ? 'pr' : 'issue',
        stageId: '(worktree-released)',
        stageLabel: '',
        mode: 'yolo',
        exit: 0,
        durationMs: 0,
        output: `released worktree for #${item.number}`,
      });
    };

    const result = await runPollTick(config, {
      fetch: fetchUpdatedIssues,
      refetch: refetchItem,
      transition: transitionLabels,
      fetchLatestReviewVerdict,
      detectOpenedPr: (input) => detectOpenedPr(input),
      runAgent,
      resolveWorktree,
      releaseWorktree,
      appendTick: (rec) => appendGithubPollTick(cwd, rec),
      writeRunLog: (rec) => {
        try {
          writeAgentRunLog(cwd, rec);
        } catch (err) {
          appendGithubPollTick(cwd, {
            ts: new Date().toISOString(),
            itemNumber: rec.itemNumber,
            itemKind: rec.itemKind,
            stageId: '(run-log-error)',
            stageLabel: rec.stageLabel,
            mode: rec.mode,
            exit: 0,
            durationMs: 0,
            output: err instanceof Error ? err.message : String(err),
          });
        }
      },
      warn: (msg) => {
        appendGithubPollTick(cwd, {
          ts: new Date().toISOString(),
          itemNumber: -1,
          itemKind: 'issue',
          stageId: '(warn)',
          stageLabel: '',
          mode: 'yolo',
          exit: 0,
          durationMs: 0,
          output: msg,
        });
      },
    });

    persistPointer(cwd, config, result.newPointer);
    try {
      pruneAgentRunLogs(cwd);
    } catch {
      // best-effort cleanup; never fail the tick because of it.
    }
    try {
      pruneStaleWorktrees(cwd);
    } catch {
      // best-effort; stale worktrees aren't fatal to the tick.
    }
    return 0;
  } catch (err) {
    appendGithubPollTick(cwd, {
      ts: new Date().toISOString(),
      itemNumber: -1,
      itemKind: 'issue',
      stageId: '(tick-error)',
      stageLabel: '',
      mode: 'yolo',
      exit: 1,
      durationMs: 0,
      output: '',
      error: err instanceof Error ? err.message : String(err),
    });
    return 1;
  } finally {
    releaseLock(lock);
  }
}
