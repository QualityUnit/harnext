import { describe, expect, it } from 'vitest';

import {
  UsageAccumulator,
  buildAssistantEnvelope,
  buildInitEnvelope,
  buildResultEnvelope,
  buildToolResultEnvelope,
  extractText,
  extractUserTextFromStreamJsonLine,
  mapAssistantContent,
  mapUsage,
} from '../src/modes/sdk-output.js';

const usage = {
  input: 100,
  output: 40,
  cacheRead: 7,
  cacheWrite: 3,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
};

describe('mapUsage', () => {
  it('maps pi-ai usage to Claude SDK token fields', () => {
    expect(mapUsage(usage)).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
    });
  });
});

describe('extractText', () => {
  it('joins text blocks and ignores non-text', () => {
    expect(
      extractText([
        { type: 'text', text: 'a' },
        { type: 'toolCall', name: 'bash' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
    expect(extractText('plain')).toBe('plain');
  });
});

describe('extractUserTextFromStreamJsonLine', () => {
  it('reads a Claude user envelope with string content', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
    expect(extractUserTextFromStreamJsonLine(line)).toBe('hello');
  });

  it('reads a bare {role:"user"} message and joins text blocks', () => {
    const line = JSON.stringify({
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', source: {} },
        { type: 'text', text: 'b' },
      ],
    });
    expect(extractUserTextFromStreamJsonLine(line)).toBe('a\nb');
  });

  it('returns null for blank, malformed, non-user, or empty-content lines', () => {
    expect(extractUserTextFromStreamJsonLine('   ')).toBeNull();
    expect(extractUserTextFromStreamJsonLine('not json')).toBeNull();
    expect(
      extractUserTextFromStreamJsonLine(JSON.stringify({ type: 'assistant', message: {} })),
    ).toBeNull();
    expect(
      extractUserTextFromStreamJsonLine(
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image' }] } }),
      ),
    ).toBeNull();
  });
});

describe('mapAssistantContent', () => {
  it('maps text/thinking/toolCall to SDK blocks with canonical tool names', () => {
    const blocks = mapAssistantContent([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
    ]);
    expect(blocks).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });
});

describe('buildInitEnvelope', () => {
  it('emits a system/init envelope with canonical tool names', () => {
    const session = {
      sessionId: 's1',
      model: { id: 'claude-opus-4-8' },
      tools: [{ name: 'read' }, { name: 'bash' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const env = buildInitEnvelope(session, '/work', 'dontAsk');
    expect(env).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'claude-opus-4-8',
      cwd: '/work',
      tools: ['Read', 'Bash'],
      permissionMode: 'dontAsk',
    });
  });
});

describe('buildAssistantEnvelope', () => {
  it('wraps an assistant message', () => {
    const env = buildAssistantEnvelope(
      { model: 'm', content: [{ type: 'text', text: 'hi' }], usage, stopReason: 'stop' },
      's1',
    );
    expect(env.type).toBe('assistant');
    expect(env.session_id).toBe('s1');
    expect(env.message.role).toBe('assistant');
    expect(env.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(env.message.usage.input_tokens).toBe(100);
  });
});

describe('buildToolResultEnvelope', () => {
  it('emits a user/tool_result envelope', () => {
    const env = buildToolResultEnvelope(
      't1',
      { content: [{ type: 'text', text: 'output' }] },
      false,
      's1',
    );
    expect(env).toMatchObject({
      type: 'user',
      session_id: 's1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output', is_error: false }],
      },
    });
  });
});

describe('buildResultEnvelope', () => {
  it('marks success vs error subtypes', () => {
    const base = {
      resultText: 'done',
      sessionId: 's1',
      numTurns: 2,
      durationMs: 10,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      totalCostUsd: 0.01,
    };
    expect(buildResultEnvelope({ ...base, subtype: 'success' }).is_error).toBe(false);
    expect(buildResultEnvelope({ ...base, subtype: 'error_max_turns' }).is_error).toBe(true);
    expect(buildResultEnvelope({ ...base, subtype: 'success' })).toMatchObject({
      type: 'result',
      result: 'done',
      num_turns: 2,
      total_cost_usd: 0.01,
    });
  });
});

describe('UsageAccumulator', () => {
  it('sums tokens and cost across messages', () => {
    const acc = new UsageAccumulator();
    acc.add(usage);
    acc.add(usage);
    const { usage: totals, cost } = acc.totals;
    expect(totals.input_tokens).toBe(200);
    expect(totals.output_tokens).toBe(80);
    expect(cost).toBeCloseTo(0.1);
  });
});
