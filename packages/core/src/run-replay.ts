import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';

import type { AgentRunLogEvent } from './coding-agent-runner.js';
import { getProjectStateDir } from './config.js';
import type { StageMode } from './github-connection.js';

export const GITHUB_RUNS_DIR_NAME = 'github-runs';

export function getGithubRunsDir(cwd: string): string {
  return join(getProjectStateDir(cwd), GITHUB_RUNS_DIR_NAME);
}

/**
 * Full transcript of a single stage run, persisted by historical poller
 * runs. Read-only here — no new records are written after the cron poller
 * was retired in favour of self-hosted GitHub Actions runners. The viewer
 * still works against archived files for debugging past runs.
 */
export interface AgentRunLogRecord {
  ts: string;
  itemNumber: number;
  itemKind: 'issue' | 'pr';
  stageId: string;
  stageLabel: string;
  mode: StageMode;
  exit: number;
  durationMs: number;
  prompt: string;
  events: AgentRunLogEvent[];
  error?: string;
}

export interface AgentRunLogSummary {
  path: string;
  fileName: string;
  ts: string;
  itemNumber: number;
  itemKind: 'issue' | 'pr';
  stageId: string;
  stageLabel: string;
  eventCount: number;
  exit: number;
  durationMs: number;
  error?: string;
}

/**
 * List all saved agent run logs in `.harnext/github-runs/`, newest first.
 * Skips unreadable/malformed files silently — a best-effort UI lister, not a
 * source of truth.
 */
export function listAgentRunLogs(cwd: string): AgentRunLogSummary[] {
  const dir = getGithubRunsDir(cwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const summaries: AgentRunLogSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      const raw = readFileSync(full, 'utf-8');
      const rec = JSON.parse(raw) as AgentRunLogRecord;
      summaries.push({
        path: full,
        fileName: name,
        ts: rec.ts,
        itemNumber: rec.itemNumber,
        itemKind: rec.itemKind,
        stageId: rec.stageId,
        stageLabel: rec.stageLabel,
        eventCount: Array.isArray(rec.events) ? rec.events.length : 0,
        exit: rec.exit,
        durationMs: rec.durationMs,
        error: rec.error,
      });
    } catch {
      // skip malformed file
    }
  }
  summaries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return summaries;
}

export function loadAgentRunLog(path: string): AgentRunLogRecord {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as AgentRunLogRecord;
}

function timestampOf(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : Date.now();
}

/**
 * Reconstruct a best-effort `AgentMessage[]` transcript from the flattened
 * `AgentRunLogEvent[]` captured at write time.
 *
 * We don't have full LLM metadata (api/provider/model/usage/stopReason) in
 * the log — we fill those with safe placeholders. `convertToLlm` in sdk.ts
 * keeps user/assistant/toolResult roles and strips everything else, so these
 * messages are usable as pre-seeded history for a continued session.
 */
export function reconstructMessagesFromEvents(
  events: AgentRunLogEvent[],
  fallback: { api: string; provider: string; model: string } = {
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: '',
  },
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  let currentAssistant: AssistantMessage | undefined;

  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  for (const ev of events) {
    if (ev.type === 'message_end') {
      if (ev.role === 'user') {
        const msg: UserMessage = {
          role: 'user',
          content: ev.text ?? '',
          timestamp: timestampOf(ev.ts),
        };
        messages.push(msg);
        currentAssistant = undefined;
      } else if (ev.role === 'assistant') {
        const msg: AssistantMessage = {
          role: 'assistant',
          content: ev.text ? [{ type: 'text', text: ev.text }] : [],
          api: fallback.api,
          provider: fallback.provider,
          model: fallback.model,
          usage: emptyUsage,
          stopReason: 'stop',
          timestamp: timestampOf(ev.ts),
        };
        messages.push(msg);
        currentAssistant = msg;
      }
      continue;
    }

    if (ev.type === 'tool_execution_start') {
      if (currentAssistant && ev.toolCallId && ev.toolName) {
        const call: ToolCall = {
          type: 'toolCall',
          id: ev.toolCallId,
          name: ev.toolName,
          arguments:
            ev.toolInput && typeof ev.toolInput === 'object'
              ? (ev.toolInput as Record<string, unknown>)
              : {},
        };
        currentAssistant.content.push(call);
      }
      continue;
    }

    if (ev.type === 'tool_execution_end') {
      if (ev.toolCallId && ev.toolName) {
        const msg: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          content: [{ type: 'text', text: ev.toolOutput ?? '' }],
          isError: !!ev.isError,
          timestamp: timestampOf(ev.ts),
        };
        messages.push(msg);
      }
      continue;
    }
  }

  return messages;
}

/**
 * Load a run log file and reconstruct it into an `AgentMessage[]` suitable
 * for seeding `agent.state.messages`.
 */
export function reconstructMessagesFromRunLog(
  path: string,
  fallback?: { api: string; provider: string; model: string },
): { record: AgentRunLogRecord; messages: AgentMessage[] } {
  const record = loadAgentRunLog(path);
  const messages = reconstructMessagesFromEvents(record.events ?? [], fallback);
  return { record, messages };
}
