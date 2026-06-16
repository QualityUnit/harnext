/**
 * Session usage + cost accounting (issue #55).
 *
 * Each assistant message carries a pi-ai `usage` block whose `cost` was
 * computed at generation time as `(model.cost.<field> / 1e6) * tokens` (see
 * pi-ai `calculateCost`). A turn's `input` is the *cumulative* context sent to
 * the model for that call, so summing per-turn `input`/`cost` across assistant
 * messages yields the **total billed** for the session — the figure the footer
 * shows next to the `$` cost (the two are derived from the same per-call
 * numbers, so they stay consistent).
 *
 * This is distinct from the *current context size* (`getContextTokens`), which
 * is the latest single turn's `input + output`. Don't confuse the two: billed
 * tokens accumulate across turns; context size does not.
 *
 * Pulled out of the CLI footer into core so it has a single, tested home (the
 * stream-json `UsageAccumulator` sums the same way).
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

export interface SessionUsageTotals {
  /** Total input (prompt) tokens billed across all assistant turns. */
  input: number;
  /** Total output (completion) tokens across all assistant turns. */
  output: number;
  /** Total cached-read input tokens billed. */
  cacheRead: number;
  /** Total cache-write input tokens billed. */
  cacheWrite: number;
  /** Total USD cost across all assistant turns (sum of per-turn `cost.total`). */
  cost: number;
}

/** Shape of the usage block we read off an assistant message (all optional). */
interface MessageUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/**
 * Sum token usage and cost across every assistant turn in `messages`.
 * Non-assistant messages and messages without a usage block are skipped, and
 * every field is independently optional (a provider that reports tokens but no
 * cost, e.g. ollama/nvidia/an unpriced OpenRouter id, contributes tokens with
 * `cost: 0`).
 */
export function sumSessionUsage(messages: ReadonlyArray<AgentMessage>): SessionUsageTotals {
  const totals: SessionUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const u = (msg as { usage?: MessageUsageLike }).usage;
    if (!u) continue;
    totals.input += u.input ?? 0;
    totals.output += u.output ?? 0;
    totals.cacheRead += u.cacheRead ?? 0;
    totals.cacheWrite += u.cacheWrite ?? 0;
    totals.cost += u.cost?.total ?? 0;
  }
  return totals;
}
