/**
 * Streams a harness conversation to the context engine as it happens.
 *
 * Attaches as a session subscriber and mirrors the same stream-json envelopes
 * the SDK print mode emits (system/init, assistant, user/tool_result, result),
 * pushing them to the engine's store-only ingest API: open the session lazily,
 * append batches at each turn boundary, finalize on exit.
 *
 * Everything here is best-effort and non-blocking: a missing login, an offline
 * engine, or any HTTP error must never disrupt the agent. Failures are buffered
 * and retried on the next flush; nothing is thrown back into the session.
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';

import {
  CloudIngestClient,
  loadCloudTokens,
  loadSettings,
  saveCloudTokens,
  type AgentEventInput,
  type AgentSession,
  type CloudTokens,
} from '@harnext/core';
import {
  UsageAccumulator,
  buildAssistantEnvelope,
  buildInitEnvelope,
  buildResultEnvelope,
  buildToolResultEnvelope,
  extractText,
  type ResultSubtype,
} from '../modes/sdk-output.js';

/** Hard cap on buffered-but-unsent events so a long offline run can't grow unbounded. */
const MAX_BUFFER = 5000;
/**
 * Upper bound on how long `finalize()` may block the caller at exit. Even against
 * a server that accepts the connection but never responds, the user waits at most
 * this long (and ~0 in the common cases: healthy, or down → instant refusal).
 * Overridable for tests.
 */
function finalizeGraceMs(): number {
  const raw = Number(process.env.HARNEXT_CLOUD_FINALIZE_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Map a terminal subtype to the session-level stop_reason stored by the engine. */
const STOP_REASON: Record<ResultSubtype, string> = {
  success: 'completed',
  error_max_turns: 'max_turns',
  error_during_execution: 'error',
};

export interface ConversationUploaderHandle {
  /** Flush the tail, push the terminal result, and close the session. */
  finalize(): Promise<void>;
}

export interface UploaderMeta {
  cwd: string;
  permissionMode?: string;
  /** First user prompt, used as the conversation title when known (print mode). */
  title?: string;
}

const NOOP: ConversationUploaderHandle = { finalize: async () => {} };

let hintShown = false;
function showLoginHint(): void {
  if (hintShown) return;
  hintShown = true;
  process.stderr.write(
    'harnext: cloud sync is on but this machine is not connected — run `harnext connect` to push conversations.\n',
  );
}

function debug(err: unknown): void {
  if (process.env.HARNEXT_CLOUD_DEBUG) {
    process.stderr.write(`harnext cloud sync: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Wire conversation upload to a session. Returns a no-op handle (and never
 * throws) when cloud sync is disabled or this machine isn't connected.
 */
export function attachConversationUploader(
  session: AgentSession,
  meta: UploaderMeta,
): ConversationUploaderHandle {
  const cfg = loadSettings(meta.cwd).cloudSync;
  const endpoint = process.env.HARNEXT_CONTEXT_ENGINE_URL ?? cfg.endpoint;
  if (!cfg.enabled || !endpoint) return NOOP;

  const tokens = loadCloudTokens();
  if (!tokens) {
    showLoginHint();
    return NOOP;
  }

  return new ConversationUploader(session, { ...tokens, endpoint }, cfg.harness, meta);
}

class ConversationUploader implements ConversationUploaderHandle {
  private readonly buffer: AgentEventInput[] = [];
  private readonly usage = new UsageAccumulator();
  private readonly client: CloudIngestClient;
  /** Fires on finalize to cancel any in-flight request so nothing keeps the process alive. */
  private readonly aborter = new AbortController();
  private seq = 0;
  private serverSessionId: string | null = null;
  private title?: string;
  private lastAssistantText = '';
  private errored = false;
  private flushChain: Promise<void> = Promise.resolve();
  private disabled = false;
  private finalized = false;

  constructor(
    private readonly session: AgentSession,
    tokens: CloudTokens,
    private readonly harness: string,
    private readonly meta: UploaderMeta,
  ) {
    this.client = new CloudIngestClient(tokens, saveCloudTokens, { signal: this.aborter.signal });
    this.title = meta.title;
    // The init envelope is the first turn (seq 0).
    this.record('system', buildInitEnvelope(session, meta.cwd, meta.permissionMode));

    session.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case 'message_end':
          if (event.message.role === 'assistant') {
            const msg = event.message as { usage?: unknown; content?: unknown };
            this.usage.add(msg.usage);
            const text = extractText(event.message.content);
            if (text) this.lastAssistantText = text;
            this.record('assistant', buildAssistantEnvelope(event.message, session.sessionId));
          } else if (event.message.role === 'user' && !this.title) {
            const text = extractText((event.message as { content?: unknown }).content);
            if (text) this.title = text.slice(0, 500);
          }
          break;
        case 'tool_execution_end':
          this.record(
            'user',
            buildToolResultEnvelope(event.toolCallId, event.result, event.isError, session.sessionId),
          );
          break;
        case 'turn_end':
          void this.flush();
          break;
      }
    });
  }

  private record(type: string, payload: unknown): void {
    if (this.disabled) return;
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift(); // drop oldest, stay bounded
    this.buffer.push({ seq: this.seq++, type, payload });
  }

  /** Serialize flushes so a turn_end and finalize can't race on the wire. */
  private flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }

  private async doFlush(): Promise<void> {
    if (this.disabled || this.buffer.length === 0) return;
    try {
      if (!this.serverSessionId) {
        const opened = await this.client.openSession({
          client_session_id: this.session.sessionId,
          harness: this.harness,
          model: this.session.model.id,
          cwd: this.meta.cwd,
          title: this.title,
        });
        this.serverSessionId = opened.id;
      }
      const batch = this.buffer.splice(0, this.buffer.length);
      await this.client.appendEvents(this.serverSessionId, batch);
    } catch (err) {
      debug(err);
      // Keep whatever is still buffered for the next flush; openSession failures
      // leave the batch intact because we splice only after it succeeds.
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    const subtype: ResultSubtype = this.session.maxTurnsReached
      ? 'error_max_turns'
      : this.errored || this.session.state.errorMessage
        ? 'error_during_execution'
        : 'success';
    const { usage, cost } = this.usage.totals;
    this.record(
      'result',
      buildResultEnvelope({
        subtype,
        resultText: this.lastAssistantText,
        sessionId: this.session.sessionId,
        numTurns: this.session.turnCount,
        durationMs: 0,
        usage,
        totalCostUsd: cost,
      }),
    );

    // Flush the tail + close the session, but never make the user wait more than
    // the grace window: a black-holing server is raced out, not waited on.
    const work = (async () => {
      await this.flush();
      try {
        if (this.serverSessionId) {
          await this.client.finalize(this.serverSessionId, {
            stop_reason: STOP_REASON[subtype],
            usage: { ...usage, total_cost_usd: cost },
          });
        }
      } catch (err) {
        debug(err);
      }
    })();

    await Promise.race([work, sleep(finalizeGraceMs())]);
    // Cancel anything still in flight so a stalled request can't keep the
    // process alive after we've returned.
    this.aborter.abort();
    this.disabled = true;
  }
}
