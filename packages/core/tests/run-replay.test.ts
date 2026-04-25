import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRunLogEvent } from '../src/coding-agent-runner.js';
import {
  getGithubRunsDir,
  listAgentRunLogs,
  reconstructMessagesFromEvents,
  type AgentRunLogRecord,
} from '../src/run-replay.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;
beforeAll(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-run-replay-'));
  process.env.HARNEXT_HOME = harnextHome;
});
afterAll(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<AgentRunLogRecord> = {}): AgentRunLogRecord {
  return {
    ts: '2026-04-19T13:25:02.217Z',
    itemNumber: 46,
    itemKind: 'issue',
    stageId: 'triage',
    stageLabel: 'agent:triage',
    mode: 'yolo',
    exit: 0,
    durationMs: 123,
    prompt: 'hello',
    events: [],
    ...overrides,
  };
}

describe('listAgentRunLogs', () => {
  let dir: string;
  let runsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnext-run-replay-'));
    runsDir = getGithubRunsDir(dir);
    mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('returns [] when the dir does not exist', () => {
    rmSync(runsDir, { recursive: true, force: true });
    expect(listAgentRunLogs(dir)).toEqual([]);
  });

  it('lists runs newest-first with event counts', () => {
    const older = makeRecord({
      ts: '2026-04-19T13:25:02.217Z',
      stageId: 'triage',
      events: [
        { ts: 'a', type: 'message_end', role: 'user', text: 'hi' },
      ],
    });
    const newer = makeRecord({
      ts: '2026-04-19T13:30:02.040Z',
      stageId: 'implement',
      events: [
        { ts: 'a', type: 'message_end', role: 'user', text: 'hi' },
        { ts: 'b', type: 'message_end', role: 'assistant', text: 'done' },
      ],
    });
    writeFileSync(
      join(runsDir, 'a-issue-46-triage.json'),
      JSON.stringify(older),
    );
    writeFileSync(
      join(runsDir, 'b-issue-46-implement.json'),
      JSON.stringify(newer),
    );

    const runs = listAgentRunLogs(dir);
    expect(runs.map((r) => r.stageId)).toEqual(['implement', 'triage']);
    expect(runs[0].eventCount).toBe(2);
    expect(runs[1].eventCount).toBe(1);
  });

  it('skips malformed files without throwing', () => {
    writeFileSync(
      join(runsDir, 'bad.json'),
      '{ not valid json',
    );
    const good = makeRecord();
    writeFileSync(
      join(runsDir, 'good.json'),
      JSON.stringify(good),
    );
    expect(listAgentRunLogs(dir)).toHaveLength(1);
  });
});

describe('reconstructMessagesFromEvents', () => {
  it('round-trips a simple user/assistant exchange', () => {
    const events: AgentRunLogEvent[] = [
      { ts: '2026-04-19T00:00:00Z', type: 'message_end', role: 'user', text: 'fix the bug' },
      { ts: '2026-04-19T00:00:01Z', type: 'message_end', role: 'assistant', text: 'on it' },
    ];
    const messages = reconstructMessagesFromEvents(events);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'fix the bug' });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'on it' }],
      stopReason: 'stop',
    });
  });

  it('attaches tool calls to the preceding assistant message and emits tool results', () => {
    const events: AgentRunLogEvent[] = [
      { ts: 't0', type: 'message_end', role: 'user', text: 'list files' },
      { ts: 't1', type: 'message_end', role: 'assistant', text: 'checking' },
      {
        ts: 't2',
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      },
      {
        ts: 't3',
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'Bash',
        toolOutput: 'a.ts\nb.ts',
        isError: false,
      },
    ];
    const messages = reconstructMessagesFromEvents(events);
    expect(messages).toHaveLength(3);
    const asst = messages[1] as { content: Array<{ type: string; [k: string]: unknown }> };
    expect(asst.content.find((c) => c.type === 'toolCall')).toMatchObject({
      id: 'call_1',
      name: 'Bash',
      arguments: { command: 'ls' },
    });
    expect(messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'Bash',
      isError: false,
      content: [{ type: 'text', text: 'a.ts\nb.ts' }],
    });
  });

  it('does not attach tool calls when there is no current assistant', () => {
    const events: AgentRunLogEvent[] = [
      {
        ts: 't0',
        type: 'tool_execution_start',
        toolCallId: 'orphan',
        toolName: 'Bash',
        toolInput: {},
      },
      {
        ts: 't1',
        type: 'tool_execution_end',
        toolCallId: 'orphan',
        toolName: 'Bash',
        toolOutput: 'out',
      },
    ];
    const messages = reconstructMessagesFromEvents(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('toolResult');
  });
});
