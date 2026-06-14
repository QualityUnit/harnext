/**
 * `harnext --resume` UX: the per-cwd session picker and the
 * offer-to-summarize prompt shown when a resumed conversation is already near
 * the model's context window.
 */

import {
  compactNow,
  getContextTokens,
  listSessions,
  loadSession,
  loadSettings,
  type AgentSession,
  type SessionSummary,
} from '@harnext/core';
import chalk from 'chalk';

import { select, type SelectItem } from './select.js';

/** Compact relative-time label, e.g. "just now", "5m ago", "3h ago", "2d ago". */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/** Resolve an explicit `--resume <id>` to its stored summary, or undefined. */
export function resolveResumeTarget(cwd: string, sessionId: string): SessionSummary | undefined {
  return listSessions(cwd).find((s) => s.sessionId === sessionId)
    ?? summaryFromLoad(cwd, sessionId);
}

/** Fallback: build a summary directly from a loaded transcript (id outside cwd). */
function summaryFromLoad(cwd: string, sessionId: string): SessionSummary | undefined {
  const stored = loadSession(sessionId, cwd);
  if (!stored) return undefined;
  const first = stored.messages.find((m) => m.role === 'user');
  const firstText =
    first && typeof (first as { content?: unknown }).content === 'string'
      ? ((first as { content: string }).content)
      : '';
  return {
    sessionId: stored.sessionId,
    cwd: stored.cwd,
    provider: stored.provider,
    model: stored.model,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    messageCount: stored.messages.length,
    firstUserMessage: firstText,
    filePath: '',
  };
}

/**
 * Show the interactive picker of this cwd's saved sessions, newest first.
 * Each row: first user message + relative time, message count, and model.
 * Returns the chosen session, or undefined if there are none / the user
 * cancelled.
 */
export async function runResumePicker(cwd: string): Promise<SessionSummary | undefined> {
  const sessions = listSessions(cwd);
  if (sessions.length === 0) {
    console.log(chalk.dim('  No saved sessions for this directory yet.'));
    return undefined;
  }

  const items: SelectItem<SessionSummary>[] = sessions.map((s) => {
    const label = s.firstUserMessage ? truncate(s.firstUserMessage, 72) : chalk.dim('(no prompt)');
    const parts = [formatRelativeTime(s.updatedAt), `${s.messageCount} msg`];
    if (s.model) parts.push(s.model);
    return { label, value: s, hint: parts.join(' · ') };
  });

  return select(items, { title: `Resume a session — ${cwd}` });
}

/**
 * When a resumed conversation is already close to the model's context window,
 * offer to compact it before continuing. The threshold reuses the compaction
 * budget from settings (`contextWindow − reserveTokens`) — i.e. the point at
 * which the next turn would auto-compact anyway. Shows a before/after token
 * estimate after summarizing.
 */
export async function offerSummarizeOnResume(session: AgentSession, cwd: string): Promise<void> {
  const ctxWindow = session.model.contextWindow ?? 0;
  if (!ctxWindow) return;

  const tokens = getContextTokens(session.messages);
  if (tokens === 0) return;

  const { reserveTokens } = loadSettings(cwd).compaction;
  const threshold = ctxWindow - reserveTokens;
  if (tokens < threshold) return;

  const pct = Math.round((tokens / ctxWindow) * 100);
  console.log(
    chalk.yellow(`  This conversation is large: ~${tokens.toLocaleString()} tokens (${pct}% of the context window).`),
  );

  const choice = await select<'yes' | 'no'>(
    [
      { label: 'Summarize before continuing', value: 'yes', hint: 'compact older turns into a summary' },
      { label: 'Continue without summarizing', value: 'no', hint: 'keep the full transcript' },
    ],
    { title: 'Summarize this conversation?' },
  );
  if (choice !== 'yes') return;

  process.stdout.write(chalk.dim('  Summarizing…\n'));
  try {
    const result = await compactNow(session.agent);
    if (result.compacted) {
      console.log(
        chalk.green('  Summarized: ') +
          chalk.dim(
            `${result.originalMessages} → ${result.newMessages} messages, ` +
              `~${result.originalTokens.toLocaleString()} → ~${result.compactedTokens.toLocaleString()} tokens`,
          ),
      );
    } else {
      console.log(chalk.dim('  Nothing to summarize.'));
    }
  } catch (err) {
    console.log(
      chalk.red('  Summarize failed: ') + (err instanceof Error ? err.message : String(err)),
    );
  }
  console.log();
}
