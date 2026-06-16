/**
 * Request-time model fallback ("Layer 1 / availability fallback", issue #51).
 *
 * Every LLM call funnels through the Agent's `streamFn`. When the primary
 * provider is down, rate-limited (429) or returns a 5xx/network error, we want
 * to transparently retry the *same* turn against a configured fallback model.
 *
 * The important runtime detail: pi-ai's `streamSimple` returns an
 * `AssistantMessageEventStream` **synchronously** and does NOT throw on a failed
 * request. A request failure surfaces as a single `{ type: 'error' }` event
 * (carrying an `AssistantMessage` with `stopReason: 'error'` and `errorMessage`)
 * with **no preceding `start` event** — see pi-ai's provider implementations.
 *
 * So a clean retry is only possible *before the first chunk*: we peek the first
 * event of the primary stream; if it is a retryable error we discard it and try
 * the next attempt; otherwise we hand back a stream that **replays** the peeked
 * event(s) and forwards the rest, so the Agent loop consumes it exactly as if it
 * had called `streamSimple` directly (including `.result()`).
 *
 * `streamFn` is allowed to return a `Promise<stream>` (see pi-agent-core's
 * `StreamFn` type), which is what makes the peek-then-return pattern possible.
 *
 * Mid-stream failures (provider dies after partial tokens) cannot be retried
 * here — that needs a turn restart at the Agent-loop level and is out of scope.
 */

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

/** A single model+options attempt; tried in order until one yields a stream. */
export interface FallbackAttempt {
  model: Model<string>;
  opts: SimpleStreamOptions;
}

/** Synchronous stream factory with the shape of pi-ai's `streamSimple`. */
export type SimpleStreamFn = (
  model: Model<string>,
  context: Context,
  opts: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Classify a provider error message as a transient/availability failure worth
 * retrying against a fallback model. We only have the error *message* string at
 * this layer (pi-ai folds the original error's status into
 * `AssistantMessage.errorMessage`), so this is necessarily heuristic — but it
 * keys off the standard HTTP statuses and network error codes.
 *
 * Deliberately conservative: auth/permission/bad-request errors (400/401/403/
 * 404/422) are NOT retryable — failing over wouldn't help and would mask a
 * real misconfiguration.
 */
export function isRetryableStreamError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // Retryable HTTP statuses: 408 timeout, 409 conflict, 425 too-early,
  // 429 rate-limit, 5xx server errors, 529 (Anthropic "overloaded").
  if (/\b(408|409|425|429|500|502|503|504|529)\b/.test(m)) return true;
  // Phrase-based signals (some SDKs don't put the status in the message).
  const phrases = [
    'rate limit',
    'rate-limit',
    'too many requests',
    'overloaded',
    'overload',
    'capacity',
    'timeout',
    'timed out',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'internal server error',
    'temporarily unavailable',
    'connection error',
    'connection reset',
    'connection refused',
    'socket hang up',
    'network error',
    'econnreset',
    'econnrefused',
    'etimedout',
    'enotfound',
    'eai_again',
    'epipe',
  ];
  return phrases.some((p) => m.includes(p));
}

/** Build a synthetic error event so a downstream `result()` always resolves. */
function errorEvent(err: unknown, model: Model<string>): AssistantMessageEvent {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: err instanceof Error ? err.message : String(err),
    timestamp: 0,
  };
  return { type: 'error', reason: 'error', error: message };
}

/**
 * Return a stream that re-emits an already-pulled first event, then forwards the
 * remainder of `iterator`. Mirrors the original stream's iteration + `result()`
 * (the `AssistantMessageEventStream` resolves its result from the `done`/`error`
 * event, so re-pushing the same events reproduces it exactly).
 */
function replayStream(
  first: IteratorResult<AssistantMessageEvent>,
  iterator: AsyncIterator<AssistantMessageEvent>,
  model: Model<string>,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    try {
      let cur = first;
      while (!cur.done) {
        out.push(cur.value);
        cur = await iterator.next();
      }
    } catch (err) {
      // pi-ai's EventStream iterator does not throw, but a custom/injected
      // stream might — surface it as a terminal error event rather than hang.
      out.push(errorEvent(err, model));
    } finally {
      out.end();
    }
  })();
  return out;
}

/** The error message of a peeked `error` event, if that's what it is. */
function peekErrorMessage(
  first: IteratorResult<AssistantMessageEvent>,
): string | undefined {
  if (first.done) return undefined;
  return first.value.type === 'error' ? first.value.error.errorMessage : undefined;
}

/**
 * Try each attempt in order. For all but the last attempt, a retryable error
 * **before the first chunk** advances to the next attempt; anything else (a
 * successful first chunk, a non-retryable error, or the last attempt) is
 * returned to the caller as a faithful replay of the underlying stream.
 *
 * With a single attempt this is a thin pass-through, so wiring it on every call
 * is safe even when no fallback is configured.
 */
export async function streamWithFallback(
  context: Context,
  attempts: FallbackAttempt[],
  streamFn: SimpleStreamFn,
  isRetryable: (message: string | undefined) => boolean = isRetryableStreamError,
): Promise<AssistantMessageEventStream> {
  if (attempts.length === 0) {
    throw new Error('streamWithFallback: at least one attempt is required');
  }
  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const { model, opts } = attempts[i];
    const isLast = i === attempts.length - 1;

    // streamSimple can throw synchronously for setup errors (e.g. a missing
    // API key). Those are not availability failures — only fall through on a
    // retryable message, otherwise propagate.
    let source: AssistantMessageEventStream;
    try {
      source = streamFn(model, context, opts);
    } catch (err) {
      lastError = err;
      if (!isLast && isRetryable(err instanceof Error ? err.message : String(err))) continue;
      throw err;
    }

    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();

    if (!isLast) {
      const errMsg = peekErrorMessage(first);
      if (errMsg !== undefined && isRetryable(errMsg)) {
        lastError = new Error(errMsg);
        continue; // failed before the first chunk → try the fallback
      }
    }
    return replayStream(first, iterator, model);
  }
  // All attempts exhausted via retryable errors but the loop only `continue`s
  // when a later attempt exists, so the final iteration always returns above.
  throw lastError instanceof Error ? lastError : new Error('streamWithFallback: all attempts failed');
}
