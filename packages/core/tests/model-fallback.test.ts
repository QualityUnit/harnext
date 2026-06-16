import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import {
  isRetryableStreamError,
  streamWithFallback,
  type FallbackAttempt,
} from '../src/model-fallback.js';

// ── Event/stream fixtures ───────────────────────────────────────────

function assistantMessage(text: string, errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: errorMessage ? 'error' : 'stop',
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  };
}

/** Synchronously build a stream pre-loaded with `events` and ended. */
function streamOf(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const s = createAssistantMessageEventStream();
  for (const e of events) s.push(e);
  s.end();
  return s;
}

function successStream(text = 'hello'): AssistantMessageEventStream {
  const msg = assistantMessage(text);
  return streamOf([
    { type: 'start', partial: msg } as AssistantMessageEvent,
    { type: 'done', reason: 'stop', message: msg } as AssistantMessageEvent,
  ]);
}

function errorStream(errorMessage: string): AssistantMessageEventStream {
  return streamOf([
    { type: 'error', reason: 'error', error: assistantMessage('', errorMessage) } as AssistantMessageEvent,
  ]);
}

/** Drain a stream into the list of event types it emits, in order. */
async function drainTypes(stream: AssistantMessageEventStream): Promise<string[]> {
  const types: string[] = [];
  for await (const e of stream) types.push(e.type);
  return types;
}

const CTX = { systemPrompt: '', messages: [], tools: [] } as unknown as Context;
const OPTS = {} as SimpleStreamOptions;

function model(id: string, provider = 'anthropic'): Model<string> {
  return { id, provider, api: 'anthropic-messages' } as Model<string>;
}

function attempt(id: string): FallbackAttempt {
  return { model: model(id), opts: OPTS };
}

// ── isRetryableStreamError ──────────────────────────────────────────

describe('isRetryableStreamError', () => {
  it('treats rate-limit / 5xx / network errors as retryable', () => {
    for (const msg of [
      '429 Too Many Requests',
      'HTTP 503 Service Unavailable',
      '500 internal server error',
      '502 Bad Gateway',
      '504 gateway timeout',
      '529 overloaded_error: Overloaded',
      'request timed out',
      'socket hang up',
      'ECONNRESET',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      'connection refused',
    ]) {
      expect(isRetryableStreamError(msg), msg).toBe(true);
    }
  });

  it('treats auth / bad-request errors as NOT retryable', () => {
    for (const msg of [
      '401 Unauthorized',
      '403 Forbidden: permission denied',
      '400 Bad Request',
      '404 model not found',
      '422 Unprocessable Entity',
      'invalid x-api-key',
      '',
      undefined,
    ]) {
      expect(isRetryableStreamError(msg), String(msg)).toBe(false);
    }
  });

  it('does not match a retryable code embedded in a larger number', () => {
    // "5000" must not trip the \b500\b branch, and there are no retryable phrases.
    expect(isRetryableStreamError('used 5000 tokens of 429000 budget')).toBe(false);
  });
});

// ── streamWithFallback ──────────────────────────────────────────────

describe('streamWithFallback', () => {
  it('returns the primary stream and never touches the fallback on success', async () => {
    const fallbackFactory = vi.fn(successStream);
    const streamFn = vi.fn((m: Model<string>) =>
      m.id === 'primary' ? successStream('from primary') : fallbackFactory(),
    );

    const stream = await streamWithFallback(
      CTX,
      [attempt('primary'), attempt('fallback')],
      streamFn,
    );

    expect(await drainTypes(stream)).toEqual(['start', 'done']);
    const result = await stream.result();
    expect(result.content).toEqual([{ type: 'text', text: 'from primary' }]);
    expect(streamFn).toHaveBeenCalledTimes(1); // fallback not attempted
    expect(fallbackFactory).not.toHaveBeenCalled();
  });

  it('falls back to the second model on a retryable pre-stream error (429)', async () => {
    const streamFn = vi.fn((m: Model<string>) =>
      m.id === 'primary' ? errorStream('429 Too Many Requests') : successStream('from fallback'),
    );

    const stream = await streamWithFallback(
      CTX,
      [attempt('primary'), attempt('fallback')],
      streamFn,
    );

    // The consumer sees ONLY the fallback's events — the primary error is swallowed.
    expect(await drainTypes(stream)).toEqual(['start', 'done']);
    expect((await stream.result()).content).toEqual([{ type: 'text', text: 'from fallback' }]);
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(streamFn.mock.calls[0][0].id).toBe('primary');
    expect(streamFn.mock.calls[1][0].id).toBe('fallback');
  });

  it('does NOT fall back on a non-retryable error (propagates the error event)', async () => {
    const streamFn = vi.fn((m: Model<string>) =>
      m.id === 'primary' ? errorStream('401 Unauthorized') : successStream(),
    );

    const stream = await streamWithFallback(
      CTX,
      [attempt('primary'), attempt('fallback')],
      streamFn,
    );

    expect(await drainTypes(stream)).toEqual(['error']);
    expect((await stream.result()).errorMessage).toBe('401 Unauthorized');
    expect(streamFn).toHaveBeenCalledTimes(1); // fallback not attempted
  });

  it('surfaces the last error when every attempt fails retryably (no hang)', async () => {
    const streamFn = vi.fn((m: Model<string>) =>
      errorStream(m.id === 'primary' ? '503 Service Unavailable' : '429 rate limit'),
    );

    const stream = await streamWithFallback(
      CTX,
      [attempt('primary'), attempt('fallback')],
      streamFn,
    );

    expect(await drainTypes(stream)).toEqual(['error']);
    expect((await stream.result()).errorMessage).toBe('429 rate limit');
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a mid-stream error (error after the first chunk)', async () => {
    // Primary yields a `start` (first chunk) THEN errors — too late to swap.
    const midStreamError = (): AssistantMessageEventStream =>
      streamOf([
        { type: 'start', partial: assistantMessage('partial') } as AssistantMessageEvent,
        { type: 'error', reason: 'error', error: assistantMessage('partial', '503 mid') } as AssistantMessageEvent,
      ]);
    const streamFn = vi.fn((m: Model<string>) =>
      m.id === 'primary' ? midStreamError() : successStream(),
    );

    const stream = await streamWithFallback(
      CTX,
      [attempt('primary'), attempt('fallback')],
      streamFn,
    );

    expect(await drainTypes(stream)).toEqual(['start', 'error']);
    expect(streamFn).toHaveBeenCalledTimes(1); // first chunk already committed
  });

  it('replays a multi-event success faithfully', async () => {
    const msg = assistantMessage('streamed');
    const multi = (): AssistantMessageEventStream =>
      streamOf([
        { type: 'start', partial: msg } as AssistantMessageEvent,
        { type: 'text_delta', delta: 'str', contentIndex: 0, partial: msg } as AssistantMessageEvent,
        { type: 'text_delta', delta: 'eamed', contentIndex: 0, partial: msg } as AssistantMessageEvent,
        { type: 'done', reason: 'stop', message: msg } as AssistantMessageEvent,
      ]);
    const stream = await streamWithFallback(CTX, [{ model: model('m'), opts: OPTS }], multi);
    expect(await drainTypes(stream)).toEqual(['start', 'text_delta', 'text_delta', 'done']);
  });

  it('propagates a synchronous non-retryable throw (e.g. missing API key)', async () => {
    const streamFn = vi.fn(() => {
      throw new Error('No API key for provider: anthropic');
    });
    await expect(
      streamWithFallback(CTX, [attempt('primary'), attempt('fallback')], streamFn),
    ).rejects.toThrow('No API key');
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it('falls back when the primary throws synchronously with a retryable message', async () => {
    const streamFn = vi.fn((m: Model<string>) => {
      if (m.id === 'primary') throw new Error('503 service unavailable');
      return successStream('recovered');
    });
    const stream = await streamWithFallback(
      CTX,
      [attempt('primary'), attempt('fallback')],
      streamFn,
    );
    expect((await stream.result()).content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it('uses a custom isRetryable predicate when provided', async () => {
    const streamFn = vi.fn((m: Model<string>) =>
      m.id === 'primary' ? errorStream('teapot') : successStream('brewed'),
    );
    const stream = await streamWithFallback(
      CTX,
      [attempt('primary'), attempt('fallback')],
      streamFn,
      (msg) => msg === 'teapot',
    );
    expect((await stream.result()).content).toEqual([{ type: 'text', text: 'brewed' }]);
  });

  it('throws when given no attempts', async () => {
    await expect(streamWithFallback(CTX, [], vi.fn())).rejects.toThrow('at least one attempt');
  });
});
