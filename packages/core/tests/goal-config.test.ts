import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadGoalConfig, resolveGoalModels, saveGoalConfig } from '../src/goal-config.js';
import { parseGoalVerdict } from '../src/goal-runner.js';

describe('goal config persistence', () => {
  let dir: string;
  const originalAgentDir = process.env.HARNEXT_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnext-goal-'));
    process.env.HARNEXT_AGENT_DIR = dir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.HARNEXT_AGENT_DIR;
    else process.env.HARNEXT_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty config when nothing is saved', () => {
    expect(loadGoalConfig()).toEqual({});
  });

  it('round-trips per-phase overrides', () => {
    saveGoalConfig({
      generator: { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' },
    });
    expect(loadGoalConfig()).toEqual({
      generator: { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' },
    });
  });
});

describe('resolveGoalModels', () => {
  it('defaults anthropic to the opus family for planner/evaluator and haiku for generator', () => {
    const resolved = resolveGoalModels('anthropic', 'claude-sonnet-4-6', {});
    expect(resolved.planner.provider).toBe('anthropic');
    expect(resolved.planner.modelId).toContain('opus');
    expect(resolved.evaluator.modelId).toContain('opus');
    expect(resolved.generator.modelId).toContain('haiku');
    expect(resolved.defaulted).toEqual(['planner', 'generator', 'evaluator']);
  });

  it('defaults openrouter to deepseek v4 pro/flash', () => {
    const resolved = resolveGoalModels('openrouter', 'anthropic/claude-sonnet-4.6', {});
    expect(resolved.planner.modelId).toBe('deepseek/deepseek-v4-pro');
    expect(resolved.evaluator.modelId).toBe('deepseek/deepseek-v4-pro');
    expect(resolved.generator.modelId).toBe('deepseek/deepseek-v4-flash');
  });

  it('falls back to the active model for providers without a known pairing', () => {
    const resolved = resolveGoalModels('groq', 'llama-3.3-70b-versatile', {});
    expect(resolved.planner).toEqual({ provider: 'groq', modelId: 'llama-3.3-70b-versatile' });
    expect(resolved.generator).toEqual({ provider: 'groq', modelId: 'llama-3.3-70b-versatile' });
  });

  it('prefers explicit config over provider defaults, per phase', () => {
    const resolved = resolveGoalModels('anthropic', 'claude-sonnet-4-6', {
      generator: { provider: 'groq', modelId: 'llama-3.3-70b-versatile' },
    });
    expect(resolved.generator).toEqual({ provider: 'groq', modelId: 'llama-3.3-70b-versatile' });
    expect(resolved.planner.modelId).toContain('opus');
    expect(resolved.defaulted).toEqual(['planner', 'evaluator']);
  });
});

describe('parseGoalVerdict', () => {
  it('parses approve and revise verdicts', () => {
    expect(parseGoalVerdict('Looks great.\nVERDICT: APPROVE')).toBe('approve');
    expect(parseGoalVerdict('1. Fix X\nVERDICT: REVISE')).toBe('revise');
  });

  it('uses the last verdict when the critique quotes an earlier one', () => {
    expect(
      parseGoalVerdict('You said "VERDICT: APPROVE" but edge cases fail.\nVERDICT: REVISE'),
    ).toBe('revise');
  });

  it('returns undefined when no verdict is present', () => {
    expect(parseGoalVerdict('No verdict here.')).toBeUndefined();
  });
});
