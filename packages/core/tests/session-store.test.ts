import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSessionWriter,
  getSessionFilePath,
  listSessions,
  loadSession,
  pruneSessions,
} from '../src/session-store.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;
const CWD = '/tmp/project-under-test';

beforeEach(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-session-store-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterEach(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

function user(text: string, ts = 1): AgentMessage {
  return { role: 'user', content: text, timestamp: ts } as AgentMessage;
}

function assistant(text: string, usage: { input: number; output: number }, ts = 2): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-x',
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: ts,
  } as AgentMessage;
}

describe('createSessionWriter + loadSession', () => {
  it('writes a JSONL transcript that round-trips with usage intact', () => {
    const writer = createSessionWriter({
      cwd: CWD,
      sessionId: 'sess-1',
      provider: 'anthropic',
      model: 'claude-x',
    });
    const messages = [user('fix the bug'), assistant('on it', { input: 1200, output: 40 })];
    writer.record(messages);

    const file = readFileSync(getSessionFilePath(CWD, 'sess-1'), 'utf-8');
    const lines = file.trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'session-meta', sessionId: 'sess-1', provider: 'anthropic' });
    expect(lines).toHaveLength(3); // meta + 2 messages

    const loaded = loadSession('sess-1', CWD);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]).toMatchObject({ role: 'user', content: 'fix the bug' });
    expect((loaded?.messages[1] as { usage: { input: number } }).usage.input).toBe(1200);
  });

  it('appends only the new tail on subsequent records', () => {
    const writer = createSessionWriter({ cwd: CWD, sessionId: 'sess-2' });
    writer.record([user('one'), assistant('a', { input: 10, output: 5 })]);
    writer.record([
      user('one'),
      assistant('a', { input: 10, output: 5 }),
      user('two', 3),
      assistant('b', { input: 30, output: 5 }, 4),
    ]);

    const loaded = loadSession('sess-2', CWD);
    expect(loaded?.messages).toHaveLength(4);
    expect(loaded?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('rewrites the file when history is replaced (compaction)', () => {
    const writer = createSessionWriter({ cwd: CWD, sessionId: 'sess-3' });
    writer.record([user('one', 1), assistant('a', { input: 10, output: 5 }, 2)]);
    // Compaction replaces the array with a new summary head (different timestamp).
    writer.record([user('[Compacted summary of earlier conversation]\n\n…', 99), assistant('b', { input: 5, output: 5 }, 100)]);

    const loaded = loadSession('sess-3', CWD);
    expect(loaded?.messages).toHaveLength(2);
    expect((loaded?.messages[0] as { content: string }).content).toContain('Compacted summary');
    // The picker label keeps the original prompt even though the first message
    // is now a compaction marker (captured into the meta line at creation).
    expect(listSessions(CWD).find((s) => s.sessionId === 'sess-3')?.firstUserMessage).toBe('one');
  });

  it('preserves the original createdAt across resume writes', () => {
    const w1 = createSessionWriter({ cwd: CWD, sessionId: 'sess-4', createdAt: '2020-01-01T00:00:00.000Z' });
    w1.record([user('hi'), assistant('yo', { input: 1, output: 1 })]);
    // A later "resume" writer for the same id must keep the original createdAt.
    const w2 = createSessionWriter({ cwd: CWD, sessionId: 'sess-4' });
    w2.record([user('hi'), assistant('yo', { input: 1, output: 1 }), user('more', 3), assistant('ok', { input: 2, output: 1 }, 4)]);

    expect(loadSession('sess-4', CWD)?.createdAt).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('listSessions', () => {
  it('returns [] for a directory with no sessions', () => {
    expect(listSessions('/tmp/empty-project')).toEqual([]);
  });

  it('lists sessions with the first user message and message count', () => {
    createSessionWriter({ cwd: CWD, sessionId: 'a', model: 'claude-x' }).record([
      user('build a parser'),
      assistant('sure', { input: 5, output: 5 }),
    ]);

    const sessions = listSessions(CWD);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'a',
      messageCount: 2,
      firstUserMessage: 'build a parser',
      model: 'claude-x',
    });
  });

  it('strips a leading system-reminder from the displayed first message', () => {
    createSessionWriter({ cwd: CWD, sessionId: 'b' }).record([
      user('<system-reminder>plan mode</system-reminder>\n\nrefactor the auth module'),
      assistant('ok', { input: 5, output: 5 }),
    ]);
    expect(listSessions(CWD)[0].firstUserMessage).toBe('refactor the auth module');
  });

  it('isolates sessions by cwd', () => {
    createSessionWriter({ cwd: '/tmp/proj-a', sessionId: 'x' }).record([user('a'), assistant('a', { input: 1, output: 1 })]);
    createSessionWriter({ cwd: '/tmp/proj-b', sessionId: 'y' }).record([user('b'), assistant('b', { input: 1, output: 1 })]);
    expect(listSessions('/tmp/proj-a').map((s) => s.sessionId)).toEqual(['x']);
    expect(listSessions('/tmp/proj-b').map((s) => s.sessionId)).toEqual(['y']);
  });
});

describe('pruneSessions', () => {
  it('keeps only the newest N transcripts', () => {
    for (let i = 0; i < 5; i++) {
      createSessionWriter({ cwd: CWD, sessionId: `s${i}` }).record([
        user(`msg ${i}`),
        assistant('ok', { input: 1, output: 1 }),
      ]);
    }
    pruneSessions(CWD, 2);
    expect(listSessions(CWD).length).toBe(2);
  });
});

describe('loadSession', () => {
  it('finds a session by id even without a cwd hint', () => {
    createSessionWriter({ cwd: CWD, sessionId: 'findme' }).record([
      user('hello'),
      assistant('hi', { input: 1, output: 1 }),
    ]);
    const loaded = loadSession('findme');
    expect(loaded?.sessionId).toBe('findme');
    expect(loaded?.messages).toHaveLength(2);
  });

  it('returns undefined for an unknown id', () => {
    expect(loadSession('nope', CWD)).toBeUndefined();
  });
});
