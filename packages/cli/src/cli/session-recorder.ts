/**
 * Persists an interactive (or print) session's transcript to the local per-cwd
 * session store, so it can later be listed and resumed with `harnext --resume`.
 *
 * Mirrors the cloud uploader's shape (attach as a subscriber, flush at turn
 * boundaries, finalize on exit) but writes a local append-only JSONL file
 * instead of pushing to the context engine. Everything is best-effort: a write
 * failure is swallowed and never disrupts the agent.
 */

import {
  createSessionWriter,
  type AgentSession,
  type SessionWriter,
} from '@harnext/core';
import type { AgentEvent } from '@earendil-works/pi-agent-core';

export interface SessionRecorderHandle {
  /** Persist the current transcript immediately (called on exit). */
  flush(): void;
}

export interface SessionRecorderMeta {
  cwd: string;
  provider?: string;
  model?: string;
}

const NOOP: SessionRecorderHandle = { flush: () => {} };

/**
 * Record `session` to `~/.harnext/agent/sessions/<cwd-hash>/<id>.jsonl`. The
 * transcript is rewritten/appended at every turn boundary and on `flush()`.
 */
export function attachSessionRecorder(
  session: AgentSession,
  meta: SessionRecorderMeta,
): SessionRecorderHandle {
  let writer: SessionWriter;
  try {
    writer = createSessionWriter({
      cwd: meta.cwd,
      sessionId: session.sessionId,
      provider: meta.provider,
      model: meta.model ?? session.model.id,
    });
  } catch {
    return NOOP;
  }

  const save = (): void => writer.record(session.messages);

  session.subscribe((event: AgentEvent) => {
    if (event.type === 'turn_end') save();
  });

  return { flush: save };
}
