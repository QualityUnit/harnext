/**
 * Verification of session token + cost accounting (issue #55).
 *
 * Two layers:
 *  1. `sumSessionUsage` aggregation — pure summation over assistant turns.
 *  2. End-to-end: pi-ai `calculateCost` (per-turn, from real registry rates) →
 *     stored on each assistant message → `sumSessionUsage` totals. This is the
 *     "is cost calculation in a session working" check the issue asks for.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { calculateCost, getModel } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { sumSessionUsage } from '../src/usage.js';

interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function assistant(usage: Partial<Usage> | undefined, ts = 1): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-x',
    ...(usage ? { usage } : {}),
    stopReason: 'stop',
    timestamp: ts,
  } as AgentMessage;
}
function user(text = 'hi', ts = 0): AgentMessage {
  return { role: 'user', content: text, timestamp: ts } as AgentMessage;
}
function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

describe('sumSessionUsage', () => {
  it('returns all-zero totals for an empty session', () => {
    expect(sumSessionUsage([])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
  });

  it('sums tokens and cost across multiple assistant turns', () => {
    const messages = [
      user('q1'),
      assistant({ input: 1000, output: 100, cost: { ...zeroCost(), total: 0.01 } }),
      user('q2'),
      assistant({ input: 1200, output: 150, cost: { ...zeroCost(), total: 0.013 } }),
      user('q3'),
      assistant({ input: 1500, output: 80, cost: { ...zeroCost(), total: 0.016 } }),
    ];
    const totals = sumSessionUsage(messages);
    expect(totals.input).toBe(3700); // 1000 + 1200 + 1500 (cumulative-per-turn, billed)
    expect(totals.output).toBe(330);
    expect(totals.cost).toBeCloseTo(0.039, 10);
  });

  it('ignores user and toolResult messages', () => {
    const messages = [
      user(),
      { role: 'toolResult', toolCallId: 't', toolName: 'bash', content: [], isError: false, timestamp: 2 } as unknown as AgentMessage,
      assistant({ input: 500, output: 50, cost: { ...zeroCost(), total: 0.005 } }),
    ];
    const totals = sumSessionUsage(messages);
    expect(totals.input).toBe(500);
    expect(totals.cost).toBeCloseTo(0.005, 10);
  });

  it('skips assistant messages with no usage block', () => {
    const messages = [assistant(undefined), assistant({ input: 10, output: 5, cost: { ...zeroCost(), total: 0.001 } })];
    const totals = sumSessionUsage(messages);
    expect(totals.input).toBe(10);
    expect(totals.cost).toBeCloseTo(0.001, 10);
  });

  it('tolerates partial usage fields (missing output / cost)', () => {
    const messages = [
      assistant({ input: 100 } as Partial<Usage>),
      assistant({ input: 200, output: 20 } as Partial<Usage>),
    ];
    const totals = sumSessionUsage(messages);
    expect(totals.input).toBe(300);
    expect(totals.output).toBe(20);
    expect(totals.cost).toBe(0);
  });

  it('sums cache tokens too', () => {
    const messages = [
      assistant({ input: 100, output: 10, cacheRead: 40, cacheWrite: 12, cost: { ...zeroCost(), total: 0.002 } }),
      assistant({ input: 200, output: 20, cacheRead: 60, cacheWrite: 0, cost: { ...zeroCost(), total: 0.004 } }),
    ];
    const totals = sumSessionUsage(messages);
    expect(totals.cacheRead).toBe(100);
    expect(totals.cacheWrite).toBe(12);
  });

  it('counts tokens but zero cost for an unpriced provider (ollama/nvidia/unknown OpenRouter id)', () => {
    // calculateCost with a zero-rate model yields cost 0 — tokens still accrue.
    const messages = [
      assistant({ input: 5000, output: 800, cost: zeroCost() }),
      assistant({ input: 5200, output: 600, cost: zeroCost() }),
    ];
    const totals = sumSessionUsage(messages);
    expect(totals.input).toBe(10200);
    expect(totals.output).toBe(1400);
    expect(totals.cost).toBe(0); // hidden in the footer (only shown when > 0)
  });
});

describe('end-to-end: calculateCost → session totals (issue #55)', () => {
  it('matches the sum of per-turn costs computed from real registry rates', () => {
    const model = getModel('anthropic', 'claude-sonnet-4-6');
    expect(model, 'registry model present').toBeTruthy();
    // model.cost is USD per million: input 3, output 15 (verified against the registry).
    const turns = [
      { input: 1000, output: 500 },
      { input: 4000, output: 200 },
      { input: 9000, output: 50 },
    ];
    let expectedCost = 0;
    const messages: AgentMessage[] = [];
    for (const t of turns) {
      const usage = {
        input: t.input,
        output: t.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: t.input + t.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      calculateCost(model!, usage); // populate usage.cost from model rates
      expectedCost += usage.cost.total;
      messages.push(user(), assistant(usage));
    }
    const totals = sumSessionUsage(messages);
    expect(totals.input).toBe(14000);
    expect(totals.output).toBe(750);
    // Independently computed: (14000/1e6)*3 + (750/1e6)*15 = 0.042 + 0.01125.
    expect(totals.cost).toBeCloseTo(0.04 + 0.002 + 0.01125, 9);
    expect(totals.cost).toBeCloseTo(expectedCost, 12);
    expect(totals.cost).toBeGreaterThan(0); // cost is non-zero for a priced model
  });
});
