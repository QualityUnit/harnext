import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';

import {
  compactNow,
  createCompaction,
  findCutPoint,
  getContextTokens,
  serializeConversation,
} from '../src/compaction.js';

// Minimal fake of pi-agent-core's Agent — just enough surface for the
// compaction routines (state.messages getter/setter and state.model).
function makeFakeAgent(messages: AgentMessage[], contextWindow = 200_000): {
  state: {
    messages: AgentMessage[];
    model: { contextWindow: number; provider: string; id: string; api: string };
  };
  transformContext?: unknown;
} {
  const internal: { _messages: AgentMessage[] } = { _messages: [...messages] };
  return {
    state: {
      get messages(): AgentMessage[] {
        return internal._messages;
      },
      set messages(next: AgentMessage[]) {
        internal._messages = [...next];
      },
      model: {
        contextWindow,
        provider: 'fake',
        id: 'fake-model',
        api: 'fake',
      },
    } as unknown as {
      messages: AgentMessage[];
      model: { contextWindow: number; provider: string; id: string; api: string };
    },
  };
}

function userMsg(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function asstMsg(text: string, usage: { input: number; output: number }): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'fake' as never,
    provider: 'fake' as never,
    model: 'fake-model',
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function asstWithToolCall(
  toolName: string,
  args: Record<string, unknown>,
  usage: { input: number; output: number } = { input: 0, output: 0 },
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 't1', name: toolName, arguments: args }],
    api: 'fake' as never,
    provider: 'fake' as never,
    model: 'fake-model',
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

function toolResult(toolName: string, text: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 't1',
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  };
}

/**
 * Build N user→assistant turns with realistic cumulative token growth.
 * Each turn adds `perTurnGrowth` to the running prefix size, mirroring how
 * a real conversation's `usage.input` grows monotonically across turns.
 */
function makeTurns(
  count: number,
  perTurnGrowth = 1000,
  outputPerTurn = 200,
  startingPrefix = 100,
): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  let cumPrefix = startingPrefix;
  for (let i = 0; i < count; i++) {
    msgs.push(userMsg(`q${i}`));
    cumPrefix += perTurnGrowth;
    // The assistant for turn i sees `cumPrefix` tokens of input (everything
    // up to and including user_i). Its output is `outputPerTurn` tokens,
    // which become part of the next turn's input.
    msgs.push(asstMsg(`a${i}`, { input: cumPrefix, output: outputPerTurn }));
    cumPrefix += outputPerTurn;
  }
  return msgs;
}

describe('getContextTokens', () => {
  it('returns 0 when there is no measured assistant turn', () => {
    expect(getContextTokens([userMsg('hi')])).toBe(0);
  });

  it('returns last assistant input + output, ignoring older assistants', () => {
    // Even though there are 3 turns, the answer is JUST the last turn's
    // input + output — no summing across turns (their input fields are
    // cumulative and would double-count).
    const msgs = makeTurns(3, 1000, 200, 100);
    // Last turn: cumPrefix went 100 → 1100 (turn 0) → 1300 (after output)
    //   → 2300 (turn 1 input) → 2500 → 3500 (turn 2 input).
    // Last assistant: input=3500, output=200 → 3700.
    expect(getContextTokens(msgs)).toBe(3700);
  });

  it('skips assistants with empty (error/aborted) usage', () => {
    const msgs: AgentMessage[] = [
      userMsg('hi'),
      asstMsg('first', { input: 200, output: 50 }),
      userMsg('next'),
      asstMsg('errored', { input: 0, output: 0 }), // simulated error
    ];
    expect(getContextTokens(msgs)).toBe(250);
  });
});

describe('findCutPoint', () => {
  it('returns 0 when the measured context already fits in keepRecentTokens', () => {
    const msgs = makeTurns(3, 100, 50, 50); // small turns, total < 1000
    expect(findCutPoint(msgs, 10_000)).toBe(0);
  });

  it('returns -1 when there is no measured assistant', () => {
    expect(findCutPoint([userMsg('hi')], 1000)).toBe(-1);
  });

  it('cuts at a user-message boundary based on usage.input', () => {
    // 10 turns of 1000 prefix-growth, 200 output. Last input ≈ 11_300, +200 = 11_500.
    // keepRecentTokens = 3000 → maxAllowedPrefix = 8500.
    // Find latest assistant whose input <= 8500. That's turn 7 (input ≈ 8300).
    // Cut at user_7 — index 14.
    const msgs = makeTurns(10, 1000, 200, 100);
    const cut = findCutPoint(msgs, 3000);
    expect(cut).toBeGreaterThan(0);
    expect(msgs[cut].role).toBe('user');
    // Verify the kept tail size is at least keepRecentTokens.
    // kept tokens ≈ totalCurrent - cutAssistantInput.
    const lastAsst = msgs[msgs.length - 1] as AssistantMessage;
    const totalCurrent = lastAsst.usage.input + lastAsst.usage.output;
    // The assistant just after `cut` is the cut-assistant.
    const cutAsst = msgs[cut + 1] as AssistantMessage;
    expect(totalCurrent - cutAsst.usage.input).toBeGreaterThanOrEqual(3000);
  });

  it('never starts the kept range with a toolResult', () => {
    // Build: u, a(toolCall), t, a(final), then many turns with growing usage.
    const head: AgentMessage[] = [
      userMsg('original'),
      asstWithToolCall('read', { path: 'a.ts' }, { input: 0, output: 0 }),
      toolResult('read', 'x'.repeat(1000)),
      asstMsg('done with tool', { input: 800, output: 100 }),
    ];
    const tail = makeTurns(8, 800, 150, 900);
    const msgs = [...head, ...tail];
    const cut = findCutPoint(msgs, 2000);
    if (cut > 0) {
      expect(msgs[cut].role).toBe('user');
    }
  });
});

describe('serializeConversation', () => {
  it('formats user/assistant/tool messages with tagged labels', () => {
    const text = serializeConversation([
      userMsg('hello'),
      asstMsg('hi there', { input: 10, output: 5 }),
      asstWithToolCall('read', { path: 'foo.ts' }),
      toolResult('read', 'file contents'),
    ]);
    expect(text).toMatch(/\[User\]: hello/);
    expect(text).toMatch(/\[Assistant\]: hi there/);
    expect(text).toMatch(/\[Assistant tool calls\]: read\(/);
    expect(text).toMatch(/\[Tool result: read\] file contents/);
  });

  it('truncates very long tool results', () => {
    const long = 'x'.repeat(5000);
    const text = serializeConversation([toolResult('bash', long)]);
    expect(text).toMatch(/\[truncated/);
    expect(text.length).toBeLessThan(long.length);
  });
});

vi.mock('@earendil-works/pi-ai', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-ai')>(
    '@earendil-works/pi-ai',
  );
  return {
    ...actual,
    streamSimple: vi.fn(async function* fakeStream() {
      yield { type: 'text_delta', delta: '## Goal\nTest\n## Critical Context\n- ok' };
    }),
  };
});

describe('compactNow', () => {
  it('does nothing when there are no measured turns yet', async () => {
    const agent = makeFakeAgent([userMsg('hello')]);
    const result = await compactNow(agent as never);
    expect(result.compacted).toBe(false);
    expect(agent.state.messages.length).toBe(1);
  });

  it('summarizes and replaces the prefix once context exceeds keepRecentTokens', async () => {
    const msgs = makeTurns(20, 2000, 300, 100);
    const agent = makeFakeAgent(msgs);
    const before = agent.state.messages.length;
    const result = await compactNow(agent as never, { keepRecentTokens: 5000 });
    expect(result.compacted).toBe(true);
    expect(agent.state.messages.length).toBeLessThan(before);
    const first = agent.state.messages[0] as UserMessage;
    expect(first.role).toBe('user');
    expect(typeof first.content === 'string' && first.content.startsWith('[Compacted summary')).toBe(
      true,
    );
  });

  it('forwards custom instructions to the summarizer', async () => {
    const piAi = await import('@earendil-works/pi-ai');
    const streamSpy = piAi.streamSimple as unknown as ReturnType<typeof vi.fn>;
    streamSpy.mockClear();

    const msgs = makeTurns(15, 2000, 200, 100);
    const agent = makeFakeAgent(msgs);
    await compactNow(agent as never, {
      keepRecentTokens: 3000,
      instructions: 'focus on the auth flow',
    });

    expect(streamSpy).toHaveBeenCalled();
    const callArgs = streamSpy.mock.calls[0];
    const ctx = callArgs[1] as { messages: { content: string }[] };
    expect(ctx.messages[0].content).toMatch(/focus on the auth flow/);
  });
});

describe('createCompaction transformContext', () => {
  it('is a no-op when measured context fits within budget', async () => {
    const msgs = makeTurns(2, 100, 50, 100); // total ~ 450 tokens
    const agent = makeFakeAgent(msgs, 200_000);
    const transform = createCompaction(agent as never, agent.state.model as never, {
      reserveTokens: 1000,
      keepRecentTokens: 1000,
    });
    const result = await transform(agent.state.messages, undefined);
    expect(result.length).toBe(msgs.length);
    expect(agent.state.messages.length).toBe(msgs.length);
  });

  it('triggers compaction the moment lastInput + lastOutput exceeds the budget', async () => {
    // contextWindow=10_000, reserveTokens=2000 → budget=8000.
    // 12 turns * 1000 growth + 200 output → last input ~12_100, last total ~12_300.
    const msgs = makeTurns(12, 1000, 200, 100);
    const agent = makeFakeAgent(msgs, 10_000);
    const transform = createCompaction(agent as never, agent.state.model as never, {
      reserveTokens: 2000,
      keepRecentTokens: 3000,
    });
    const before = agent.state.messages.length;
    const result = await transform(agent.state.messages, undefined);
    expect(result.length).toBeLessThan(before);
    // Persisted onto the agent's state, not just returned for the LLM call.
    expect(agent.state.messages.length).toBe(result.length);
    expect(agent.state.messages[0].role).toBe('user');
    const first = agent.state.messages[0] as UserMessage;
    expect(typeof first.content === 'string' && first.content.startsWith('[Compacted summary')).toBe(
      true,
    );
  });

  it('does NOT trigger when context is under budget even if the conversation is long', async () => {
    const msgs = makeTurns(50, 100, 50, 50); // many turns but small per-turn growth
    const agent = makeFakeAgent(msgs, 200_000);
    const transform = createCompaction(agent as never, agent.state.model as never, {
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });
    const before = agent.state.messages.length;
    const result = await transform(agent.state.messages, undefined);
    expect(result.length).toBe(before);
  });
});
