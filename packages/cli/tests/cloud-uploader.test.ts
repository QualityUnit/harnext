import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachConversationUploader } from '../src/cloud/uploader.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ENDPOINT = 'http://engine';
let tmpHome: string;
let originalHome: string | undefined;

interface Captured {
  url: string;
  body: any;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function writeConfig(enabled: boolean, withTokens: boolean): void {
  const agentDir = join(tmpHome, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ cloudSync: { enabled, endpoint: ENDPOINT } }),
  );
  if (withTokens) {
    writeFileSync(
      join(agentDir, 'context-engine.json'),
      JSON.stringify({
        endpoint: ENDPOINT,
        clientId: 'harnext-cli',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        accessExpiresAt: Date.now() + 3_600_000,
      }),
    );
  }
}

/** A minimal stand-in for AgentSession exposing only what the uploader reads. */
function fakeSession() {
  let listener: ((e: any) => void) | undefined;
  const session = {
    sessionId: 's-1',
    model: { id: 'opus' },
    tools: [{ name: 'read' }],
    turnCount: 1,
    maxTurnsReached: false,
    state: { errorMessage: undefined as string | undefined },
    subscribe: (fn: (e: any) => void) => {
      listener = fn;
      return () => {};
    },
  };
  return { session: session as any, emit: (e: any) => listener?.(e) };
}

function stubFetch(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/agent/sessions')) return jsonResponse(200, { id: 'srv', status: 'open' });
      if (url.endsWith('/events'))
        return jsonResponse(200, { session_id: 'srv', accepted: 1, duplicates: 0, max_seq: 0 });
      if (url.endsWith('/finalize')) return jsonResponse(200, { id: 'srv', status: 'closed' });
      return jsonResponse(404, {});
    }),
  );
  return calls;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'harnext-uploader-'));
  originalHome = process.env.HARNEXT_HOME;
  process.env.HARNEXT_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('attachConversationUploader', () => {
  it('opens, appends ordered envelopes, and finalizes', async () => {
    writeConfig(true, true);
    const calls = stubFetch();
    const { session, emit } = fakeSession();

    const handle = attachConversationUploader(session, { cwd: tmpHome, title: 'hello world' });

    emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input: 5, output: 2 } },
    });
    emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      result: { content: [{ type: 'text', text: 'out' }] },
      isError: false,
    });
    emit({ type: 'turn_end', toolResults: [{}] });
    await handle.finalize();

    // open → events(0,1,2) → events(3=result) → finalize
    const open = calls.find((c) => c.url.endsWith('/agent/sessions'))!;
    expect(open.body).toMatchObject({
      client_session_id: 's-1',
      harness: 'harnext',
      model: 'opus',
      title: 'hello world',
    });

    const eventBatches = calls.filter((c) => c.url.endsWith('/events'));
    const allEvents = eventBatches.flatMap((c) => c.body.events as any[]);
    expect(allEvents.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(allEvents.map((e) => e.type)).toEqual(['system', 'assistant', 'user', 'result']);
    expect(allEvents[0].payload).toMatchObject({ type: 'system', subtype: 'init' });

    const finalize = calls.find((c) => c.url.endsWith('/finalize'))!;
    expect(finalize.body.stop_reason).toBe('completed');
  });

  it('reports max_turns as the stop reason', async () => {
    writeConfig(true, true);
    const calls = stubFetch();
    const { session, emit } = fakeSession();
    session.maxTurnsReached = true;

    const handle = attachConversationUploader(session, { cwd: tmpHome });
    emit({ type: 'turn_end', toolResults: [{}] });
    await handle.finalize();

    expect(calls.find((c) => c.url.endsWith('/finalize'))!.body.stop_reason).toBe('max_turns');
  });

  it('returns from finalize promptly even when the server never responds', async () => {
    writeConfig(true, true);
    process.env.HARNEXT_CLOUD_FINALIZE_GRACE_MS = '100';
    // Every request hangs until aborted — models a server that accepts the
    // connection but never replies (the worst case for blocking).
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    );
    const { session, emit } = fakeSession();
    const handle = attachConversationUploader(session, { cwd: tmpHome });
    emit({ type: 'turn_end', toolResults: [{}] });

    const start = Date.now();
    await handle.finalize();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // bounded by the ~100ms grace, not the hang

    delete process.env.HARNEXT_CLOUD_FINALIZE_GRACE_MS;
  });

  it('is a no-op when cloud sync is disabled', async () => {
    writeConfig(false, true);
    const calls = stubFetch();
    const { session, emit } = fakeSession();

    const handle = attachConversationUploader(session, { cwd: tmpHome });
    emit({ type: 'turn_end', toolResults: [{}] });
    await handle.finalize();

    expect(calls).toHaveLength(0);
  });

  it('is a no-op (and never throws) when not connected', async () => {
    writeConfig(true, false); // enabled but no stored tokens
    const calls = stubFetch();
    const { session, emit } = fakeSession();

    const handle = attachConversationUploader(session, { cwd: tmpHome });
    emit({ type: 'turn_end', toolResults: [{}] });
    await expect(handle.finalize()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
